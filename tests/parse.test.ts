import { describe, expect, test } from "bun:test";
import {
	parseAge,
	parseDetailPage,
	parseFloor,
	parseListPage,
	parseStation,
	parseYen,
} from "../src/fetch/parse.ts";
import { fixture } from "./helpers.ts";

describe("値の解析", () => {
	test.each([
		["28万円", 280000],
		["28.5万円", 285000],
		["30.75万円", 307500],
		["10000円", 10000],
		["1,500円", 1500],
		["-", 0],
	])("parseYen(%p) = %p", (text, yen) => {
		expect(parseYen(text)).toBe(yen);
	});

	test.each([
		["4階", 4],
		["B1階", -1],
		["1-2階", 1],
		["\n\t\t3階", 3],
		["", null],
	])("parseFloor(%p) = %p", (text, floor) => {
		expect(parseFloor(text)).toBe(floor);
	});

	test("築年数と新築", () => {
		expect(parseAge("築21年")).toBe(21);
		expect(parseAge("新築")).toBe(0);
		expect(parseAge("")).toBeNull();
	});

	test("駅と徒歩分を分け、全角の路線名は半角に揃える", () => {
		expect(parseStation("ＪＲ山手線/恵比寿駅 歩11分")).toEqual({
			line: "JR山手線",
			station: "恵比寿",
			walkMin: 11,
		});
		expect(parseStation("バス停のみ")).toBeNull();
	});
});

describe("検索一覧", () => {
	test("部屋ごとに家賃・管理費・敷金・礼金・間取り・面積・築年・階・駅・徒歩を取り出す", async () => {
		const page = parseListPage(await fixture("list_p1.html"));
		expect(page.rooms).toHaveLength(3);
		expect(page.hitCount).toBe(4);
		expect(page.rooms[0]).toEqual({
			listingId: "900000000001",
			url: "https://suumo.jp/chintai/jnc_000000000101/?bc=900000000001",
			buildingName: "テストハイツ桜A/テストハイツ桜B",
			propertyType: "賃貸マンション",
			address: "東京都架空区桜町",
			stations: [
				{ line: "架空線", station: "桜", walkMin: 6 },
				{ line: "JR架空本線", station: "梅", walkMin: 12 },
			],
			builtAge: 12,
			buildingFloors: "地下1地上5階建",
			floor: 3,
			rent: 125000,
			adminFee: 8000,
			deposit: 125000,
			keyMoney: 0,
			layout: "1LDK",
			areaM2: 40.02,
			isNewArrival: false,
		});
		expect(page.rooms[2]).toMatchObject({
			floor: -1,
			layout: "ワンルーム",
			adminFee: 0,
			deposit: 0,
			isNewArrival: true,
		});
	});

	test("次ページの URL を絶対 URL で返し、最終ページでは null", async () => {
		expect(parseListPage(await fixture("list_p1.html")).nextUrl).toBe(
			"https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&sc=99999&page=2",
		);
		expect(parseListPage(await fixture("list_p2.html")).nextUrl).toBeNull();
	});

	test("0件の検索結果とパーサー破損をヒット件数で区別できる", async () => {
		expect(parseListPage(await fixture("list_empty.html"))).toMatchObject({
			rooms: [],
			hitCount: 0,
		});
		expect(parseListPage(await fixture("list_broken.html"))).toMatchObject({
			rooms: [],
			hitCount: 120,
		});
	});
});

describe("物件詳細", () => {
	test("業者名・築年月・向き・設備・保証会社を取り出し、値が - の項目は null にする", async () => {
		expect(parseDetailPage(await fixture("detail.html"))).toEqual({
			listingId: "900000000002",
			agentName: "架空不動産(株)桜店",
			builtYm: "2014-03",
			orientation: "南",
			features: [
				"バストイレ別",
				"エアコン",
				"室内洗濯置",
				"宅配ボックス",
				"南向き",
			],
			otherCosts: null,
			guarantor: "保証会社利用必 初回：月額総家賃の50％",
		});
	});
});
