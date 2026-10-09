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

// 評価で Claude が選べる注意点。自由記述にすると長文になり一覧で比べられない
export const cautionFlags = [
	"北向き",
	"1階",
	"線路・幹線道路沿いの可能性",
	"定期借家",
	"告知事項あり",
	"旧耐震の可能性",
	"日当たりが悪い可能性",
	"騒音の可能性",
	"初期費用が高い",
	"保証会社の条件が重い",
] as const;

export const unitFlags = [
	"掲載終了の可能性",
	"値下げ",
	"統合候補",
	"相場より安い",
	...cautionFlags,
] as const;
export type UnitFlag = (typeof unitFlags)[number];

export type Station = { line: string; station: string; walkMin: number };
