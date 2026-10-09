import type { Database } from "bun:sqlite";
import type { Judgment, Station, UnitFlag, UnitStatus } from "../domain.ts";
import type { RoomImage } from "../fetch/parse.ts";
import { recordEvent } from "../store/listings.ts";

export const sortKeys = {
	new: "新着順",
	rent: "家賃が安い順",
	score: "スコア順",
	walk: "駅が近い順",
} as const;
export type SortKey = keyof typeof sortKeys;

export type UnitFilter = {
	status: UnitStatus | "active" | "all";
	judgment: Judgment | "none" | "all";
	sort: SortKey;
	// 家賃は管理費込みの円
	maxRent: number | null;
	minArea: number | null;
	maxWalk: number | null;
	maxAge: number | null;
	layouts: string[];
	station: string | null;
	withFlags: UnitFlag[];
	withoutFlags: UnitFlag[];
};

export const emptyFilter: UnitFilter = {
	status: "active",
	judgment: "all",
	sort: "new",
	maxRent: null,
	minArea: null,
	maxWalk: null,
	maxAge: null,
	layouts: [],
	station: null,
	withFlags: [],
	withoutFlags: [],
};

export type UnitRow = {
	unit_key: string;
	status: UnitStatus;
	judgment: Judgment | null;
	score: number | null;
	flags: string[];
	summary: string | null;
	memo: string | null;
	apply_approved: boolean;
	viewing_at: string | null;
	next_action: string | null;
	updated_at: string;
	listing_id: string;
	url: string;
	rent: number;
	admin_fee: number;
	deposit: number;
	key_money: number;
	layout: string;
	area_m2: number;
	built_age: number | null;
	built_ym: string | null;
	floor: number | null;
	building_name: string;
	address: string;
	stations: Station[];
	orientation: string | null;
	first_seen: string;
	listing_count: number;
	images: RoomImage[];
};

export type ListingRow = {
	listing_id: string;
	url: string;
	agent_name: string | null;
	rent: number;
	admin_fee: number;
	deposit: number;
	key_money: number;
	first_seen: string;
	last_seen: string;
	missing_runs: number;
	features: string[];
	other_costs: string | null;
	guarantor: string | null;
	building_floors: string | null;
	property_type: string | null;
	images: RoomImage[];
};

export type EventRow = {
	id: number;
	type: string;
	from_status: string | null;
	to_status: string | null;
	actor: "system" | "human";
	at: string;
	detail: unknown;
};

type RawUnitRow = Omit<
	UnitRow,
	"flags" | "stations" | "apply_approved" | "images"
> & {
	images: string;
	flags: string;
	stations: string;
	apply_approved: number;
};

const orderBy: Record<SortKey, string> = {
	new: "r.first_seen DESC",
	rent: "r.rent + r.admin_fee ASC",
	score: "score IS NULL, score DESC",
	walk: "min_walk IS NULL, min_walk ASC",
};

// 部屋ごとに、家賃+管理費が最も安い掲載を代表として出す
const unitSelect = `
	WITH ranked AS (
		SELECT l.*,
			ROW_NUMBER() OVER (PARTITION BY unit_key ORDER BY rent + admin_fee, last_seen DESC, listing_id) AS rn,
			COUNT(*) OVER (PARTITION BY unit_key) AS listing_count
		FROM listings l
	)
	SELECT u.unit_key, u.status, u.judgment, u.base_score + COALESCE(u.adj_score, 0) AS score, u.flags, u.summary, u.memo,
		u.apply_approved, u.viewing_at, u.next_action, u.updated_at,
		r.listing_id, r.url, r.rent, r.admin_fee, r.deposit, r.key_money, r.layout, r.area_m2, r.built_age, r.built_ym,
		r.floor, r.building_name, r.address, r.stations, r.orientation, r.first_seen, r.listing_count, r.images,
		(SELECT MIN(json_extract(value, '$.walkMin')) FROM json_each(r.stations)) AS min_walk
	FROM units u JOIN ranked r ON r.unit_key = u.unit_key AND r.rn = 1`;

