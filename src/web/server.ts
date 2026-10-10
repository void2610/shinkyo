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
import { appContext } from "../../app/context.ts";
import type { Workplace } from "../commute/workplace.ts";
import type { ImageStore } from "../fetch/images.ts";
import type { Clock } from "../time.ts";
import type { Identify } from "./identity.ts";
import { getImageUrl } from "./queries.ts";

export type WebOptions = {
	db: Database;
	clock: Clock;
	images: ImageStore;
	identify: Identify;
	people: Record<string, string>;
	workplaces: Workplace[];
	allowedOrigins: string[];
	build: ServerBuild;
};

export const BUILD_DIR = fileURLToPath(new URL("../../build", import.meta.url));

export const loadBuild = async (): Promise<ServerBuild> =>
	(await import(`${BUILD_DIR}/server/index.js`)) as ServerBuild;

// Tunnel 経由の URL は http://127.0.0.1 で Origin と食い違い React Router が action を止めるので、許可済みの公開 URL に直す
function asPublicRequest(request: Request, allowedOrigins: string[]): Request {
	const origin = request.headers.get("origin");
	if (!origin || !allowedOrigins.includes(origin)) return request;
	const url = new URL(request.url);
	return new Request(new URL(`${url.pathname}${url.search}`, origin), request);
}

// 人によって権限は変えない。誰が操作したかを記録するためだけに人を見分ける
export function createServer(options: WebOptions) {
	const { db, clock } = options;
	const app = new Hono<{ Variables: { person: string } }>();
	const handle = createRequestHandler(options.build, "production");

	app.use(secureHeaders());
	app.use(async (c, next) => {
		const person = await options.identify(c.req.raw);
		if (person === null)
			return c.text("Cloudflare Access の認証を確認できません", 401);
		c.set("person", person);
		await next();
	});
	// ブラウザは他サイトからのリクエストにも Access のクッキーを付けるので、Origin で CSRF を防ぐ
	app.use(
		csrf({
			origin: (origin, c) =>
				origin === new URL(c.req.url).origin ||
				options.allowedOrigins.includes(origin),
		}),
	);

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
		context.set(appContext, {
			db,
			clock,
			person: c.get("person"),
			people: options.people,
			workplaces: options.workplaces,
		});
		return handle(asPublicRequest(c.req.raw, options.allowedOrigins), context);
	});

	return app;
}
