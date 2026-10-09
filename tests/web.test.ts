import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseListPage } from "../src/fetch/parse.ts";
import { upsertListing } from "../src/store/listings.ts";
import { createApp } from "../src/web/app.tsx";
import { FakeClock, fixture, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const OWNER = "owner@example.com";
const page = parseListPage(await fixture("list_p1.html"));

let db: Database;
let app: ReturnType<typeof createApp>;
let key: string;

beforeEach(() => {
	db = memoryDb();
	const at = MONDAY_10_JST.toISOString();
	for (const room of page.rooms) upsertListing(db, room, "test", at);
	key =
		db
			.query<{ unit_key: string }, []>(
				"SELECT unit_key FROM listings WHERE listing_id = '900000000001'",
			)
			.get()?.unit_key ?? "";
	app = createApp({
		db,
		clock: new FakeClock(MONDAY_10_JST).read,
		ownerLogins: [OWNER],
		allowedOrigins: ["https://m1.example.ts.net"],
		devOwner: false,
	});
});

const unitPath = () => `/units/${encodeURIComponent(key)}`;

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
		const html = await (await app.request("/")).text();
		expect(html).toContain("閲覧専用");
		expect(html).toContain("テストハイツ桜A/テストハイツ桜B");
		expect(html).not.toContain("hx-post");
	});

	test("本人以外のログインからの書き込みは 403", async () => {
		const res = await post(
			`${unitPath()}/judgment`,
			{ judgment: "◎" },
			{ "tailscale-user-login": "guest@example.com" },
		);
		expect(res.status).toBe(403);
		expect(unit()?.judgment).toBeNull();
	});

	test("本人には判定ボタンを出す", async () => {
		const html = await (
			await app.request("/", { headers: { "tailscale-user-login": OWNER } })
		).text();
		expect(html).not.toContain("閲覧専用");
		expect(html).toContain("hx-post");
	});
});

describe("判定", () => {
	test("本人が判定を付けると保存され、人の操作として履歴に残る", async () => {
		const res = await post(`${unitPath()}/judgment`, { judgment: "◎" });
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
		await post(`${unitPath()}/judgment`, { judgment: "○" });
		await post(`${unitPath()}/judgment`, { judgment: "" });
		expect(unit()?.judgment).toBeNull();
	});

	test("決められた記号以外は 400", async () => {
		expect(
			(await post(`${unitPath()}/judgment`, { judgment: "△" })).status,
		).toBe(400);
	});

	test("他サイトからの POST は本人のヘッダーが付いていても拒否する", async () => {
		const res = await post(
			`${unitPath()}/judgment`,
			{ judgment: "◎" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		expect(unit()?.judgment).toBeNull();
	});

	test("tailscale serve の公開 URL からの POST は受け付ける", async () => {
		const res = await post(
			`${unitPath()}/judgment`,
			{ judgment: "◎" },
			{ origin: "https://m1.example.ts.net" },
		);
		expect(res.status).toBe(200);
	});
});

describe("申込の承認とメモ", () => {
	test("内見済でない部屋の申込は承認できない", async () => {
		expect((await post(`${unitPath()}/approve`, {})).status).toBe(409);
		expect(unit()?.apply_approved).toBe(0);
	});

	test("内見済の部屋は承認できる", async () => {
		db.query("UPDATE units SET status = '内見済' WHERE unit_key = ?").run(key);
		expect(
			(await post(`${unitPath()}/approve`, {}, { "hx-request": "true" }))
				.status,
		).toBe(200);
		expect(unit()?.apply_approved).toBe(1);
	});

	test("メモを保存できる", async () => {
		const res = await post(
			`${unitPath()}/memo`,
			{ memo: "日当たり良好" },
			{ "hx-request": "true" },
		);
		expect(await res.text()).toContain("保存しました");
		expect(unit()?.memo).toBe("日当たり良好");
	});
});

describe("画面", () => {
	test("詳細ページに同じ部屋の掲載が並ぶ", async () => {
		const res = await app.request(unitPath());
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("掲載 (2)");
	});

	test("存在しない部屋は 404", async () => {
		expect((await app.request("/units/none")).status).toBe(404);
	});

	test("状態で絞り込める", async () => {
		const html = await (await app.request("/?status=見送り")).text();
		expect(html).toContain("該当する部屋はありません");
	});

	test("htmx を自前で配信する", async () => {
		const res = await app.request("/static/htmx.min.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});
});
