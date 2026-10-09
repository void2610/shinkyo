import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseDetailPage, parseListPage } from "../src/fetch/parse.ts";
import { applyDetail, setFlag, upsertListing } from "../src/store/listings.ts";
import { parseFilter } from "../src/web/filter.ts";
import {
	emptyFilter,
	filterOptions,
	listUnits,
	type UnitFilter,
} from "../src/web/queries.ts";
import { fixture, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const at = MONDAY_10_JST.toISOString();
const rooms = [
	...parseListPage(await fixture("list_p1.html")).rooms,
	...parseListPage(await fixture("list_p2.html")).rooms,
];
const detail = parseDetailPage(await fixture("detail.html"));

let db: Database;
beforeEach(() => {
	db = memoryDb();
	for (const room of rooms) upsertListing(db, room, "test", at);
	applyDetail(db, "900000000002", detail, "", at);
});

const keyOf = (listingId: string) =>
	db
		.query<{ unit_key: string }, [string]>(
			"SELECT unit_key FROM listings WHERE listing_id = ?",
		)
		.get(listingId)?.unit_key ?? "";
const names = (f: Partial<UnitFilter>) =>
	listUnits(db, { ...emptyFilter, ...f }, 2026)
		.map((u) => `${u.layout}:${u.floor}`)
		.sort();

describe("一覧の絞り込み", () => {
	test("条件が無ければ見送り以外をすべて出す", () => {
		expect(names({})).toEqual(["1K:2", "1LDK:3", "ワンルーム:-1"]);
	});

	test("家賃+管理費の上限 (12.5万+8000円 / 8.9万円 / 9.8万+3000円)", () => {
		expect(names({ maxRent: 100000 })).toEqual(["ワンルーム:-1"]);
		expect(names({ maxRent: 101000 })).toEqual(["1K:2", "ワンルーム:-1"]);
	});

	test("面積・駅徒歩・築年数", () => {
		expect(names({ minArea: 25 })).toEqual(["1K:2", "1LDK:3"]);
		expect(names({ maxWalk: 6 })).toEqual(["1LDK:3", "ワンルーム:-1"]);
		// 1LDK は詳細の築年月 2014-03 (12年)、ほかは一覧の築年数 (12年・新築)
		expect(names({ maxAge: 5 })).toEqual(["1K:2"]);
		expect(names({ maxAge: 12 })).toEqual(["1K:2", "1LDK:3", "ワンルーム:-1"]);
	});

	test("間取りは複数選べ、駅は最寄駅のどれかに一致すればよい", () => {
		expect(names({ layouts: ["1K", "ワンルーム"] })).toEqual([
			"1K:2",
			"ワンルーム:-1",
		]);
		expect(names({ station: "梅" })).toEqual(["1LDK:3", "ワンルーム:-1"]);
	});

	test("タグはありとなしを組み合わせられる", () => {
		setFlag(db, keyOf("900000000001"), "北向き", true, at);
		setFlag(db, keyOf("900000000004"), "定期借家", true, at);
		expect(names({ withFlags: ["北向き"] })).toEqual(["1LDK:3"]);
		expect(names({ withoutFlags: ["北向き", "定期借家"] })).toEqual([
			"ワンルーム:-1",
		]);
	});

	test("選択肢は実際の部屋から作る", () => {
		expect(filterOptions(db).layouts.sort()).toEqual([
			"1K",
			"1LDK",
			"ワンルーム",
		]);
		expect(filterOptions(db).stations).toContain("梅");
	});
});

describe("URL からの読み取り", () => {
	test("家賃は万円で受け取り円にし、タグは +/- で向きを分ける", () => {
		const f = parseFilter(
			new URLSearchParams(
				"max_rent=10.5&min_area=25&layout=1K&layout=1LDK&tag=%2B北向き&tag=-定期借家&tag=&station=梅",
			),
		);
		expect(f).toMatchObject({
			maxRent: 105000,
			minArea: 25,
			layouts: ["1K", "1LDK"],
			withFlags: ["北向き"],
			withoutFlags: ["定期借家"],
			station: "梅",
		});
	});

	test("空欄・不正な値・知らないタグは指定なしとして扱う", () => {
		expect(
			parseFilter(
				new URLSearchParams(
					"max_rent=&max_walk=abc&tag=%2B存在しない&status=zzz",
				),
			),
		).toEqual(emptyFilter);
	});
});
