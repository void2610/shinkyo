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
const detailed = { detailed: true, stations: {} };

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
		expect(hardFailures(room, criteria, now, detailed)).toEqual([]);
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
		const failures = hardFailures(
			{ ...room, ...diff },
			criteria,
			now,
			detailed,
		);
		expect(failures.join()).toContain(reason);
	});
});

describe("必須の設備", () => {
	const required = {
		...criteria,
		hard: { ...criteria.hard, required_features: ["床暖房", "宅配"] },
	};
	test("詳細の設備に無ければ見送り、名前の一部が合う設備も当てる", () => {
		const ok = { ...room, features: ["床暖房", "宅配ボックス"] };
		expect(hardFailures(ok, required, now, detailed)).toEqual([]);
		expect(hardFailures(room, required, now, detailed)).toEqual([
			"床暖房なし",
			"宅配なし",
		]);
	});
	test("一覧だけの判定では設備が分からないので見ない", () => {
		expect(
			hardFailures(room, required, now, { detailed: false, stations: {} }),
		).toEqual([]);
	});
});

describe("通勤時間の上限", () => {
	const limited = {
		...criteria,
		hard: { ...criteria.hard, commute_max_min: 40 },
	};
	const check = (u: EvalInput, stations: Record<string, number>) =>
		hardFailures(u, limited, now, { detailed: true, stations });
	test("駅ごとの目安に駅徒歩を足して判定し、目安の無い駅は見送る", () => {
		// 桜駅 歩6分
		expect(check(room, { 桜: 34 })).toEqual([]);
		expect(check(room, { 桜: 35 })).toEqual(["通勤 41分"]);
		expect(check(room, {})).toEqual(["通勤時間の目安が無い駅"]);
	});
	test("経路の実測があれば駅の目安より優先する", () => {
		expect(check({ ...room, routeCommute: 38 }, {})).toEqual([]);
		expect(check({ ...room, routeCommute: 52 }, { 桜: 10 })).toEqual([
			"通勤 52分",
		]);
	});
	test("上限を書かなければ通勤時間では見送らない", () => {
		expect(hardFailures(room, criteria, now, detailed)).toEqual([]);
	});
});

describe("基礎点の換算", () => {
	const tuned = {
		...criteria,
		scoring: {
			commute_min: [30, 50] as [number, number],
			rent_total: [100000, 140000] as [number, number],
			renovated_as_age: 8,
		},
	};
	test("通勤と家賃は、設定した満点と0点の値の間で直線に按分する", () => {
		// 桜駅の目安 34分 + 歩6分 = 40分、家賃 11.5万 + 5000円 = 12万
		const parts = scoreParts({ ...room, rent: 115000 }, tuned, { 桜: 34 }, now);
		expect(parts.commute).toBe(0.5);
		expect(parts.rent).toBe(0.5);
		expect(scoreParts(room, tuned, { 桜: 20 }, now).commute).toBe(1);
	});
	test("リノベーション・リフォーム済みの部屋は、設定した築年数として扱う", () => {
		const old = { ...room, builtYm: "1990-04" };
		expect(scoreParts(old, tuned, {}, now).age).toBeCloseTo(0.1);
		expect(
			scoreParts({ ...old, features: ["内装リフォーム済"] }, tuned, {}, now)
				.age,
		).toBeCloseTo(0.8);
		// 指定が無ければ築年どおり
		expect(
			scoreParts({ ...old, features: ["リノベーション"] }, criteria, {}, now)
				.age,
		).toBeCloseTo(0.1);
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
