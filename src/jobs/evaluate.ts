import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Workplace } from "../commute/workplace.ts";
import type { Criteria } from "../config.ts";
import { cautionFlags, type Station } from "../domain.ts";
import { FLAG_THRESHOLD, flagQuestions } from "../evaluate/flags.ts";
import {
	baseScore,
	type EvalInput,
	hardFailures,
	listInput,
	type ScoreParts,
	scoreParts,
} from "../evaluate/score.ts";
import { type Jev, JevFailed } from "../jev.ts";
import { type ClaudeRunner, callClaude, LlmFailed } from "../llm.ts";
import type { Notifier } from "../notify.ts";
import { getState, setState } from "../store/db.ts";
import { recordEvent, setFlag } from "../store/listings.ts";
import { type Clock, jst } from "../time.ts";
import { maxCommute } from "./commute.ts";

const llmResultSchema = z.object({
	results: z.array(
		z.object({
			id: z.string(),
			flags: z.array(z.enum(cautionFlags)),
			summary: z.string().max(80),
			adjust: z.number().int().min(-10).max(10),
			reason: z.string().max(120),
		}),
	),
});
type LlmResult = Omit<
	z.infer<typeof llmResultSchema>["results"][number],
	"flags"
> & { flags?: CautionFlag[] };
type CautionFlag = (typeof cautionFlags)[number];

// 注意点を Jev が判定できたときは、Claude には文章が要る要約と補正だけを頼む
const llmTextSchema = z.object({
	results: z.array(llmResultSchema.shape.results.element.omit({ flags: true })),
});

export type EvaluateDeps = {
	db: Database;
	criteria: Criteria;
	stations: Record<string, number>;
	notify: Notifier;
	clock: Clock;
	dryRun: boolean;
	log: (message: string) => void;
	systemPrompt: string;
	claude: ClaudeRunner | null;
	jev: Jev | null;
	webOrigin: string | null;
	workplaces?: Workplace[];
	// 候補も採点と Claude の補正をし直す (採点の基準を変えたとき)
	rescore?: boolean;
};

export type EvaluateSummary = {
	rejected: number;
	candidates: string[];
	rescored: number;
	llmFailed: number;
};

const LLM_BATCH = 8;
const DIGEST_PER_DAY = 3;
const DIGEST_SIZE = 5;
const CHEAP_RATIO = 0.85;
const CHEAP_MIN_SAMPLES = 5;

type ListingRow = {
	listing_id: string;
	address: string;
	unit_key: string;
	url: string;
	building_name: string;
	rent: number;
	admin_fee: number;
	area_m2: number;
	layout: string;
	floor: number | null;
	building_floors: string | null;
	built_ym: string | null;
	built_age: number | null;
	stations: string;
	features: string | null;
	orientation: string | null;
	notes: string | null;
	other_costs: string | null;
	guarantor: string | null;
	property_type: string | null;
	detail_fetched_at: string | null;
};

// detailed が false の部屋は一覧の情報だけで判定し、外れなければ詳細を待つ
type Target = {
	key: string;
	listing: ListingRow;
	input: EvalInput;
	stations: Station[];
	detailed: boolean;
	status: "新着" | "候補";
};

// 築年月や設備は詳細にしか無いので、一覧だけで外れる部屋を先に見送り、残りは詳細を待って評価する。
// 候補も対象にし、必須条件を変えたときに外れるようになった部屋を見送る (採点はし直さない)
function targets(db: Database): Target[] {
	const rows = db
		.query<ListingRow & { status: Target["status"] }, []>(
			`SELECT l.*, u.status FROM listings l JOIN units u ON u.unit_key = l.unit_key
			WHERE u.status IN ('新着', '候補') ORDER BY l.unit_key, l.rent + l.admin_fee`,
		)
		.all();
	const byUnit = Map.groupBy(rows, (r) => r.unit_key);
	return [...byUnit.entries()].flatMap(([key, listings]): Target[] => {
		const cheapest = listings[0];
		if (!cheapest) return [];
		const detailed = listings.find((l) => l.detail_fetched_at !== null);
		if (!detailed) {
			const stations = JSON.parse(cheapest.stations) as Station[];
			return [
				{
					key,
					listing: cheapest,
					stations,
					input: listInput(cheapest),
					detailed: false,
					status: cheapest.status,
				},
			];
		}
		const stations = JSON.parse(cheapest.stations) as Station[];
		const features = detailed.features
			? (JSON.parse(detailed.features) as string[])
			: [];
		return [
			{
				key,
				listing: {
					...detailed,
					rent: cheapest.rent,
					admin_fee: cheapest.admin_fee,
				},
				stations,
				input: {
					rent: cheapest.rent,
					adminFee: cheapest.admin_fee,
					areaM2: cheapest.area_m2,
					layout: cheapest.layout,
					floor: cheapest.floor,
					builtYm: detailed.built_ym,
					builtAge: cheapest.built_age,
					stations,
					features,
					orientation: detailed.orientation,
					texts: [
						detailed.notes,
						detailed.property_type,
						detailed.building_name,
						...features,
					].filter((t): t is string => !!t),
				},
				detailed: true,
				status: cheapest.status,
			},
		];
	});
}