const toUnit = (raw: RawUnitRow & { min_walk?: number | null }): UnitRow => {
	const {
		flags,
		stations,
		apply_approved,
		images,
		min_walk: _minWalk,
		...rest
	} = raw;
	return {
		...rest,
		flags: JSON.parse(flags),
		images: JSON.parse(images),
		stations: JSON.parse(stations),
		apply_approved: apply_approved === 1,
	};
};

const minWalkSql =
	"(SELECT MIN(json_extract(value, '$.walkMin')) FROM json_each(r.stations))";

// 築年月があればそこから、無ければ一覧の築年数を使う
const ageSql =
	"COALESCE($year - CAST(substr(r.built_ym, 1, 4) AS INTEGER), r.built_age)";

export function listUnits(
	db: Database,
	filter: UnitFilter,
	year: number,
	limit = 300,
): UnitRow[] {
	const where: string[] = [];
	const params: Record<string, string | number> = {};
	const bind = (name: string, value: string | number): string => {
		params[name] = value;
		return `$${name}`;
	};
	if (filter.status === "active") where.push("u.status != '見送り'");
	else if (filter.status !== "all")
		where.push(`u.status = ${bind("status", filter.status)}`);
	if (filter.judgment === "none") where.push("u.judgment IS NULL");
	else if (filter.judgment !== "all")
		where.push(`u.judgment = ${bind("judgment", filter.judgment)}`);
	if (filter.maxRent !== null)
		where.push(`r.rent + r.admin_fee <= ${bind("maxRent", filter.maxRent)}`);
	if (filter.minArea !== null)
		where.push(`r.area_m2 >= ${bind("minArea", filter.minArea)}`);
	if (filter.maxWalk !== null)
		where.push(`${minWalkSql} <= ${bind("maxWalk", filter.maxWalk)}`);
	if (filter.maxAge !== null) {
		bind("year", year);
		where.push(`${ageSql} <= ${bind("maxAge", filter.maxAge)}`);
	}
	if (filter.layouts.length > 0) {
		where.push(
			`r.layout IN (${filter.layouts.map((l, i) => bind(`layout${i}`, l)).join(", ")})`,
		);
	}
	if (filter.station !== null) {
		where.push(
			`EXISTS (SELECT 1 FROM json_each(r.stations) WHERE json_extract(value, '$.station') = ${bind("station", filter.station)})`,
		);
	}
	filter.withFlags.forEach((flag, i) => {
		where.push(
			`EXISTS (SELECT 1 FROM json_each(u.flags) WHERE value = ${bind(`with${i}`, flag)})`,
		);
	});
	filter.withoutFlags.forEach((flag, i) => {
		where.push(
			`NOT EXISTS (SELECT 1 FROM json_each(u.flags) WHERE value = ${bind(`without${i}`, flag)})`,
		);
	});
	const sql = `${unitSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy[filter.sort]} LIMIT ${limit}`;
	return db
		.query<RawUnitRow, [Record<string, string | number>]>(sql)
		.all(params)
		.map(toUnit);
}

export type FilterOptions = { layouts: string[]; stations: string[] };

// 選択肢は実際に集めた部屋から作る。見送りの部屋しか無い間取りや駅は出さない
export function filterOptions(db: Database): FilterOptions {
	const layouts = db
		.query<{ layout: string }, []>(
			`SELECT l.layout FROM listings l JOIN units u ON u.unit_key = l.unit_key WHERE u.status != '見送り'
			GROUP BY l.layout ORDER BY COUNT(DISTINCT l.unit_key) DESC`,
		)
		.all()
		.map((r) => r.layout);
	const stations = db
		.query<{ station: string }, []>(
			`SELECT json_extract(s.value, '$.station') AS station FROM listings l JOIN units u ON u.unit_key = l.unit_key,
				json_each(l.stations) s
			WHERE u.status != '見送り' GROUP BY station ORDER BY COUNT(DISTINCT l.unit_key) DESC, station`,
		)
		.all()
		.map((r) => r.station);
	return { layouts, stations };
}

