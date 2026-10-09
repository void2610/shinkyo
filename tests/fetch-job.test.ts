import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { noopRawStore } from "../src/fetch/raw.ts";
import { HttpClient } from "../src/fetch/suumo.ts";
import { runFetch } from "../src/jobs/fetch.ts";
import type { Notification } from "../src/notify.ts";
import {
	FakeClock,
	fakeFetch,
	fixture,
	MONDAY_10_JST,
	memoryDb,
	type Route,
	repoConfig,
} from "./helpers.ts";

const SEARCH =
	"https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&sc=99999";
const PAGE2 = `${SEARCH}&page=2`;
const config = await repoConfig();
const [p1, p2, detail, broken, empty] = await Promise.all(
	[
		"list_p1.html",
		"list_p2.html",
		"detail.html",
		"list_broken.html",
		"list_empty.html",
	].map(fixture),
);
const details = Object.fromEntries(
	[101, 102, 103, 104].map((n) => [
		`https://suumo.jp/chintai/jnc_000000000${n}/?bc=900000000${String(n - 100).padStart(3, "0")}`,
		{ body: detail ?? "" },
	]),
);

function setup(
	routes: Record<string, Route | (() => Route)>,
	db: Database = memoryDb(),
	clock = new FakeClock(MONDAY_10_JST),
) {
	const notifications: Notification[] = [];
	const fetch = fakeFetch({
		"https://suumo.jp/robots.txt": { body: "User-agent: *\nDisallow: /mb/\n" },
		...details,
		...routes,
	});
	const run = (dryRun = false) =>
		runFetch({
			db,
			client: new HttpClient({
				db,
				policy: { ...config.policy.fetch, paused: false },
				runId: "test",
				clock: clock.read,
				sleep: async (ms) => clock.advance(ms),
				random: () => 0,
				fetchImpl: fetch.impl,
			}),
			searches: [{ id: "test", url: SEARCH }],
			policy: config.policy,
			notify: async (n) => {
				notifications.push(n);
			},
			raw: noopRawStore,
			clock: clock.read,
			dryRun,
			log: () => {},
		});
	return { db, clock, run, notifications, calls: fetch.calls };
}

const count = (db: Database, table: string): number =>
	db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ??
	0;

const flagsOf = (db: Database, listingId: string): string[] =>
	JSON.parse(
		db
			.query<{ flags: string }, [string]>(
				"SELECT u.flags FROM units u JOIN listings l ON l.unit_key = u.unit_key WHERE l.listing_id = ?",
			)
			.get(listingId)?.flags ?? "[]",
	);

