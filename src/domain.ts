export const unitStatuses = [
	"新着",
	"候補",
	"問合せ中",
	"空室確認済",
	"内見予約済",
	"内見済",
	"申込",
	"審査中",
	"確定",
	"見送り",
] as const;
export type UnitStatus = (typeof unitStatuses)[number];

export const judgments = ["◎", "○", "×"] as const;
export type Judgment = (typeof judgments)[number];

export const unitFlags = ["掲載終了の可能性", "値下げ", "統合候補"] as const;
export type UnitFlag = (typeof unitFlags)[number];

export type Station = { line: string; station: string; walkMin: number };
