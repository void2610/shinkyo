import type { Database } from "bun:sqlite";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import {
	createRequestHandler,
	RouterContextProvider,
	type ServerBuild,
} from "react-router";
import { appContext, type Role } from "../../app/context.ts";
import type { ImageStore } from "../fetch/images.ts";
import type { Clock } from "../time.ts";
import { getImageUrl } from "./queries.ts";

export type WebOptions = {
	db: Database;
	clock: Clock;
	images: ImageStore;
	ownerLogins: string[];
	allowedOrigins: string[];
	// 開発時に tailscale serve を通さず操作するためのフラグ
	devOwner: boolean;
	build: ServerBuild;
};

export const BUILD_DIR = fileURLToPath(new URL("../../build", import.meta.url));

export const loadBuild = async (): Promise<ServerBuild> =>
	(await import(`${BUILD_DIR}/server/index.js`)) as ServerBuild;

// tailscale serve 経由だと URL は 127.0.0.1 のまま届き、React Router が Origin との不一致で action を止める。
// CSRF の検証で許可した公開 URL から来たものだけ、URL を公開側に直して渡す
function asPublicRequest(request: Request, allowedOrigins: string[]): Request {
	const origin = request.headers.get("origin");
	if (!origin || !allowedOrigins.includes(origin)) return request;
	const url = new URL(request.url);
	return new Request(new URL(`${url.pathname}${url.search}`, origin), request);
}

export function createServer(options: WebOptions) {
	const { db, clock } = options;
	const app = new Hono<{ Variables: { role: Role } }>();
	const handle = createRequestHandler(options.build, "production");

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

	// ビルド済みの JS・CSS はファイル名にハッシュが付くので長くキャッシュさせる
	const clientRoot = relative(process.cwd(), `${BUILD_DIR}/client`);
	app.use(
		"/assets/*",
		serveStatic({
			root: clientRoot,
			onFound: (_path, c) =>
				c.header("cache-control", "public, max-age=31536000, immutable"),
		}),
	);

	app.all("*", (c) => {
		const context = new RouterContextProvider();
		context.set(appContext, { db, clock, role: c.get("role") });
		return handle(asPublicRequest(c.req.raw, options.allowedOrigins), context);
	});

	return app;
}
