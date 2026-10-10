import type { Database } from "bun:sqlite";
import { type Workplace, workplaceKey } from "../commute/workplace.ts";
import type { Judgment, Station, UnitFlag, UnitStatus } from "../domain.ts";
import type { RoomImage } from "../fetch/parse.ts";
import { recordEvent } from "../store/listings.ts";

export const sortKeys = {
	new: "新着順",
	rent: "家賃が安い順",
	score: "スコア順",
	walk: "駅が近い順",
	commute: "通勤が短い順",
} as const;
export type SortKey = keyof typeof sortKeys;

// none は誰も判定していない部屋、mine_none は自分が判定していない部屋、split は判定が分かれている部屋。
// ◎○× は誰かがその判定を付けた部屋
export const judgmentFilters = [
	"all",
	"none",
	"mine_none",
	"split",
	"◎",
	"○",
	"×",
] as const;
export type JudgmentFilter = (typeof judgmentFilters)[number];

export type UnitFilter = {
	status: UnitStatus | "active" | "all";
	judgment: JudgmentFilter;
	sort: SortKey;
	// 家賃は管理費込みの円
	maxRent: number | null;
	minArea: number | null;
	maxWalk: number | null;
	maxAge: number | null;
	// いちばん長い人の通勤時間 (分)。全員分が分かっている部屋だけが残る
	maxCommute: number | null;
	layouts: string[];
	station: string | null;
	withFlags: UnitFlag[];
	withoutFlags: UnitFlag[];
	// SUUMO の「部屋の特徴・設備」の表記。選んだものをすべて備えた部屋だけを出す
	features: string[];
};

export const emptyFilter: UnitFilter = {
	status: "active",
	judgment: "all",
	sort: "new",
	maxRent: null,
	minArea: null,
	maxWalk: null,
	maxAge: null,
	maxCommute: null,
	layouts: [],
	station: null,
	withFlags: [],
	withoutFlags: [],
	features: [],
};

export type UnitRow = {
	unit_key: string;
	status: UnitStatus;
	score: number | null;
	flags: string[];
	summary: string | null;
	evaluations: Evaluation[];
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
	// 住所の町丁目の代表点。調べていない・見つからなければ null
	lat: number | null;
	lon: number | null;
	commutes: Commute[];
	max_commute: number | null;
};

export type Commute = {
	workplace: string;
	minutes: number | null;
	transfers: number | null;
	walk_min: number | null;
	lines: string[];
};

