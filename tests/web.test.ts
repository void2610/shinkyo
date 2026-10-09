import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseDetailPage, parseListPage } from "../src/fetch/parse.ts";
import { applyDetail, upsertListing } from "../src/store/listings.ts";
import { createServer, loadBuild } from "../src/web/server.ts";
import { FakeClock, fixture, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const OWNER = "owner@example.com";
const page = parseListPage(await fixture("list_p1.html"));
const detail = parseDetailPage(await fixture("detail.html"));
const imageFile = `${import.meta.dir}/fixtures/suumo/detail.html`;
// 画面は react-router build の成果物を読む (bun run test が先にビルドする)
const build = await loadBuild();
const requested: string[] = [];

let db: Database;
let app: ReturnType<typeof createServer>;
let key: string;

beforeEach(() => {
	db = memoryDb();
	const at = MONDAY_10_JST.toISOString();
	for (const room of page.rooms) upsertListing(db, room, "test", at);
	applyDetail(db, "900000000002", detail, "", at);
	requested.length = 0;
	key =
		db
			.query<{ unit_key: string }, []>(
				"SELECT unit_key FROM listings WHERE listing_id = '900000000001'",
			)
			.get()?.unit_key ?? "";
	app = createServer({
		db,
		clock: new FakeClock(MONDAY_10_JST).read,
		images: {
			get: async (url: string) => {
				requested.push(url);
				return { path: imageFile, contentType: "image/jpeg" };
			},
		},
		ownerLogins: [OWNER],
		allowedOrigins: ["https://m1.example.ts.net"],
		devOwner: false,
		build,
	});
});

const unitPath = () => `/units/${encodeURIComponent(key)}`;

// React は隣り合う文字列の間に <!-- --> を挟むので、本文を比べるときは取り除く
const text = async (res: Response) =>
	(await res.text()).replaceAll("<!-- -->", "");
const get = (path: string, login?: string) =>
	app.request(path, {
		headers: login ? { "tailscale-user-login": login } : {},
	});

const post = (
	path: string,
	body: Record<string, string>,
	headers: Record<string, string> = {},
) =>
	app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: "http://localhost",
			"tailscale-user-login": OWNER,
			...headers,
		},
		body: new URLSearchParams(body),
	});

const unit = () =>
	db
		.query<
			{ judgment: string | null; memo: string | null; apply_approved: number },
			[string]
		>("SELECT judgment, memo, apply_approved FROM units WHERE unit_key = ?")
		.get(key);

describe("閲覧専用の共有", () => {
	test("利用者ヘッダーが無い閲覧者には判定ボタンを出さない", async () => {
		const html = await text(await get("/"));
		expect(html).toContain("閲覧専用");
		expect(html).toContain("テストハイツ桜A/テストハイツ桜B");
		expect(html).not.toContain('aria-label="判定"');
	});

	test("本人以外のログインからの書き込みは 403", async () => {
		const res = await post(
			unitPath(),
			{ intent: "judgment", judgment: "◎" },
			{ "tailscale-user-login": "guest@example.com" },
		);
		expect(res.status).toBe(403);
		expect(unit()?.judgment).toBeNull();
	});

	test("本人には判定ボタンを出す", async () => {
		const html = await text(await get("/", OWNER));
		expect(html).not.toContain("閲覧専用");
		expect(html).toContain('aria-label="判定"');
	});
});

