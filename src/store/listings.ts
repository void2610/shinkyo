import type { Database } from "bun:sqlite";
import type { UnitFlag } from "../domain.ts";
import type { ListedRoom, RoomDetail } from "../fetch/parse.ts";
import { isMergeCandidate, type UnitKeySource, unitKey } from "../unit-key.ts";

export type UpsertResult =
	| { kind: "new"; unitKey: string; newUnit: boolean }
	| {
			kind: "updated";
			unitKey: string;
			priceDrop: { from: number; to: number } | null;
	  };

type ListingRow = {
	listing_id: string;
	rent: number;
	admin_fee: number;
	unit_key: string;
};

type KeySourceRow = {
	unit_key: string;
	building_name: string;
	address: string;
	floor: number | null;
	area_m2: number;
	layout: string;
	rent: number;
};

const toKeySource = (r: KeySourceRow): UnitKeySource => ({
	buildingName: r.building_name,
	address: r.address,
	floor: r.floor,
	areaM2: r.area_m2,
	layout: r.layout,
	rent: r.rent,
});

export function findListing(
	db: Database,
	listingId: string,
): ListingRow | null {
	return db
		.query<ListingRow, [string]>(
			"SELECT listing_id, rent, admin_fee, unit_key FROM listings WHERE listing_id = ?",
		)
		.get(listingId);
}

export function recordEvent(
	db: Database,
	e: {
		unitKey: string;
		type: string;
		actor: "system" | "human";
		at: string;
		fromStatus?: string | null;
		toStatus?: string | null;
		detail?: unknown;
	},
): void {
	db.query(
		"INSERT INTO events (unit_key, type, from_status, to_status, actor, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		e.unitKey,
		e.type,
		e.fromStatus ?? null,
		e.toStatus ?? null,
		e.actor,
		e.at,
		e.detail === undefined ? null : JSON.stringify(e.detail),
	);
}

export function setFlag(
	db: Database,
	key: string,
	flag: UnitFlag,
	on: boolean,
	at: string,
): boolean {
	const row = db
		.query<{ flags: string }, [string]>(
			"SELECT flags FROM units WHERE unit_key = ?",
		)
		.get(key);
	if (!row) return false;
	const flags = new Set(JSON.parse(row.flags) as string[]);
	if (flags.has(flag) === on) return false;
	if (on) flags.add(flag);
	else flags.delete(flag);
	db.query("UPDATE units SET flags = ?, updated_at = ? WHERE unit_key = ?").run(
		JSON.stringify([...flags]),
		at,
		key,
	);
	recordEvent(db, {
		unitKey: key,
		type: on ? "flag_on" : "flag_off",
		actor: "system",
		at,
		detail: { flag },
	});
	return true;
}

function ensureUnit(
	db: Database,
	key: string,
	source: UnitKeySource,
	at: string,
): boolean {
	const inserted = db
		.query(
			"INSERT INTO units (unit_key, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
		)
		.run(key, at, at);
	if (inserted.changes === 0) return false;
	recordEvent(db, {
		unitKey: key,
		type: "created",
		actor: "system",
		at,
		toStatus: "新着",
	});
	const others = db
		.query<KeySourceRow, [string, number | null, string]>(
			"SELECT unit_key, building_name, address, floor, area_m2, layout, rent FROM listings WHERE unit_key != ? AND floor IS ? AND layout = ?",
		)
		.all(key, source.floor, source.layout);
	for (const other of others) {
		if (!isMergeCandidate(source, toKeySource(other))) continue;
		setFlag(db, key, "統合候補", true, at);
		setFlag(db, other.unit_key, "統合候補", true, at);
	}
	return true;
}

