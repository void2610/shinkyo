import { expect, test } from "bun:test";
import { kindOf } from "../src/images/kinds.ts";

const image = (
	caption: string | null,
	url = "https://img01.suumo.com/front/gazo/a/1_1o.jpg",
) => ({ url, caption });

test.each([
	["間取り図", "floor_plan"],
	["スーパー サミットストア 渋谷本町店（スーパー）まで297m", "surroundings"],
	["その他 駒場東大前駅（その他）まで1278m", "surroundings"],
	["建物外観 ☆綺麗な外観☆", "building"],
	["エントランス", "building"],
	["その他共有部分 共有部", "building"],
	["キッチン ※別部屋写真", "room"],
	["その他設備 エアコン", "room"],
	["その他 ☆路線図☆", "room"],
	["その他", "other"],
	["その他 その他", "other"],
	["その他設備", "other"],
])("%s → %s", (caption, kind) => {
	expect(kindOf(image(caption))).toBe(kind as never);
});

test("説明が無い写真はファイル名の末尾 _co を間取り図とみなす", () => {
	expect(
		kindOf(image(null, "https://img01.suumo.com/front/gazo/a/1_co.jpg")),
	).toBe("floor_plan");
	expect(kindOf(image(null))).toBe("room");
});