// 同じ最寄駅・間取りの部屋の家賃+管理費の中央値
function marketMedian(
	db: Database,
	station: string,
	layout: string,
): number | null {
	const totals = db
		.query<{ total: number }, [string, string]>(
			`SELECT MIN(rent + admin_fee) AS total FROM listings
			WHERE json_extract(stations, '$[0].station') = ? AND layout = ? GROUP BY unit_key ORDER BY total`,
		)
		.all(station, layout)
		.map((r) => r.total);
	if (totals.length < CHEAP_MIN_SAMPLES) return null;
	const mid = Math.floor(totals.length / 2);
	return totals.length % 2
		? (totals[mid] ?? null)
		: ((totals[mid - 1] ?? 0) + (totals[mid] ?? 0)) / 2;
}

const unitState = (t: Target) => ({
	name: t.listing.building_name.normalize("NFKC"),
	rent: t.input.rent,
	admin_fee: t.input.adminFee,
	area_m2: t.input.areaM2,
	layout: t.input.layout,
	floor: t.input.floor,
	building_floors: t.listing.building_floors,
	built:
		t.input.builtYm ??
		(t.input.builtAge === null ? null : `築${t.input.builtAge}年`),
	orientation: t.input.orientation,
	stations: t.stations,
	features: t.input.features,
	notes: t.listing.notes,
	other_costs: t.listing.other_costs,
	guarantor: t.listing.guarantor,
});

// Jev が使えない・失敗したときは null を返し、Claude に注意点も選ばせる
async function askJev(
	deps: EvaluateDeps,
	t: Target,
): Promise<CautionFlag[] | null> {
	if (!deps.jev) return null;
	try {
		const answers = await deps.jev(unitState(t), flagQuestions);
		return cautionFlags.filter((flag) => {
			const a = answers[flag];
			return a?.type === "noul" && a.noul >= FLAG_THRESHOLD;
		});
	} catch (error) {
		if (!(error instanceof JevFailed)) throw error;
		deps.log(error.message);
		return null;
	}
}

// 何を重視するかは利用者の好みなので、リポジトリの指示文ではなく criteria の llm_guidance から足す
const systemPromptOf = (deps: EvaluateDeps): string =>
	deps.criteria.llm_guidance
		? `${deps.systemPrompt}\n\n## 利用者が重視すること・気にしないこと\n\n${deps.criteria.llm_guidance.trim()}`
		: deps.systemPrompt;

async function askClaude(
	deps: EvaluateDeps,
	batch: { target: Target; base: number }[],
	withFlags: boolean,
): Promise<Map<string, LlmResult>> {
	if (!deps.claude) return new Map();
	const input = {
		units: batch.map(({ target, base }, i) => ({
			id: String(i),
			...unitState(target),
			base_score: base,
		})),
	};
	const instruction = withFlags
		? "標準入力の JSON にある各部屋を評価して、指定のスキーマで返してください。"
		: "標準入力の JSON にある各部屋について、要約と補正だけを指定のスキーマで返してください。注意点は別の仕組みで判定済みです。";
	const results: LlmResult[] = withFlags
		? (
				await callClaude({
					schema: llmResultSchema,
					systemPrompt: systemPromptOf(deps),
					instruction,
					input,
					runner: deps.claude,
				})
			).results
		: (
				await callClaude({
					schema: llmTextSchema,
					systemPrompt: systemPromptOf(deps),
					instruction,
					input,
					runner: deps.claude,
				})
			).results;
	return new Map(
		results.flatMap((r) => {
			const t = batch[Number(r.id)]?.target;
			return t ? [[t.key, r] as const] : [];
		}),
	);
}

function digestLine(
	deps: EvaluateDeps,
	t: Target,
	score: number,
	summary: string | null,
): string {
	const name = `${t.listing.building_name.normalize("NFKC")} ${t.input.layout} ${(t.input.rent / 10000).toFixed(1)}万円`;
	const link = deps.webOrigin
		? `${deps.webOrigin}/units/${encodeURIComponent(t.key)}`
		: t.listing.url;
	return `${Math.round(score)}点 ${name}${summary ? ` — ${summary}` : ""}\n${link}`;
}