export function upsertListing(
	db: Database,
	room: ListedRoom,
	searchId: string,
	at: string,
): UpsertResult {
	const key = unitKey(room);
	const existing = findListing(db, room.listingId);
	if (!existing) {
		db.query(
			`INSERT INTO listings (listing_id, url, search_id, first_seen, last_seen, is_new_arrival, rent, admin_fee, deposit,
				key_money, layout, area_m2, built_age, floor, building_floors, building_name, property_type, address, stations, images, unit_key)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			room.listingId,
			room.url,
			searchId,
			at,
			at,
			room.isNewArrival ? 1 : 0,
			room.rent,
			room.adminFee,
			room.deposit,
			room.keyMoney,
			room.layout,
			room.areaM2,
			room.builtAge,
			room.floor,
			room.buildingFloors,
			room.buildingName,
			room.propertyType,
			room.address,
			JSON.stringify(room.stations),
			JSON.stringify(room.images),
			key,
		);
		const newUnit = ensureUnit(db, key, room, at);
		if (!newUnit)
			recordEvent(db, {
				unitKey: key,
				type: "listing_added",
				actor: "system",
				at,
				detail: { listingId: room.listingId },
			});
		return { kind: "new", unitKey: key, newUnit };
	}
	const before = existing.rent + existing.admin_fee;
	const after = room.rent + room.adminFee;
	db.query(
		// 説明付きの画像は詳細ページからしか取れないので、詳細を取得した後は一覧の画像で上書きしない
		`UPDATE listings SET last_seen = ?, missing_runs = 0, is_new_arrival = ?, rent = ?, admin_fee = ?, deposit = ?, key_money = ?,
			images = CASE WHEN detail_fetched_at IS NULL THEN ? ELSE images END
		WHERE listing_id = ?`,
	).run(
		at,
		room.isNewArrival ? 1 : 0,
		room.rent,
		room.adminFee,
		room.deposit,
		room.keyMoney,
		JSON.stringify(room.images),
		room.listingId,
	);
	refreshEndedFlag(db, existing.unit_key, at);
	if (after < before) {
		setFlag(db, existing.unit_key, "値下げ", true, at);
		recordEvent(db, {
			unitKey: existing.unit_key,
			type: "price_drop",
			actor: "system",
			at,
			detail: { from: before, to: after },
		});
		return {
			kind: "updated",
			unitKey: existing.unit_key,
			priceDrop: { from: before, to: after },
		};
	}
	if (after !== before) {
		recordEvent(db, {
			unitKey: existing.unit_key,
			type: "price_change",
			actor: "system",
			at,
			detail: { from: before, to: after },
		});
	}
	return { kind: "updated", unitKey: existing.unit_key, priceDrop: null };
}

// 別の業者の掲載が残っていれば部屋はまだ募集中とみなし、全掲載が消えたときだけ旗を立てる
function refreshEndedFlag(db: Database, key: string, at: string): void {
	const row = db
		.query<{ total: number; gone: number }, [string]>(
			"SELECT COUNT(*) AS total, SUM(missing_runs >= 2) AS gone FROM listings WHERE unit_key = ?",
		)
		.get(key);
	if (!row || row.total === 0) return;
	setFlag(db, key, "掲載終了の可能性", row.gone === row.total, at);
}

export function markMissing(
	db: Database,
	searchId: string,
	seenIds: Set<string>,
	at: string,
): string[] {
	const rows = db
		.query<{ listing_id: string; unit_key: string }, [string]>(
			"SELECT listing_id, unit_key FROM listings WHERE search_id = ?",
		)
		.all(searchId);
	const touched = new Set<string>();
	for (const row of rows) {
		if (seenIds.has(row.listing_id)) continue;
		db.query(
			"UPDATE listings SET missing_runs = missing_runs + 1 WHERE listing_id = ?",
		).run(row.listing_id);
		touched.add(row.unit_key);
	}
	for (const key of touched) refreshEndedFlag(db, key, at);
	return [...touched];
}

export function listingsWithoutDetail(
	db: Database,
): { listing_id: string; url: string }[] {
	return db
		.query<{ listing_id: string; url: string }, []>(
			"SELECT listing_id, url FROM listings WHERE detail_fetched_at IS NULL AND missing_runs = 0 ORDER BY first_seen",
		)
		.all();
}

export function applyDetail(
	db: Database,
	listingId: string,
	detail: RoomDetail,
	rawPath: string,
	at: string,
): void {
	db.query(
		`UPDATE listings SET agent_name = ?, built_ym = ?, orientation = ?, features = ?, other_costs = ?, guarantor = ?, notes = ?,
			images = CASE WHEN ? = '[]' THEN images ELSE ? END, raw_path = ?, detail_fetched_at = ? WHERE listing_id = ?`,
	).run(
		detail.agentName,
		detail.builtYm,
		detail.orientation,
		JSON.stringify(detail.features),
		detail.otherCosts,
		detail.guarantor,
		detail.notes,
		JSON.stringify(detail.images),
		JSON.stringify(detail.images),
		rawPath || null,
		at,
		listingId,
	);
}
