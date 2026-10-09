import { describe, expect, test } from "bun:test";
import {
	baseScore,
	type EvalInput,
	hardFailures,
	hasFeature,
	scoreParts,
} from "../src/evaluate/score.ts";
import { repoConfig } from "./helpers.ts";

const { criteria } = await repoConfig();
const now = new Date("2026-10-12T01:00:00Z");

const room: EvalInput = {
	rent: 100000,
	adminFee: 5000,
	areaM2: 30,
	layout: "1LDK",
	floor: 3,
	builtYm: "2010-04",
	builtAge: 16,
	stations: [{ line: "架空線", station: "桜", walkMin: 6 }],
	features: ["バストイレ別", "室内洗濯置", "洗面所独立"],
	orientation: "南東",
	texts: [],
};

describe("必須条件", () => {
	test("すべて満たせば見送り理由は無い", () => {
		expect(hardFailures(room, criteria, now)).toEqual([]);
	});

	test.each([
		["家賃+管理費の上限", { rent: 118000 }, "上限超え"],
		["面積の下限", { areaM2: 24.9 }, "面積"],
		[
			"駅徒歩",
			{ stations: [{ line: "架空線", station: "桜", walkMin: 11 }] },
			"駅徒歩",
		],
		["築年月 (新耐震)", { builtYm: "1981-12" }, "築年"],
		[
			"築年月が無いときは築年数から推定",
			{ builtYm: null, builtAge: 50 },
			"築年",
		],
		["階", { floor: 1 }, "1階"],
		["地下", { floor: -1 }, "-1階"],
		["間取り", { layout: "ワンルーム" }, "間取り"],
		["除外語", { texts: ["定期借家 2年"] }, "定期借家"],
	])("%s", (_label, diff, reason) => {
		const failures = hardFailures({ ...room, ...diff }, criteria, now);
		expect(failures.join()).toContain(reason);
	});
});

describe("基礎点", () => {
	test("設備名の書き方の違いと向きを吸収する", () => {
		expect(hasFeature(room, "バス・トイレ別")).toBe(true);
		expect(hasFeature(room, "独立洗面台")).toBe(true);
		expect(hasFeature(room, "室内洗濯機置場")).toBe(true);
		expect(hasFeature(room, "南向き")).toBe(true);
		expect(hasFeature(room, "宅配ボックス")).toBe(false);
	});

	test("通勤時間が分からない駅は中立、分かれば短いほど高い", () => {
		expect(scoreParts(room, criteria, {}, now).commute).toBe(0.5);
		expect(scoreParts(room, criteria, { 桜: 14 }, now).commute).toBe(1);
		expect(scoreParts(room, criteria, { 桜: 54 }, now).commute).toBe(0);
	});

	test("安く・広く・新しいほど点が高く、0〜100 に収まる", () => {
		const cheap = baseScore(
			scoreParts({ ...room, rent: 70000 }, criteria, {}, now),
			criteria.weights,
		);
		const pricey = baseScore(
			scoreParts({ ...room, rent: 115000 }, criteria, {}, now),
			criteria.weights,
		);
		expect(cheap).toBeGreaterThan(pricey);
		expect(pricey).toBeGreaterThanOrEqual(0);
		expect(cheap).toBeLessThanOrEqual(100);
	});
});
