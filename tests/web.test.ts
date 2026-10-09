import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseDetailPage, parseListPage } from "../src/fetch/parse.ts";
import { applyDetail, upsertListing } from "../src/store/listings.ts";
import type { Identify } from "../src/web/identity.ts";
import { createServer, loadBuild } from "../src/web/server.ts";
import { FakeClock, fixture, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const A = "a@example.com";
const B = "b@example.com";
const page = parseListPage(await fixture("list_p1.html"));
const detail = parseDetailPage(await fixture("detail.html"));
const imageFile = `${import.meta.dir}/fixtures/suumo/detail.html`;
// 画面は react-router build の成果物を読む (bun run test が先にビルドする)
const build = await loadBuild();
const requested: string[] = [];

// Access の検証は identity.test.ts で確かめるので、ここではヘッダーで人を渡す
const testIdentity: Identify = async (request) =>
	request.headers.get("x-test-person");

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
		identify: testIdentity,
		people: { [A]: "あおい", [B]: "ひかる" },
		allowedOrigins: ["https://heya.example.com"],
		build,
	});
});

const unitPath = () => `/units/${encodeURIComponent(key)}`;

// React は隣り合う文字列の間に <!-- --> を挟むので、本文を比べるときは取り除く
const text = async (res: Response) =>
	(await res.text()).replaceAll("<!-- -->", "");
const get = (path: string, person: string | null = A) =>
	app.request(path, { headers: person ? { "x-test-person": person } : {} });

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
			"x-test-person": A,
			...headers,
		},
		body: new URLSearchParams(body),
	});

const evaluation = (person: string) =>
	db
		.query<{ judgment: string | null; memo: string | null }, [string, string]>(
			"SELECT judgment, memo FROM evaluations WHERE unit_key = ? AND person = ?",
		)
		.get(key, person);

describe("入口", () => {
	test("誰か分からないリクエストは画面も写真も 401", async () => {
		expect((await get("/", null)).status).toBe(401);
		expect((await get("/images/900000000002/1", null)).status).toBe(401);
	});

	test("ヘッダーに操作している人の名前を出す", async () => {
		expect(await text(await get("/", B))).toContain("ひかる");
	});
});

describe("人ごとの判定とメモ", () => {
	test("誰でも判定でき、人ごとに保存され、誰の操作かが履歴に残る", async () => {
		expect(
			(await post(unitPath(), { intent: "judgment", judgment: "◎" })).status,
		).toBe(200);
		expect(
			(
				await post(
					unitPath(),
					{ intent: "judgment", judgment: "×" },
					{ "x-test-person": B },
				)
			).status,
		).toBe(200);
		expect(evaluation(A)?.judgment).toBe("◎");
		expect(evaluation(B)?.judgment).toBe("×");
		const details = db
			.query<{ detail: string }, [string]>(
				"SELECT detail FROM events WHERE unit_key = ? AND type = 'judgment' ORDER BY id",
			)
			.all(key)
			.map((e) => JSON.parse(e.detail));
		expect(details).toEqual([
			{ person: A, from: null, to: "◎" },
			{ person: B, from: null, to: "×" },
		]);
	});

	test("一覧と詳細に、自分以外の人の判定とメモを名前付きで出す", async () => {
		await post(
			unitPath(),
			{ intent: "judgment", judgment: "×" },
			{ "x-test-person": B },
		);
		await post(
			unitPath(),
			{ intent: "memo", memo: "駅から坂がきつい" },
			{ "x-test-person": B },
		);
		expect(await text(await get("/"))).toContain("ひかる ×");
		const detailHtml = await text(await get(unitPath()));
		expect(detailHtml).toContain("駅から坂がきつい");
		expect(detailHtml).toContain("ひかる");
	});

	test("空の値で自分の判定を外せる", async () => {
		await post(unitPath(), { intent: "judgment", judgment: "○" });
		await post(unitPath(), { intent: "judgment", judgment: "" });
		expect(evaluation(A)?.judgment).toBeNull();
	});

	test("決められた記号以外は 400", async () => {
		expect(
			(await post(unitPath(), { intent: "judgment", judgment: "△" })).status,
		).toBe(400);
	});

	test("メモを書き換えると、前の内容を履歴に残す", async () => {
		await post(unitPath(), { intent: "memo", memo: "日当たり良好" });
		await post(unitPath(), {
			intent: "memo",
			memo: "日当たり良好、ただし狭い",
		});
		expect(evaluation(A)?.memo).toBe("日当たり良好、ただし狭い");
		const last = db
			.query<{ detail: string }, [string]>(
				"SELECT detail FROM events WHERE unit_key = ? AND type = 'memo' ORDER BY id DESC",
			)
			.get(key);
		expect(JSON.parse(last?.detail ?? "{}")).toEqual({
			person: A,
			before: "日当たり良好",
		});
	});
});

describe("CSRF", () => {
	test("他サイトからの POST は拒否する", async () => {
		const res = await post(
			unitPath(),
			{ intent: "judgment", judgment: "◎" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		expect(evaluation(A)).toBeNull();
	});

	test("Cloudflare Tunnel の公開 URL からの POST は受け付ける", async () => {
		const res = await post(
			unitPath(),
			{ intent: "judgment", judgment: "◎" },
			{ origin: "https://heya.example.com" },
		);
		expect(res.status).toBe(200);
		expect(evaluation(A)?.judgment).toBe("◎");
	});
});

describe("申込の承認", () => {
	test("内見済でない部屋は承認できない", async () => {
		expect((await post(unitPath(), { intent: "approve" })).status).toBe(409);
	});

	test("内見済の部屋は誰でも承認でき、誰が承認したかを残す", async () => {
		db.query("UPDATE units SET status = '内見済' WHERE unit_key = ?").run(key);
		expect(
			(await post(unitPath(), { intent: "approve" }, { "x-test-person": B }))
				.status,
		).toBe(200);
		const event = db
			.query<{ detail: string }, [string]>(
				"SELECT detail FROM events WHERE unit_key = ? AND type = 'apply_approved'",
			)
			.get(key);
		expect(JSON.parse(event?.detail ?? "{}")).toEqual({ person: B });
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
		const plan = html.slice(
			html.indexOf(">間取り図<"),
			html.indexOf("室内・設備 ("),
		);
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
		expect(html).not.toMatch(/<a [^>]*href="\/images\//);
	});

	test("見出しのすぐ下に家賃を大きく出す", async () => {
		const html = await text(await get(unitPath()));
		expect(html).toMatch(/data-testid="rent">12\.5万円</);
		expect(html.indexOf('data-testid="rent"')).toBeLessThan(
			html.indexOf(">間取り図<"),
		);
	});

	test("写真を返し、掲載に無い番号は 404", async () => {
		const res = await get("/images/900000000002/1");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(requested).toEqual([detail.images[1]?.url ?? ""]);
		expect((await get("/images/900000000002/9")).status).toBe(404);
	});
});
