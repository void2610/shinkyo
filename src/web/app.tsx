import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
	judgments,
	type UnitFlag,
	unitFlags,
	unitStatuses,
} from "../domain.ts";
import type { ImageStore } from "../fetch/images.ts";
import type { Clock } from "../time.ts";
import {
	approveApplication,
	countByStatus,
	filterOptions,
	getEvents,
	getImageUrl,
	getListings,
	getUnit,
	listUnits,
	setJudgment,
	setMemo,
	sortKeys,
	type UnitFilter,
} from "./queries.ts";
import {
	ApproveControl,
	JudgmentControl,
	MemoSaved,
	NotFoundPage,
	type Role,
	UnitDetailPage,
	UnitListPage,
} from "./views.tsx";

export type WebOptions = {
	db: Database;
	clock: Clock;
	images: ImageStore;
	ownerLogins: string[];
	allowedOrigins: string[];
	// 開発時に tailscale serve を通さず操作するためのフラグ
	devOwner: boolean;
};

const positive = z.coerce.number().positive().nullable().catch(null);
const flagSet = new Set<string>(unitFlags);

// 空欄や不正な値は「指定なし」として扱い、エラーにしない
export function parseFilter(query: URLSearchParams): UnitFilter {
	const one = (name: string) => query.get(name) || null;
	const tags = query.getAll("tag").filter((t) => flagSet.has(t.slice(1)));
	const maxRentMan = positive.parse(one("max_rent"));
	return {
		status: z
			.enum(["active", "all", ...unitStatuses])
			.catch("active")
			.parse(one("status")),
		judgment: z
			.enum(["all", "none", ...judgments])
			.catch("all")
			.parse(one("judgment")),
		sort: z
			.enum(Object.keys(sortKeys) as [keyof typeof sortKeys])
			.catch("new")
			.parse(one("sort")),
		maxRent: maxRentMan === null ? null : Math.round(maxRentMan * 10000),
		minArea: positive.parse(one("min_area")),
		maxWalk: positive.parse(one("max_walk")),
		maxAge: positive.parse(one("max_age")),
		layouts: query.getAll("layout").filter(Boolean),
		station: one("station"),
		withFlags: tags
			.filter((t) => t.startsWith("+"))
			.map((t) => t.slice(1) as UnitFlag),
		withoutFlags: tags
			.filter((t) => t.startsWith("-"))
			.map((t) => t.slice(1) as UnitFlag),
	};
}

const judgmentForm = z.object({
	judgment: z.union([z.enum(judgments), z.literal("").transform(() => null)]),
});
const memoForm = z.object({ memo: z.string().max(10_000) });

const staticFiles = {
	"/static/bootstrap.min.css": {
		url: import.meta.resolve("bootstrap/dist/css/bootstrap.min.css"),
		type: "text/css",
	},
	"/static/bootstrap.bundle.min.js": {
		url: import.meta.resolve("bootstrap/dist/js/bootstrap.bundle.min.js"),
		type: "text/javascript",
	},
	"/static/htmx.min.js": {
		url: import.meta.resolve("htmx.org/dist/htmx.min.js"),
		type: "text/javascript",
	},
	"/static/style.css": {
		url: new URL("./style.css", import.meta.url).href,
		type: "text/css",
	},
} as const;

export function createApp(options: WebOptions) {
	const { db, clock } = options;
	const app = new Hono<{ Variables: { role: Role } }>();

	app.use(secureHeaders());
	// 閲覧者は tailscale serve が付ける利用者ヘッダーで見分ける。ヘッダーが無ければ閲覧専用に倒す
	app.use(async (c, next) => {
		const login = c.req.header("Tailscale-User-Login");
		const isOwner =
			options.devOwner ||
			(login !== undefined && options.ownerLogins.includes(login));
		c.set("role", isOwner ? "owner" : "viewer");
		await next();
	});
	// tailscale serve は他サイトからのリクエストにも利用者ヘッダーを付けるので、Origin で CSRF を防ぐ
	app.use(
		csrf({
			origin: (origin, c) =>
				origin === new URL(c.req.url).origin ||
				options.allowedOrigins.includes(origin),
		}),
	);
	app.on(["POST", "PUT", "PATCH", "DELETE"], "*", async (c, next) => {
		if (c.get("role") !== "owner") return c.text("閲覧専用です", 403);
		await next();
	});

	for (const [path, file] of Object.entries(staticFiles)) {
		app.get(path, (c) => {
			c.header("content-type", file.type);
			c.header("cache-control", "public, max-age=31536000, immutable");
			return c.body(Bun.file(new URL(file.url)).stream());
		});
	}

	app.get("/images/:listingId/:index{[0-9]+}", async (c) => {
		const url = getImageUrl(
			db,
			c.req.param("listingId"),
			Number(c.req.param("index")),
		);
		if (!url) return c.notFound();
		let image: Awaited<ReturnType<ImageStore["get"]>>;
		try {
			image = await options.images.get(url);
		} catch {
			// 取得の上限や停止中は画像なしで画面を出す
			image = null;
		}
		if (!image) return c.body(null, 404);
		c.header("content-type", image.contentType);
		c.header("cache-control", "private, max-age=604800, immutable");
		return c.body(Bun.file(image.path).stream());
	});

	app.get("/", (c) => {
		const filter = parseFilter(new URL(c.req.url).searchParams);
		return c.html(
			<UnitListPage
				units={listUnits(db, filter, clock().getFullYear())}
				options={filterOptions(db)}
				filter={filter}
				counts={countByStatus(db)}
				access={c.get("role")}
			/>,
		);
	});

	app.get("/units/:key", (c) => {
		const key = c.req.param("key");
		const unit = getUnit(db, key);
		if (!unit) return c.html(<NotFoundPage access={c.get("role")} />, 404);
		return c.html(
			<UnitDetailPage
				unit={unit}
				listings={getListings(db, key)}
				events={getEvents(db, key)}
				access={c.get("role")}
			/>,
		);
	});

	app.post("/units/:key/judgment", async (c) => {
		const key = c.req.param("key");
		const form = judgmentForm.safeParse(await c.req.parseBody());
		if (!form.success) return c.text("判定の値が不正です", 400);
		if (!setJudgment(db, key, form.data.judgment, clock().toISOString()))
			return c.text("部屋が見つかりません", 404);
		return c.html(
			<JudgmentControl
				unitKey={key}
				judgment={form.data.judgment}
				access="owner"
			/>,
		);
	});

	app.post("/units/:key/memo", async (c) => {
		const key = c.req.param("key");
		const form = memoForm.safeParse(await c.req.parseBody());
		if (!form.success) return c.text("メモが長すぎます", 400);
		const at = clock().toISOString();
		if (!setMemo(db, key, form.data.memo, at))
			return c.text("部屋が見つかりません", 404);
		if (c.req.header("HX-Request")) return c.html(<MemoSaved at={at} />);
		return c.redirect(`/units/${encodeURIComponent(key)}`, 303);
	});

	app.post("/units/:key/approve", (c) => {
		const key = c.req.param("key");
		const result = approveApplication(db, key, clock().toISOString());
		if (result === "not_found") return c.text("部屋が見つかりません", 404);
		if (result === "invalid_status")
			return c.text("申込を承認できるのは内見済の部屋だけです", 409);
		const unit = getUnit(db, key);
		if (!unit) return c.text("部屋が見つかりません", 404);
		if (c.req.header("HX-Request"))
			return c.html(<ApproveControl unit={unit} access="owner" />);
		return c.redirect(`/units/${encodeURIComponent(key)}`, 303);
	});

	return app;
}
