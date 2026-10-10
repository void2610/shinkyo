import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createGsiGeocoder, type Geocoder } from "../src/commute/gsi.ts";
import { parseRoute, type RouteFinder } from "../src/commute/navitime.ts";
import {
	arrivalTime,
	type Workplace,
	workplaceKey,
} from "../src/commute/workplace.ts";
import { parseListPage } from "../src/fetch/parse.ts";
import { maxCommute, runCommute } from "../src/jobs/commute.ts";
import { upsertListing } from "../src/store/listings.ts";
import { emptyFilter, listUnits } from "../src/web/queries.ts";
import {
	FakeClock,
	fixture,
	MONDAY_10_JST,
	memoryDb,
	repoConfig,
} from "./helpers.ts";

const config = await repoConfig();
const rooms = parseListPage(await fixture("list_p1.html")).rooms;
const A: Workplace = {
	name: "職場A",
	lat: 35.68124,
	lon: 139.76712,
	arrive_by: "09:00",
};
const B: Workplace = {
	name: "職場B",
	lat: 35.69,
	lon: 139.7,
	arrive_by: "10:00",
};

let db: Database;
beforeEach(() => {
	db = memoryDb();
	for (const room of rooms)
		upsertListing(db, room, "test", MONDAY_10_JST.toISOString());
	// 状態の判定に左右されないよう、まず全部屋を候補にする
	db.query("UPDATE units SET status = '候補'").run();
});

const addressOf = (listingId: string) =>
	db
		.query<{ address: string }, [string]>(
			"SELECT address FROM listings WHERE listing_id = ?",
		)
		.get(listingId)?.address ?? "";

function run(
	options: {
		workplaces?: Workplace[];
		geocode?: Geocoder;
		route?: RouteFinder | null;
		geocodeDailyCap?: number;
		routeDailyCap?: number;
		criteria?: typeof config.criteria;
	} = {},
) {
	const calls: string[] = [];
	const logs: string[] = [];
	const summary = runCommute({
		db,
		criteria: options.criteria ?? config.criteria,
		workplaces: options.workplaces ?? [A, B],
		geocode:
			options.geocode ??
			(async (address) => {
				calls.push(`geo ${address}`);
				return { lat: 35.7, lon: 139.8 };
			}),
		route:
			options.route === undefined
				? async (_from, to, arriveAt) => {
						calls.push(`route ${to.lat} ${arriveAt}`);
						return {
							minutes: to === A ? 30 : 50,
							transfers: 1,
							walkMin: 8,
							lines: ["架空線"],
						};
					}
				: options.route,
		limits: {
			geocodeDailyCap: options.geocodeDailyCap ?? 100,
			routeDailyCap: options.routeDailyCap ?? 100,
			gapMs: 0,
		},
		clock: new FakeClock(MONDAY_10_JST).read,
		sleep: async () => {},
		log: (m) => logs.push(m),
		runId: "test",
	});
	return { summary, calls, logs };
}

describe("通勤時間の取得", () => {
	test("見送り以外の部屋の住所ごとに座標を取り、職場ごとに経路を調べて保存する", async () => {
		// 合成データの住所はすべて同じなので、見送りにする部屋だけ別の住所にする
		db.query(
			"UPDATE listings SET address = '東京都架空区梅町' WHERE listing_id = '900000000003'",
		).run();
		db.query(
			"UPDATE units SET status = '見送り' WHERE unit_key = (SELECT unit_key FROM listings WHERE listing_id = '900000000003')",
		).run();
		const { summary, calls } = run();
		const addresses = new Set(
			rooms.filter((r) => r.listingId !== "900000000003").map((r) => r.address),
		);
		expect(await summary).toEqual({
			geocoded: addresses.size,
			routed: addresses.size * 2,
		});
		expect(calls.filter((c) => c.startsWith("geo"))).toHaveLength(
			addresses.size,
		);
		expect(calls).toContain("route 35.68124 2026-10-14T09:00:00");
		expect(calls).toContain("route 35.69 2026-10-14T10:00:00");
		expect(calls).not.toContain(`geo ${addressOf("900000000003")}`);
	});

	test("一度調べた住所と職場は調べ直さない", async () => {
		await run().summary;
		const again = run();
		expect(await again.summary).toEqual({ geocoded: 0, routed: 0 });
		expect(again.calls).toEqual([]);
	});

	test("新着は一覧で必須条件を外れる部屋を調べない", async () => {
		db.query("UPDATE units SET status = '新着'").run();
		// 合成データのうち 1LDK (12.5万円 + 8000円) だけが一覧で満たすよう、家賃の上限を広げて間取りを絞る
		const { summary, calls } = run({
			criteria: {
				...config.criteria,
				hard: {
					...config.criteria.hard,
					rent_total_max: 150000,
					layouts: ["1LDK"],
				},
			},
		});
		await summary;
		expect(calls.filter((c) => c.startsWith("geo"))).toEqual([
			`geo ${addressOf("900000000001")}`,
		]);
	});

	test("座標が見つからない住所は経路を調べず、見つからなかったことも残す", async () => {
		const { summary } = run({ geocode: async () => null });
		expect((await summary).routed).toBe(0);
		expect(run({ geocode: async () => null }).calls).toEqual([]);
	});

	test("1日の上限で止め、続きは次の実行に回す", async () => {
		const first = run({ geocodeDailyCap: 0 });
		expect((await first.summary).geocoded).toBe(0);
		expect(first.logs.join()).toContain("上限");
		expect((await run().summary).geocoded).toBeGreaterThan(0);
	});

	test("経路を調べる API が無ければ座標だけ取る", async () => {
		const { summary } = run({ route: null });
		expect((await summary).routed).toBe(0);
		expect((await summary).geocoded).toBeGreaterThan(0);
	});

	test("経路の取得に失敗したらその回は止め、失敗した組は記録しない", async () => {
		const { summary, logs } = run({
			route: async () => {
				throw new Error("NAVITIME: HTTP 429");
			},
		});
		expect((await summary).routed).toBe(0);
		expect(logs.join()).toContain("HTTP 429");
		expect(db.query("SELECT COUNT(*) AS n FROM commutes").get()).toEqual({
			n: 0,
		});
	});
});