export function countByStatus(db: Database): Map<string, number> {
	const rows = db
		.query<{ status: string; n: number }, []>(
			"SELECT status, COUNT(*) AS n FROM units GROUP BY status",
		)
		.all();
	return new Map(rows.map((r) => [r.status, r.n]));
}

export function getUnit(db: Database, key: string): UnitRow | null {
	const row = db
		.query<RawUnitRow, [string]>(`${unitSelect} WHERE u.unit_key = ?`)
		.get(key);
	return row ? toUnit(row) : null;
}

export function getListings(db: Database, key: string): ListingRow[] {
	return db
		.query<
			Omit<ListingRow, "features" | "images"> & {
				features: string | null;
				images: string;
			},
			[string]
		>(
			`SELECT listing_id, url, agent_name, rent, admin_fee, deposit, key_money, first_seen, last_seen, missing_runs,
				features, other_costs, guarantor, building_floors, property_type, images
			FROM listings WHERE unit_key = ? ORDER BY rent + admin_fee, last_seen DESC, listing_id`,
		)
		.all(key)
		.map((l) => ({
			...l,
			features: l.features ? JSON.parse(l.features) : [],
			images: JSON.parse(l.images),
		}));
}

export function getEvents(db: Database, key: string): EventRow[] {
	return db
		.query<Omit<EventRow, "detail"> & { detail: string | null }, [string]>(
			"SELECT id, type, from_status, to_status, actor, at, detail FROM events WHERE unit_key = ? ORDER BY id DESC LIMIT 100",
		)
		.all(key)
		.map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
}

// 判定・メモ・申込の承認は人だけが書く列なので、変更はすべて actor=human で記録する
export function setJudgment(
	db: Database,
	key: string,
	judgment: Judgment | null,
	at: string,
): boolean {
	return db.transaction(() => {
		const current = db
			.query<{ judgment: string | null }, [string]>(
				"SELECT judgment FROM units WHERE unit_key = ?",
			)
			.get(key);
		if (!current) return false;
		if (current.judgment === judgment) return true;
		db.query(
			"UPDATE units SET judgment = ?, updated_at = ? WHERE unit_key = ?",
		).run(judgment, at, key);
		recordEvent(db, {
			unitKey: key,
			type: "judgment",
			actor: "human",
			at,
			detail: { from: current.judgment, to: judgment },
		});
		return true;
	})();
}

export function setMemo(
	db: Database,
	key: string,
	memo: string,
	at: string,
): boolean {
	return db.transaction(() => {
		const changed = db
			.query("UPDATE units SET memo = ?, updated_at = ? WHERE unit_key = ?")
			.run(memo || null, at, key);
		if (changed.changes === 0) return false;
		recordEvent(db, { unitKey: key, type: "memo", actor: "human", at });
		return true;
	})();
}

// 申込の承認は取り消せない操作の入口なので、内見済の部屋に限る (仕様 4章)
export function approveApplication(
	db: Database,
	key: string,
	at: string,
): "ok" | "not_found" | "invalid_status" {
	return db.transaction(() => {
		const unit = db
			.query<{ status: string }, [string]>(
				"SELECT status FROM units WHERE unit_key = ?",
			)
			.get(key);
		if (!unit) return "not_found";
		if (unit.status !== "内見済") return "invalid_status";
		db.query(
			"UPDATE units SET apply_approved = 1, updated_at = ? WHERE unit_key = ?",
		).run(at, key);
		recordEvent(db, {
			unitKey: key,
			type: "apply_approved",
			actor: "human",
			at,
		});
		return "ok";
	})();
}

export function getImageUrl(
	db: Database,
	listingId: string,
	index: number,
): string | null {
	const row = db
		.query<{ images: string }, [string]>(
			"SELECT images FROM listings WHERE listing_id = ?",
		)
		.get(listingId);
	if (!row) return null;
	return (JSON.parse(row.images) as RoomImage[])[index]?.url ?? null;
}
