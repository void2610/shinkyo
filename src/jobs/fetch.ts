import type { Database } from "bun:sqlite";
import type { Criteria, Policy, Search } from "../config.ts";
import { hardFailures, listInput } from "../evaluate/score.ts";
import {
	type ListedRoom,
	parseDetailPage,
	parseListPage,
} from "../fetch/parse.ts";
import type { RawStore } from "../fetch/raw.ts";
import { FetchStopped, type HttpClient } from "../fetch/suumo.ts";
import type { Notifier } from "../notify.ts";
import {
	applyDetail,
	findListing,
	listingsWithoutDetail,
	markMissing,
	upsertListing,
} from "../store/listings.ts";
import { type Clock, jst } from "../time.ts";

export type FetchJobDeps = {
	db: Database;
	client: Pick<HttpClient, "get" | "recordItems">;
	searches: Search[];
	policy: Policy;
	notify: Notifier;
	raw: RawStore;
	clock: Clock;
	dryRun: boolean;
	log: (message: string) => void;
	criteria: Criteria;
};

export type FetchSummary = {
	newListings: number;
	newUnits: string[];
	updatedUnits: string[];
	priceDrops: { unitKey: string; from: number; to: number }[];
	missingUnits: string[];
	details: number;
	skippedDetails: number;
	stopped: string | null;
};

const RAW_KEEP_DAYS = 7;
const quietReasons = new Set(["paused", "outside_hours", "stopped_today"]);

type SearchResult = {
	search: Search;
	rooms: ListedRoom[];
	complete: boolean;
	stopped: FetchStopped | null;
};

async function crawlSearch(
	deps: FetchJobDeps,
	search: Search,
): Promise<SearchResult> {
	const { client, policy, raw, clock, notify, log } = deps;
	const rooms: ListedRoom[] = [];
	let url: string | null = search.url;
	for (let page = 1; url && page <= policy.fetch.max_pages_per_search; page++) {
		let res: Awaited<ReturnType<typeof client.get>>;
		try {
			res = await client.get(url);
		} catch (error) {
			if (error instanceof FetchStopped)
				return { search, rooms, complete: false, stopped: error };
			throw error;
		}
		const today = jst(clock()).date;
		const rawPath = deps.dryRun
			? ""
			: await raw.save(
					today,
					`list_${search.id}_p${page}_${clock().getTime()}`,
					res.body,
				);
		if (res.status !== 200) {
			log(`${search.id} の ${page} ページ目が HTTP ${res.status} だった`);
			return { search, rooms, complete: false, stopped: null };
		}
		const parsed = parseListPage(res.body);
		client.recordItems(res.logId, parsed.rooms.length);
		if (parsed.rooms.length === 0 && parsed.hitCount !== 0) {
			await notify({
				title: "SUUMO のパーサーが壊れている可能性",
				message: `${search.id} の ${page} ページ目が 200 なのに 0 件だった。raw: ${rawPath || "(dry-run)"}`,
				priority: 4,
				tags: ["warning"],
			});
			return { search, rooms, complete: false, stopped: null };
		}
		rooms.push(...parsed.rooms);
		url = parsed.nextUrl;
	}
	if (url) {
		log(
			`${search.id} は ${policy.fetch.max_pages_per_search} ページに収まらない。検索条件を絞ると掲載終了の判定ができる`,
		);
	}
	return { search, rooms, complete: url === null, stopped: null };
}

function applyResults(
	deps: FetchJobDeps,
	results: SearchResult[],
	summary: FetchSummary,
): void {
	const { db, clock } = deps;
	const at = clock().toISOString();
	db.transaction(() => {
		for (const { search, rooms, complete } of results) {
			const seen = new Set<string>();
			for (const room of rooms) {
				if (seen.has(room.listingId)) continue;
				seen.add(room.listingId);
				const r = upsertListing(db, room, search.id, at);
				if (r.kind === "new") {
					summary.newListings++;
					if (r.newUnit) summary.newUnits.push(r.unitKey);
					else summary.updatedUnits.push(r.unitKey);
				} else if (r.priceDrop) {
					summary.priceDrops.push({ unitKey: r.unitKey, ...r.priceDrop });
					summary.updatedUnits.push(r.unitKey);
				}
			}
			// 途中で打ち切った検索は「一覧に無い」を判定できない
			if (complete)
				summary.missingUnits.push(...markMissing(db, search.id, seen, at));
		}
	})();
}