describe("いちばん長い人の通勤時間", () => {
	test("全員の職場までの時間が分かっているときだけ出し、一覧で絞り込み・並べ替えできる", async () => {
		const address = addressOf("900000000001");
		expect(maxCommute(db, address, [A, B])).toBeNull();
		await run().summary;
		expect(maxCommute(db, address, [A, B])).toBe(50);
		expect(maxCommute(db, address, [A])).toBe(30);
		expect(maxCommute(db, address, [{ ...A, arrive_by: "08:00" }])).toBeNull();

		const units = listUnits(
			db,
			{ ...emptyFilter, maxCommute: 45 },
			2026,
			"local",
			[A, B],
		);
		expect(units).toEqual([]);
		const near = listUnits(
			db,
			{ ...emptyFilter, maxCommute: 45, sort: "commute" },
			2026,
			"local",
			[A],
		);
		expect(near.length).toBeGreaterThan(0);
		expect(near[0]).toMatchObject({ lat: 35.7, lon: 139.8, max_commute: 30 });
		expect(near[0]?.commutes).toContainEqual({
			workplace: workplaceKey(A),
			minutes: 30,
			transfers: 1,
			walk_min: 8,
			lines: ["架空線"],
		});
	});
});

describe("部品", () => {
	test("経路は明日以降で最初の水曜の到着時刻で調べる", () => {
		// 2026-10-12 は月曜
		expect(arrivalTime(MONDAY_10_JST, "09:00")).toBe("2026-10-14T09:00:00");
		expect(arrivalTime(new Date("2026-10-14T01:00:00Z"), "08:30")).toBe(
			"2026-10-21T08:30:00",
		);
	});

	test("職場の名前を変えても、場所と到着時刻が同じなら同じ職場として扱う", () => {
		expect(workplaceKey({ ...A, name: "別名" })).toBe(workplaceKey(A));
		expect(workplaceKey({ ...A, arrive_by: "10:00" })).not.toBe(
			workplaceKey(A),
		);
	});

	test("NAVITIME の結果から時間・乗換・徒歩・路線を取り出す", () => {
		expect(
			parseRoute({
				items: [
					{
						summary: {
							move: { time: 41, transit_count: 1, walk_distance: 700 },
						},
						sections: [
							{ type: "point", name: "start" },
							{ type: "move", move: "walk", time: 6 },
							{ type: "point", name: "桜" },
							{
								type: "move",
								move: "local_train",
								time: 20,
								line_name: "架空線",
							},
							{ type: "point", name: "梅" },
							{
								type: "move",
								move: "rapid_train",
								time: 10,
								line_name: "空想線",
							},
							{ type: "move", move: "walk", time: 5 },
						],
					},
				],
			}),
		).toEqual({
			minutes: 41,
			transfers: 1,
			walkMin: 11,
			lines: ["架空線", "空想線"],
		});
		expect(parseRoute({ items: [] })).toBeNull();
	});

	test("国土地理院の住所検索は最初の候補の座標を返し、全角の数字も揃えて送る", async () => {
		const urls: string[] = [];
		const geocode = createGsiGeocoder(async (url) => {
			urls.push(String(url));
			return Response.json([
				{
					geometry: { coordinates: [139.8, 35.7] },
					properties: { title: "架空区1丁目" },
				},
			]);
		});
		expect(await geocode("架空区１")).toEqual({ lat: 35.7, lon: 139.8 });
		expect(decodeURIComponent(urls[0] ?? "")).toContain("q=架空区1");
		const none = createGsiGeocoder(async () => Response.json([]));
		expect(await none("どこにもない")).toBeNull();
	});
});
