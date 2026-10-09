import type { Criteria } from "../config.ts";
import type { Station } from "../domain.ts";
import { normalizeName } from "../unit-key.ts";

export type EvalInput = {
	rent: number;
	adminFee: number;
	areaM2: number;
	layout: string;
	floor: number | null;
	builtYm: string | null;
	builtAge: number | null;
	stations: Station[];
	features: string[];
	orientation: string | null;
	texts: string[];
};

export type ScoreParts = Record<
	"commute" | "rent" | "area" | "age" | "features",
	number
>;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const totalRent = (u: EvalInput): number => u.rent + u.adminFee;

// 築年月が無ければ築年数から年だけ推定する
function builtYear(u: EvalInput, now: Date): number | null {
	if (u.builtYm) return Number(u.builtYm.slice(0, 4));
	return u.builtAge === null ? null : now.getFullYear() - u.builtAge;
}

export function hardFailures(
	u: EvalInput,
	criteria: Criteria,
	now: Date,
): string[] {
	const h = criteria.hard;
	const reasons: string[] = [];
	if (totalRent(u) > h.rent_total_max)
		reasons.push(`家賃+管理費 ${totalRent(u).toLocaleString()}円が上限超え`);
	if (u.areaM2 < h.area_min_m2) reasons.push(`面積 ${u.areaM2}㎡が下限未満`);
	const walk = Math.min(...u.stations.map((s) => s.walkMin));
	if (u.stations.length === 0 || walk > h.walk_max_min)
		reasons.push(`駅徒歩 ${Number.isFinite(walk) ? walk : "?"}分`);
	if (
		u.builtYm
			? u.builtYm < h.built_from
			: (builtYear(u, now) ?? 9999) < Number(h.built_from.slice(0, 4))
	) {
		reasons.push(
			`築年 ${u.builtYm ?? `${builtYear(u, now)}年頃`}が ${h.built_from} より前`,
		);
	}
	if (u.floor !== null && u.floor < h.floor_min) reasons.push(`${u.floor}階`);
	const layouts = h.layouts.map(normalizeName);
	if (layouts.length > 0 && !layouts.includes(normalizeName(u.layout)))
		reasons.push(`間取り ${u.layout}`);
	for (const word of h.exclude) {
		if (u.texts.some((t) => t.includes(word))) reasons.push(word);
	}
	return reasons;
}

// 設備名は掲載ごとに書き方が違うので、条件側の名前を SUUMO の表記にも当てる
const featureSynonyms: Record<string, string[]> = {
	バストイレ別: ["バストイレ別", "バス・トイレ別"],
	独立洗面台: ["独立洗面台", "洗面所独立", "洗面台独立"],
	室内洗濯機置場: ["室内洗濯機置場", "室内洗濯置"],
	宅配ボックス: ["宅配ボックス"],
};

export function hasFeature(u: EvalInput, wanted: string): boolean {
	const key = normalizeName(wanted);
	if (key.includes("南向き"))
		return (
			(u.orientation ?? "").includes("南") ||
			u.features.some((f) => f.includes("南向き"))
		);
	const names = (featureSynonyms[key] ?? [wanted]).map(normalizeName);
	return u.features.some((f) =>
		names.some((n) => normalizeName(f).includes(n)),
	);
}

export function commuteMinutes(
	u: EvalInput,
	stations: Record<string, number>,
): number | null {
	const totals = u.stations
		.map((s) =>
			stations[s.station] === undefined
				? null
				: (stations[s.station] ?? 0) + s.walkMin,
		)
		.filter((m): m is number => m !== null);
	return totals.length > 0 ? Math.min(...totals) : null;
}

export function scoreParts(
	u: EvalInput,
	criteria: Criteria,
	stations: Record<string, number>,
	now: Date,
): ScoreParts {
	const h = criteria.hard;
	const commute = commuteMinutes(u, stations);
	const year = builtYear(u, now);
	return {
		// 通勤先までの時間が分からない駅は中立の 0.5 にする
		commute: commute === null ? 0.5 : clamp01((60 - commute) / 40),
		rent: clamp01((h.rent_total_max - totalRent(u)) / (h.rent_total_max * 0.3)),
		area: clamp01((u.areaM2 - h.area_min_m2) / (h.area_min_m2 * 0.6)),
		age: year === null ? 0.5 : clamp01(1 - (now.getFullYear() - year) / 40),
		features:
			criteria.features.length === 0
				? 0.5
				: criteria.features.filter((f) => hasFeature(u, f)).length /
					criteria.features.length,
	};
}

export function baseScore(
	parts: ScoreParts,
	weights: Record<string, number>,
): number {
	const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
	const sum = Object.entries(parts).reduce(
		(acc, [k, v]) => acc + (weights[k] ?? 0) * v,
		0,
	);
	return Math.round((sum / total) * 1000) / 10;
}