describe("J1 取得", () => {
	test("全ページの掲載を登録し、同じ部屋の掲載は1つの部屋にまとめ、新規の詳細を取得する", async () => {
		const { db, run } = setup({
			[SEARCH]: { body: p1 ?? "" },
			[PAGE2]: { body: p2 ?? "" },
		});
		const summary = await run();
		expect(summary).toMatchObject({
			newListings: 4,
			details: 4,
			stopped: null,
		});
		expect(summary.newUnits).toHaveLength(3);
		expect(count(db, "units")).toBe(3);
		const keys = db
			.query<{ unit_key: string }, []>(
				"SELECT DISTINCT unit_key FROM listings WHERE listing_id IN ('900000000001', '900000000002')",
			)
			.all();
		expect(keys).toHaveLength(1);
		const listing = db
			.query<{ agent_name: string; built_ym: string }, []>(
				"SELECT agent_name, built_ym FROM listings WHERE listing_id = '900000000002'",
			)
			.get();
		expect(listing).toEqual({
			agent_name: "架空不動産(株)桜店",
			built_ym: "2014-03",
		});
	});

	test("二重に実行しても掲載・部屋・詳細の取得は重複しない", async () => {
		const { db, run, clock, calls } = setup({
			[SEARCH]: { body: p1 ?? "" },
			[PAGE2]: { body: p2 ?? "" },
		});
		await run();
		clock.advance(45 * 60_000);
		const second = await run();
		expect(second).toMatchObject({ newListings: 0, details: 0 });
		expect(count(db, "listings")).toBe(4);
		expect(count(db, "units")).toBe(3);
		expect(calls.filter((u) => u.includes("jnc_"))).toHaveLength(4);
	});

	test("家賃が下がったら値下げの旗を立てて通知する", async () => {
		let page1 = p1 ?? "";
		const { db, run, clock, notifications } = setup({
			[SEARCH]: () => ({ body: page1 }),
			[PAGE2]: { body: p2 ?? "" },
		});
		await run();
		page1 = page1.replace("12.5万円</span></span>", "12万円</span></span>");
		clock.advance(45 * 60_000);
		const summary = await run();
		expect(summary.priceDrops).toEqual([
			{ unitKey: expect.any(String), from: 133000, to: 128000 },
		]);
		expect(flagsOf(db, "900000000001")).toContain("値下げ");
		expect(notifications.map((n) => n.title)).toEqual(["値下げ 1 件"]);
	});

	test("一覧から2回続けて消えたら掲載終了の可能性の旗を立て、戻ったら外す", async () => {
		let page1 = p1 ?? "";
		const { db, run, clock } = setup({
			[SEARCH]: () => ({ body: page1 }),
			[PAGE2]: { body: p2 ?? "" },
		});
		await run();
		// 2ページ目の掲載が消えて1ページに収まった状態
		page1 = page1.replace(/<p class="pagination-parts">.*?<\/p>/, "");
		for (let i = 0; i < 2; i++) {
			clock.advance(45 * 60_000);
			await run();
		}
		expect(flagsOf(db, "900000000004")).toContain("掲載終了の可能性");
		page1 = p1 ?? "";
		clock.advance(45 * 60_000);
		await run();
		expect(flagsOf(db, "900000000004")).not.toContain("掲載終了の可能性");
	});

	test("同じ部屋の別の掲載が残っていれば掲載終了とはみなさない", async () => {
		let page1 = p1 ?? "";
		const { db, run, clock } = setup({
			[SEARCH]: () => ({ body: page1 }),
			[PAGE2]: { body: p2 ?? "" },
		});
		await run();
		page1 = page1.replace(
			/<tbody><tr class="js-cassette_link">(?:(?!<\/tbody>)[\s\S])*?900000000001[\s\S]*?<\/tbody>/,
			"",
		);
		for (let i = 0; i < 2; i++) {
			clock.advance(45 * 60_000);
			await run();
		}
		expect(flagsOf(db, "900000000001")).not.toContain("掲載終了の可能性");
	});

	test("200 なのに0件ならパーサー破損として通知し、何も登録しない", async () => {
		const { db, run, notifications } = setup({
			[SEARCH]: { body: broken ?? "" },
		});
		await run();
		expect(notifications[0]?.title).toContain("パーサー");
		expect(count(db, "listings")).toBe(0);
	});

	test("検索結果が本当に0件なら通知しない", async () => {
		const { run, notifications } = setup({ [SEARCH]: { body: empty ?? "" } });
		await run();
		expect(notifications).toEqual([]);
	});

	test("途中で 503 を受けたら、それまでの掲載だけ登録して止め、通知する", async () => {
		const { db, run, notifications } = setup({
			[SEARCH]: { body: p1 ?? "" },
			[PAGE2]: { status: 503, body: "" },
		});
		const summary = await run();
		expect(summary).toMatchObject({
			newListings: 3,
			details: 0,
			stopped: "blocked",
		});
		expect(count(db, "listings")).toBe(3);
		expect(notifications.map((n) => n.title)).toEqual(["SUUMO の取得を止めた"]);
	});

	test("dry-run では一覧を読むだけで登録しない", async () => {
		const { db, run, calls } = setup({
			[SEARCH]: { body: p1 ?? "" },
			[PAGE2]: { body: p2 ?? "" },
		});
		await run(true);
		expect(count(db, "listings")).toBe(0);
		expect(calls.some((u) => u.includes("jnc_"))).toBe(false);
	});

	test("状態が確定の部屋があれば取得しない", async () => {
		const { db, run, calls, clock } = setup({
			[SEARCH]: { body: p1 ?? "" },
			[PAGE2]: { body: p2 ?? "" },
		});
		await run();
		db.query("UPDATE units SET status = '確定' WHERE rowid = 1").run();
		const before = calls.length;
		clock.advance(45 * 60_000);
		await run();
		expect(calls.length).toBe(before);
	});
});