// 判定とメモは人ごとに持つ。person は Cloudflare Access のメールアドレス (開発時は local)
export type Evaluation = {
	person: string;
	judgment: Judgment | null;
	memo: string | null;
	updated_at: string;
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
	| "flags"
	| "stations"
	| "apply_approved"
	| "images"
	| "evaluations"
	| "commutes"
> & {
	commutes: string;
	evaluations: string;
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
	commute: "max_commute IS NULL, max_commute ASC",
};

// 職場のキーは設定から作る数字と記号だけなので、SQL に埋め込める
const KEY_FORMAT = /^-?\d+\.\d+,-?\d+\.\d+@\d{2}:\d{2}$/;
function maxCommuteSql(workplaces: Workplace[]): string {
	const keys = workplaces.map(workplaceKey);
	if (keys.length === 0 || keys.some((k) => !KEY_FORMAT.test(k))) return "NULL";
	return `(SELECT CASE WHEN COUNT(c.minutes) = ${keys.length} THEN MAX(c.minutes) END
		FROM commutes c WHERE c.address = r.address AND c.workplace IN (${keys.map((k) => `'${k}'`).join(", ")}))`;
}

// 部屋ごとに、家賃+管理費が最も安い掲載を代表として出す
const unitSelect = (workplaces: Workplace[]) => `
	WITH ranked AS (
		SELECT l.*,
			ROW_NUMBER() OVER (PARTITION BY unit_key ORDER BY rent + admin_fee, last_seen DESC, listing_id) AS rn,
			COUNT(*) OVER (PARTITION BY unit_key) AS listing_count
		FROM listings l
	)
	SELECT u.unit_key, u.status, u.base_score + COALESCE(u.adj_score, 0) AS score, u.flags, u.summary,
		(SELECT json_group_array(json_object('person', e.person, 'judgment', e.judgment, 'memo', e.memo, 'updated_at', e.updated_at))
			FROM evaluations e WHERE e.unit_key = u.unit_key) AS evaluations,
		u.apply_approved, u.viewing_at, u.next_action, u.updated_at,
		r.listing_id, r.url, r.rent, r.admin_fee, r.deposit, r.key_money, r.layout, r.area_m2, r.built_age, r.built_ym,
		r.floor, r.building_name, r.address, r.stations, r.orientation, r.first_seen, r.listing_count, r.images,
		(SELECT MIN(json_extract(value, '$.walkMin')) FROM json_each(r.stations)) AS min_walk,
		g.lat, g.lon,
		(SELECT json_group_array(json_object('workplace', c.workplace, 'minutes', c.minutes, 'transfers', c.transfers,
			'walk_min', c.walk_min, 'lines', json(c.lines))) FROM commutes c WHERE c.address = r.address) AS commutes,
		${maxCommuteSql(workplaces)} AS max_commute
	FROM units u JOIN ranked r ON r.unit_key = u.unit_key AND r.rn = 1
	LEFT JOIN geocodes g ON g.address = r.address`;

const toUnit = (raw: RawUnitRow & { min_walk?: number | null }): UnitRow => {
	const {
		flags,
		stations,
		apply_approved,
		images,
		evaluations,
		commutes,
		min_walk: _minWalk,
		...rest
	} = raw;
	return {
		...rest,
		commutes: JSON.parse(commutes),
		evaluations: JSON.parse(evaluations),
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
	person: string,
	workplaces: Workplace[] = [],
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
	const judged =
		"SELECT 1 FROM evaluations e WHERE e.unit_key = u.unit_key AND e.judgment IS NOT NULL";
	if (filter.judgment === "none") where.push(`NOT EXISTS (${judged})`);
	else if (filter.judgment === "mine_none")
		where.push(`NOT EXISTS (${judged} AND e.person = ${bind("me", person)})`);
	else if (filter.judgment === "split")
		where.push(
			"(SELECT COUNT(DISTINCT e.judgment) FROM evaluations e WHERE e.unit_key = u.unit_key AND e.judgment IS NOT NULL) > 1",
		);
	else if (filter.judgment !== "all")
		where.push(
			`EXISTS (${judged} AND e.judgment = ${bind("judgment", filter.judgment)})`,
		);
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
	if (filter.maxCommute !== null)
		where.push(
			`${maxCommuteSql(workplaces)} <= ${bind("maxCommute", filter.maxCommute)}`,
		);
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
	// 設備は詳細を取得した掲載にしか無いので、部屋のどれかの掲載が備えていればよい
	filter.features.forEach((feature, i) => {
		where.push(
			`EXISTS (SELECT 1 FROM listings fl, json_each(fl.features) f WHERE fl.unit_key = u.unit_key AND f.value = ${bind(`feature${i}`, feature)})`,
		);
	});
	const sql = `${unitSelect(workplaces)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy[filter.sort]} LIMIT ${limit}`;
	return db
		.query<RawUnitRow, [Record<string, string | number>]>(sql)
		.all(params)
		.map(toUnit);
}

export type FilterOptions = {
	layouts: string[];
	stations: string[];
	features: string[];
};

// 選択肢は実際に集めた部屋から作る。状態で「すべて」や「見送り」も選べるので、見送りの部屋も含める
export function filterOptions(db: Database): FilterOptions {
	const list = (sql: string) =>
		db
			.query<{ value: string }, []>(sql)
			.all()
			.map((r) => r.value);
	return {
		layouts: list(
			"SELECT layout AS value FROM listings GROUP BY layout ORDER BY COUNT(DISTINCT unit_key) DESC",
		),
		stations: list(
			`SELECT json_extract(s.value, '$.station') AS value FROM listings l, json_each(l.stations) s
			GROUP BY value ORDER BY COUNT(DISTINCT l.unit_key) DESC, value`,
		),
		features: list(
			`SELECT f.value AS value FROM listings l, json_each(l.features) f
			GROUP BY value ORDER BY COUNT(DISTINCT l.unit_key) DESC, value`,
		),
	};
}

export function countByStatus(db: Database): Map<string, number> {
	const rows = db
		.query<{ status: string; n: number }, []>(
			"SELECT status, COUNT(*) AS n FROM units GROUP BY status",
		)
		.all();
	return new Map(rows.map((r) => [r.status, r.n]));
}

export function getUnit(
	db: Database,
	key: string,
	workplaces: Workplace[] = [],
): UnitRow | null {
	const row = db
		.query<RawUnitRow, [string]>(
			`${unitSelect(workplaces)} WHERE u.unit_key = ?`,
		)
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

const unitExists = (db: Database, key: string): boolean =>
	db
		.query<{ n: number }, [string]>(
			"SELECT 1 AS n FROM units WHERE unit_key = ?",
		)
		.get(key) !== null;

const evaluationOf = (db: Database, key: string, person: string) =>
	db
		.query<{ judgment: string | null; memo: string | null }, [string, string]>(
			"SELECT judgment, memo FROM evaluations WHERE unit_key = ? AND person = ?",
		)
		.get(key, person);

// 判定とメモは人が書く列。誰がいつ何を変えたかを Claude のセッションから追えるよう、変更前の値も履歴に残す
export function setJudgment(
	db: Database,
	key: string,
	person: string,
	judgment: Judgment | null,
	at: string,
): boolean {
	return db.transaction(() => {
		if (!unitExists(db, key)) return false;
		const before = evaluationOf(db, key, person)?.judgment ?? null;
		if (before === judgment) return true;
		db.query(
			`INSERT INTO evaluations (unit_key, person, judgment, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (unit_key, person) DO UPDATE SET judgment = excluded.judgment, updated_at = excluded.updated_at`,
		).run(key, person, judgment, at);
		recordEvent(db, {
			unitKey: key,
			type: "judgment",
			actor: "human",
			at,
			detail: { person, from: before, to: judgment },
		});
		return true;
	})();
}

export function setMemo(
	db: Database,
	key: string,
	person: string,
	memo: string,
	at: string,
): boolean {
	return db.transaction(() => {
		if (!unitExists(db, key)) return false;
		const before = evaluationOf(db, key, person)?.memo ?? null;
		const next = memo.trim() === "" ? null : memo;
		if (before === next) return true;
		db.query(
			`INSERT INTO evaluations (unit_key, person, memo, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (unit_key, person) DO UPDATE SET memo = excluded.memo, updated_at = excluded.updated_at`,
		).run(key, person, next, at);
		recordEvent(db, {
			unitKey: key,
			type: "memo",
			actor: "human",
			at,
			detail: { person, before },
		});
		return true;
	})();
}

// 申込の承認は取り消せない操作の入口なので、内見済の部屋に限る (仕様 4章)
export function approveApplication(
	db: Database,
	key: string,
	person: string,
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
			detail: { person },
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
