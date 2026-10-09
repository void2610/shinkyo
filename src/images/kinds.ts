import type { RoomImage } from "../fetch/parse.ts";

export const imageKinds = [
	"floor_plan",
	"room",
	"building",
	"other",
	"surroundings",
] as const;
export type ImageKind = (typeof imageKinds)[number];

export const imageKindLabels: Record<ImageKind, string> = {
	floor_plan: "間取り図",
	room: "室内・設備",
	building: "建物・共用部",
	other: "その他",
	surroundings: "周辺環境",
};

// SUUMO の説明は「種類 + 自由記述」で、周辺施設は必ず「（種別）まで◯m」で終わる。実データ 884 枚で Jev との一致は 98%
export function kindOf(image: RoomImage): ImageKind {
	const caption = (image.caption ?? "").trim();
	if (caption === "")
		return /_co\.\w+$/.test(image.url) ? "floor_plan" : "room";
	if (caption.includes("間取り")) return "floor_plan";
	if (/まで\s*[\d,]+\s*m/.test(caption)) return "surroundings";
	// 種類の語だけで手がかりの無い説明は、室内とも周辺とも決めない
	if (/^その他(設備)?(\s+その他)?$/.test(caption)) return "other";
	if (
		/外観|エントランス|ロビー|セキュリティ|共有|共用|駐車場|駐輪|ゴミ置/.test(
			caption,
		)
	)
		return "building";
	return "room";
}

export const isFloorPlan = (image: RoomImage): boolean =>
	kindOf(image) === "floor_plan";

// 説明付きの画像は詳細を取得した掲載にしかないので、説明の多い掲載を写真の出どころにする
export function pickGallerySource<T extends { images: RoomImage[] }>(
	listings: T[],
): T | undefined {
	const captioned = (l: T) => l.images.filter((i) => i.caption).length;
	return [...listings].sort(
		(a, b) => captioned(b) - captioned(a) || b.images.length - a.images.length,
	)[0];
}