export async function runEvaluate(
	deps: EvaluateDeps,
): Promise<EvaluateSummary> {
	const { db, criteria, stations, clock, dryRun, log } = deps;
	const now = clock();
	const at = now.toISOString();
	const summary: EvaluateSummary = {
		rejected: 0,
		candidates: [],
		rescored: 0,
		llmFailed: 0,
	};
	const passed: {
		target: Target;
		base: number;
		parts: ScoreParts;
		cheap: boolean;
	}[] = [];

	for (const target of targets(db)) {
		// 経路の実測があれば、通勤時間の判定にも採点にも使う
		const commute = maxCommute(
			db,
			target.listing.address,
			deps.workplaces ?? [],
		);
		const input =
			commute === null
				? target.input
				: { ...target.input, routeCommute: commute };
		const failures = hardFailures(input, criteria, now, {
			detailed: target.detailed,
			stations,
		});
		if (
			failures.length === 0 &&
			(!target.detailed || (target.status === "候補" && !deps.rescore))
		)
			continue;
		if (failures.length > 0) {
			summary.rejected++;
			if (dryRun) {
				log(`[dry-run] 見送り: ${target.key} (${failures.join("、")})`);
				continue;
			}
			db.transaction(() => {
				db.query(
					"UPDATE units SET status = '見送り', next_action = ?, updated_at = ? WHERE unit_key = ?",
				).run(`必須条件外: ${failures.join("、")}`, at, target.key);
				recordEvent(db, {
					unitKey: target.key,
					type: "auto_rejected",
					actor: "system",
					at,
					fromStatus: target.status,
					toStatus: "見送り",
					detail: { failures },
				});
			})();
			continue;
		}
		const parts = scoreParts(input, criteria, stations, now);
		const median = target.stations[0]
			? marketMedian(db, target.stations[0].station, target.input.layout)
			: null;
		const cheap =
			median !== null &&
			target.input.rent + target.input.adminFee <= median * CHEAP_RATIO;
		passed.push({
			target,
			base: baseScore(parts, criteria.weights),
			parts,
			cheap,
		});
	}

	if (dryRun) {
		for (const p of passed)
			log(`[dry-run] 候補: ${p.target.key} 基礎点 ${p.base}`);
		return summary;
	}

	const scored: { target: Target; score: number; summary: string | null }[] =
		[];
	for (let i = 0; i < passed.length; i += LLM_BATCH) {
		const batch = passed.slice(i, i + LLM_BATCH);
		const jevFlags = new Map(
			await Promise.all(
				batch.map(
					async ({ target }) =>
						[target.key, await askJev(deps, target)] as const,
				),
			),
		);
		const allJudgedByJev = [...jevFlags.values()].every((f) => f !== null);
		let llm = new Map<string, LlmResult>();
		try {
			llm = await askClaude(deps, batch, !allJudgedByJev);
		} catch (error) {
			if (!(error instanceof LlmFailed)) throw error;
			summary.llmFailed += batch.length;
			log(error.message);
		}
		db.transaction(() => {
			for (const { target, base, parts, cheap } of batch) {
				const r = llm.get(target.key);
				db.query(
					`UPDATE units SET status = '候補', base_score = ?, adj_score = ?, summary = ?, updated_at = ? WHERE unit_key = ?`,
				).run(base, r?.adjust ?? null, r?.summary ?? null, at, target.key);
				const byJev = jevFlags.get(target.key) ?? null;
				for (const flag of byJev ?? r?.flags ?? [])
					setFlag(db, target.key, flag, true, at);
				if (cheap) setFlag(db, target.key, "相場より安い", true, at);
				const again = target.status === "候補";
				recordEvent(db, {
					unitKey: target.key,
					type: again ? "rescored" : "evaluated",
					actor: "system",
					at,
					fromStatus: target.status,
					toStatus: "候補",
					detail: {
						base,
						parts,
						adjust: r?.adjust ?? null,
						reason: r?.reason ?? null,
						flagsBy: byJev ? "jev" : r?.flags ? "claude" : null,
					},
				});
				if (again) {
					summary.rescored++;
					continue;
				}
				summary.candidates.push(target.key);
				scored.push({
					target,
					score: base + (r?.adjust ?? 0),
					summary: r?.summary ?? null,
				});
			}
		})();
	}

	if (summary.llmFailed > 0) {
		await deps.notify({
			title: "評価の補正ができなかった部屋がある",
			message: `${summary.llmFailed} 件は claude -p の結果を得られず、基礎点だけで候補にした。人の判断が要る`,
			priority: 4,
			tags: ["warning"],
		});
	}
	await notifyDigest(deps, scored);
	return summary;
}

// 新着ダイジェストは1日 DIGEST_PER_DAY 回までにまとめる (仕様 J2)
async function notifyDigest(
	deps: EvaluateDeps,
	scored: { target: Target; score: number; summary: string | null }[],
) {
	const top = scored
		.filter((s) => s.score >= deps.criteria.notify_min_score)
		.sort((a, b) => b.score - a.score)
		.slice(0, DIGEST_SIZE);
	if (top.length === 0) return;
	const key = `evaluate.digest.${jst(deps.clock()).date}`;
	const sent = Number(getState(deps.db, key) ?? 0);
	if (sent >= DIGEST_PER_DAY) {
		deps.log(`ダイジェストは今日 ${DIGEST_PER_DAY} 回送ったので送らない`);
		return;
	}
	await deps.notify({
		title: `新着の候補 ${top.length} 件`,
		message: top
			.map((s) => digestLine(deps, s.target, s.score, s.summary))
			.join("\n\n"),
		tags: ["house"],
	});
	setState(deps.db, key, String(sent + 1));
}