async function fetchDetails(
	deps: FetchJobDeps,
	summary: FetchSummary,
): Promise<void> {
	const { db, client, raw, clock, log, criteria } = deps;
	for (const pending of listingsWithoutDetail(db)) {
		const { listing_id, url } = pending;
		// 一覧の時点で必須条件を外れる掲載は、詳細を取ってもどうせ見送るのでリクエストを使わない
		if (hardFailures(listInput(pending), criteria, clock(), false).length > 0) {
			summary.skippedDetails++;
			continue;
		}
		const res = await client.get(url);
		if (res.status !== 200) {
			log(`詳細 ${listing_id} が HTTP ${res.status} だった`);
			continue;
		}
		const rawPath = await raw.save(
			jst(clock()).date,
			`detail_${listing_id}`,
			res.body,
		);
		applyDetail(
			db,
			listing_id,
			parseDetailPage(res.body),
			rawPath,
			clock().toISOString(),
		);
		summary.details++;
	}
}

function shouldStop(db: Database, policy: Policy): boolean {
	if (policy.stop_fetch_when_status.length === 0) return false;
	const placeholders = policy.stop_fetch_when_status.map(() => "?").join(", ");
	const row = db
		.query<{ n: number }, string[]>(
			`SELECT COUNT(*) AS n FROM units WHERE status IN (${placeholders})`,
		)
		.get(...policy.stop_fetch_when_status);
	return (row?.n ?? 0) > 0;
}

export async function runFetch(deps: FetchJobDeps): Promise<FetchSummary> {
	const { db, policy, searches, notify, raw, clock, dryRun, log } = deps;
	const summary: FetchSummary = {
		newListings: 0,
		newUnits: [],
		updatedUnits: [],
		priceDrops: [],
		missingUnits: [],
		details: 0,
		skippedDetails: 0,
		stopped: null,
	};
	if (shouldStop(db, policy)) {
		log(
			`状態が ${policy.stop_fetch_when_status.join("・")} の部屋があるので取得しない`,
		);
		return summary;
	}
	const results: SearchResult[] = [];
	let stopped: FetchStopped | null = null;
	for (const search of searches) {
		const result = await crawlSearch(deps, search);
		results.push(result);
		stopped = result.stopped;
		if (stopped) break;
	}
	if (dryRun) {
		const rooms = results.flatMap((r) => r.rooms);
		const fresh = rooms.filter((room) => !findListing(db, room.listingId));
		log(
			`[dry-run] 一覧 ${rooms.length} 件、未登録 ${fresh.length} 件。登録と詳細の取得はしない`,
		);
	} else {
		applyResults(deps, results, summary);
		if (!stopped) {
			try {
				await fetchDetails(deps, summary);
			} catch (error) {
				if (!(error instanceof FetchStopped)) throw error;
				stopped = error;
			}
		}
	}
	if (stopped) {
		summary.stopped = stopped.reason;
		if (quietReasons.has(stopped.reason)) {
			log(`取得しない: ${stopped.message}`);
		} else {
			await notify({
				title: "SUUMO の取得を止めた",
				message: stopped.message,
				priority: 4,
				tags: ["no_entry"],
			});
		}
	}
	if (!dryRun) raw.prune(jst(clock()).date, RAW_KEEP_DAYS);
	if (summary.priceDrops.length > 0) {
		await notify({
			title: `値下げ ${summary.priceDrops.length} 件`,
			message: summary.priceDrops
				.map(
					(d) =>
						`${d.unitKey}: ${d.from.toLocaleString()} → ${d.to.toLocaleString()} 円`,
				)
				.join("\n"),
			tags: ["chart_with_downwards_trend"],
		});
	}
	return summary;
}
