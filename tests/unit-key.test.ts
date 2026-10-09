import { describe, expect, test } from "bun:test";
import {
	isMergeCandidate,
	normalizeAddress,
	type UnitKeySource,
	unitKey,
} from "../src/unit-key.ts";

const base: UnitKeySource = {
	buildingName: "テストハイツ桜A",
	address: "東京都架空区桜町",
	floor: 3,
	areaM2: 40.02,
	layout: "1LDK",
	rent: 125000,
};

describe("unitKey で統合すべきもの", () => {
	test.each([
		[
			"全角英数と空白",
			{ buildingName: "テストハイツ　桜Ａ", layout: "１ＬＤＫ" },
		],
		["記号の揺れ", { buildingName: "テスト・ハイツ（桜A）" }],
		["面積の端数 (0.5㎡単位に丸める)", { areaM2: 39.9 }],
		["家賃だけ違う (建物名があるときは家賃をキーに含めない)", { rent: 128000 }],
	])("%s", (_label, diff) => {
		expect(unitKey({ ...base, ...diff })).toBe(unitKey(base));
	});

	test("丁目より後の書き方の違い", () => {
		expect(unitKey({ ...base, address: "東京都架空区桜町2-3-4" })).toBe(
			unitKey({ ...base, address: "東京都架空区桜町２丁目５番" }),
		);
	});
});

describe("unitKey で統合すべきでないもの", () => {
	test.each([
		["階が違う", { floor: 4 }],
		["間取りが違う", { layout: "2LDK" }],
		["面積が 1㎡ 違う", { areaM2: 41.02 }],
		["建物名が違う", { buildingName: "テストハイツ梅" }],
	])("%s", (_label, diff) => {
		expect(unitKey({ ...base, ...diff })).not.toBe(unitKey(base));
	});

	test("汎用の建物名は住所と家賃で区別する", () => {
		const generic = { ...base, buildingName: "桜駅の賃貸マンション" };
		expect(unitKey(generic)).toStartWith("a|");
		expect(unitKey({ ...generic, rent: 99000 })).not.toBe(unitKey(generic));
	});
});

describe("統合候補", () => {
	test("面積差 1㎡ 以内の別キーは統合せず候補にする", () => {
		const other = { ...base, areaM2: 40.9 };
		expect(unitKey(other)).not.toBe(unitKey(base));
		expect(isMergeCandidate(base, other)).toBe(true);
	});

	test("同じキーや階違いは候補にしない", () => {
		expect(isMergeCandidate(base, { ...base })).toBe(false);
		expect(isMergeCandidate(base, { ...base, floor: 4, areaM2: 40.9 })).toBe(
			false,
		);
	});
});

test("住所は丁目までで切る", () => {
	expect(normalizeAddress("東京都架空区桜町２丁目３−４")).toBe(
		"東京都架空区桜町2丁目",
	);
	expect(normalizeAddress("東京都架空区桜町2-3-4")).toBe(
		"東京都架空区桜町2丁目",
	);
	expect(normalizeAddress("東京都架空区桜町")).toBe("東京都架空区桜町");
});