describe("判定", () => {
	test("本人が判定を付けると保存され、人の操作として履歴に残る", async () => {
		const res = await post(unitPath(), { intent: "judgment", judgment: "◎" });
		expect(res.status).toBe(200);
		expect(unit()?.judgment).toBe("◎");
		const event = db
			.query<{ actor: string; detail: string }, [string]>(
				"SELECT actor, detail FROM events WHERE unit_key = ? AND type = 'judgment'",
			)
			.get(key);
		expect(event?.actor).toBe("human");
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({ from: null, to: "◎" });
	});

	test("空の値で判定を外せる", async () => {
		await post(unitPath(), { intent: "judgment", judgment: "○" });
		await post(unitPath(), { intent: "judgment", judgment: "" });
		expect(unit()?.judgment).toBeNull();
	});

	test("決められた記号以外は 400", async () => {
		expect(
			(await post(unitPath(), { intent: "judgment", judgment: "△" })).status,
		).toBe(400);
	});

	test("他サイトからの POST は本人のヘッダーが付いていても拒否する", async () => {
		const res = await post(
			unitPath(),
			{ intent: "judgment", judgment: "◎" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		expect(unit()?.judgment).toBeNull();
	});

	test("tailscale serve の公開 URL からの POST は受け付ける", async () => {
		const res = await post(
			unitPath(),
			{ intent: "judgment", judgment: "◎" },
			{ origin: "https://m1.example.ts.net" },
		);
		expect(res.status).toBe(200);
		expect(unit()?.judgment).toBe("◎");
	});
});

describe("申込の承認とメモ", () => {
	test("内見済でない部屋の申込は承認できない", async () => {
		expect((await post(unitPath(), { intent: "approve" })).status).toBe(409);
		expect(unit()?.apply_approved).toBe(0);
	});

	test("内見済の部屋は承認できる", async () => {
		db.query("UPDATE units SET status = '内見済' WHERE unit_key = ?").run(key);
		expect((await post(unitPath(), { intent: "approve" })).status).toBe(200);
		expect(unit()?.apply_approved).toBe(1);
	});

	test("メモを保存できる", async () => {
		await post(unitPath(), { intent: "memo", memo: "日当たり良好" });
		expect(unit()?.memo).toBe("日当たり良好");
	});
});

describe("画面", () => {
	test("詳細ページに同じ部屋の掲載が並ぶ", async () => {
		const res = await get(unitPath());
		expect(res.status).toBe(200);
		expect(await text(res)).toContain("掲載 (2)");
	});

	test("存在しない部屋は 404", async () => {
		expect((await get("/units/none")).status).toBe(404);
	});

	test("状態で絞り込める", async () => {
		expect(await text(await get("/?status=見送り"))).toContain(
			"該当する部屋はありません",
		);
	});

	test("一覧のカードに代表の掲載の1枚目を出す", async () => {
		expect(await text(await get("/"))).toContain(
			'src="/images/900000000001/0"',
		);
	});

	test("間取り図は写真とは別の枠に、切り取らずに常に出す", async () => {
		const html = await text(await get(unitPath()));
		const plan = html.slice(html.indexOf(">間取り図<"), html.indexOf(">概要<"));
		expect(plan).toContain('src="/images/900000000002/1"');
		expect(plan).toContain("object-contain");
		const grid = html.slice(html.indexOf("室内・設備 ("));
		expect(grid).toContain("室内・設備 (1)");
		expect(grid).toContain("建物・共用部 (1)");
		expect(grid).not.toContain('src="/images/900000000002/1"');
	});

	test("写真は同じページで拡大する (別ページへのリンクにしない)", async () => {
		const html = await text(await get(unitPath()));
		expect(html).toContain('aria-label="間取り図を拡大"');
		expect(html).toContain('aria-label="居室・リビングを拡大"');
		expect(html).not.toMatch(/<a [^>]*href="\/images\//);
	});

	test("見出しのすぐ下に家賃を大きく出す", async () => {
		const html = await text(await get(unitPath()));
		expect(html).toMatch(/data-testid="rent">12\.5万円</);
		expect(html.indexOf('data-testid="rent"')).toBeLessThan(
			html.indexOf(">間取り図<"),
		);
	});

	test("画像は閲覧者にも返し、掲載に無い番号は 404", async () => {
		const res = await get("/images/900000000002/1");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(requested).toEqual([detail.images[1]?.url ?? ""]);
		expect((await get("/images/900000000002/9")).status).toBe(404);
	});
});
