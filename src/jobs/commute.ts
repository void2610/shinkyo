import type { Database } from "bun:sqlite";
import type { Geocoder } from "../commute/gsi.ts";
import type { RouteFinder } from "../commute/navitime.ts";
import {
	arrivalTime,
	type Workplace,
	workplaceKey,
} from "../commute/workplace.ts";
import type { Criteria } from "../config.ts";
import { hardFailures, listInput } from "../evaluate/score.ts";
import { type Clock, jst } from "../time.ts";

export type CommuteLimits = {
	geocodeDailyCap: number;
	routeDailyCap: number;
	gapMs: number;
};

export type CommuteDeps = {
	db: Database;
	criteria: Criteria;
	workplaces: Workplace[];
	geocode: Geocoder;
	route: RouteFinder | null;
	limits: CommuteLimits;
	clock: Clock;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
	runId: string;
};

export type CommuteSummary = { geocoded: number; routed: number };

type Row = {
	status: string;
	address: string;
	rent: number;
	admin_fee: number;
	area_m2: number;
	layout: string;
	floor: number | null;
	built_age: number | null;
	stations: string;
};

// 見送り以外の部屋の住所。新着は一覧の時点で必須条件を外れるものを除き、API の回数を無駄にしない
export function commuteTargets(
	db: Database,
	criteria: Criteria,
	now: Date,
): string[] {
	const rows = db
		.query<Row, []>(
			`WITH ranked AS (
				SELECT l.*, ROW_NUMBER() OVER (PARTITION BY unit_key ORDER BY rent + admin_fee, last_seen DESC, listing_id) AS rn
				FROM listings l
			)
			SELECT u.status, r.address, r.rent, r.admin_fee, r.area_m2, r.layout, r.floor, r.built_age, r.stations
			FROM units u JOIN ranked r ON r.unit_key = u.unit_key AND r.rn = 1
			WHERE u.status != '見送り' ORDER BY r.first_seen DESC`,
		)
		.all();
	const addresses = rows
		.filter(
			(r) =>
				r.status !== "新着" ||
				hardFailures(listInput(r), criteria, now, false).length === 0,
		)
		.map((r) => r.address);
	return [...new Set(addresses)];
}

class CapReached extends Error {}

// 外部 API は1日の上限と間隔を守り、呼んだ記録を fetch_log に残す
function gate(deps: CommuteDeps, kind: string, cap: number) {
	const { db, clock, runId } = deps;
	let first = true;
	return async <T>(label: string, call: () => Promise<T>): Promise<T> => {
		const now = clock();
		const used =
			db
				.query<{ n: number }, [string, string]>(
					"SELECT COUNT(*) AS n FROM fetch_log WHERE kind = ? AND jst_date = ?",
				)
				.get(kind, jst(now).date)?.n ?? 0;
		if (used >= cap)
			throw new CapReached(`${kind} は本日の上限 ${cap} 回に達した`);
		if (!first) await deps.sleep(deps.limits.gapMs);
		first = false;
		db.query(
			"INSERT INTO fetch_log (run_id, kind, url, started_at, jst_date) VALUES (?, ?, ?, ?, ?)",
		).run(runId, kind, label, clock().toISOString(), jst(clock()).date);
		return call();
	};
}

type Geo = { address: string; lat: number | null; lon: number | null };

export async function runCommute(deps: CommuteDeps): Promise<CommuteSummary> {
	const { db, clock, log } = deps;
	const summary: CommuteSummary = { geocoded: 0, routed: 0 };
	const addresses = commuteTargets(db, deps.criteria, clock());
	const known = new Map(
		db
			.query<Geo, []>("SELECT address, lat, lon FROM geocodes")
			.all()
			.map((g) => [g.address, g]),
	);

	const geocodeGate = gate(deps, "geocode", deps.limits.geocodeDailyCap);
	try {
		for (const address of addresses.filter((a) => !known.has(a))) {
			const found = await geocodeGate(address, () => deps.geocode(address));
			db.query(
				"INSERT INTO geocodes (address, lat, lon, fetched_at) VALUES (?, ?, ?, ?)",
			).run(
				address,
				found?.lat ?? null,
				found?.lon ?? null,
				clock().toISOString(),
			);
			known.set(address, {
				address,
				lat: found?.lat ?? null,
				lon: found?.lon ?? null,
			});
			if (!found) log(`住所から座標が見つからない: ${address}`);
			summary.geocoded++;
		}
	} catch (error) {
		// 失敗した住所は記録せず、次の実行で調べ直す
		log(`座標の取得を止めた: ${(error as Error).message}`);
	}

	const { route, workplaces } = deps;
	if (!route || workplaces.length === 0) return summary;
	const done = new Set(
		db
			.query<{ id: string }, []>(
				"SELECT address || ' ' || workplace AS id FROM commutes",
			)
			.all()
			.map((r) => r.id),
	);
	const routeGate = gate(deps, "route", deps.limits.routeDailyCap);
	try {
		for (const address of addresses) {
			const geo = known.get(address);
			if (!geo || geo.lat === null || geo.lon === null) continue;
			const from = { lat: geo.lat, lon: geo.lon };
			for (const w of workplaces) {
				const key = workplaceKey(w);
				if (done.has(`${address} ${key}`)) continue;
				const found = await routeGate(`${address} → ${w.name}`, () =>
					route(from, w, arrivalTime(clock(), w.arrive_by)),
				);
				db.query(
					`INSERT INTO commutes (address, workplace, minutes, transfers, walk_min, lines, fetched_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).run(
					address,
					key,
					found?.minutes ?? null,
					found?.transfers ?? null,
					found?.walkMin ?? null,
					JSON.stringify(found?.lines ?? []),
					clock().toISOString(),
				);
				done.add(`${address} ${key}`);
				summary.routed++;
			}
		}
	} catch (error) {
		log(`通勤時間の取得を止めた: ${(error as Error).message}`);
	}
	return summary;
}

// 全員の職場までの時間が分かっているときだけ、いちばん長い人の時間を返す
export function maxCommute(
	db: Database,
	address: string,
	workplaces: Workplace[],
): number | null {
	if (workplaces.length === 0) return null;
	const keys = workplaces.map(workplaceKey);
	const rows = db
		.query<{ minutes: number | null }, string[]>(
			`SELECT minutes FROM commutes WHERE address = ? AND workplace IN (${keys.map(() => "?").join(", ")})`,
		)
		.all(address, ...keys);
	if (rows.length < keys.length || rows.some((r) => r.minutes === null))
		return null;
	return Math.max(...rows.map((r) => r.minutes ?? 0));
}
