import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 添字 + 1 が PRAGMA user_version に対応する。既存の要素は書き換えず、末尾に足す
const migrations: string[] = [
	`
	CREATE TABLE listings (
		listing_id TEXT PRIMARY KEY,
		url TEXT NOT NULL,
		search_id TEXT NOT NULL,
		first_seen TEXT NOT NULL,
		last_seen TEXT NOT NULL,
		missing_runs INTEGER NOT NULL DEFAULT 0,
		is_new_arrival INTEGER NOT NULL DEFAULT 0,
		rent INTEGER NOT NULL,
		admin_fee INTEGER NOT NULL,
		deposit INTEGER NOT NULL,
		key_money INTEGER NOT NULL,
		layout TEXT NOT NULL,
		area_m2 REAL NOT NULL,
		built_age INTEGER,
		built_ym TEXT,
		floor INTEGER,
		building_floors TEXT,
		building_name TEXT NOT NULL,
		property_type TEXT,
		address TEXT NOT NULL,
		stations TEXT NOT NULL,
		agent_name TEXT,
		orientation TEXT,
		features TEXT,
		other_costs TEXT,
		guarantor TEXT,
		detail_fetched_at TEXT,
		raw_path TEXT,
		unit_key TEXT NOT NULL
	);
	CREATE INDEX listings_unit_key ON listings(unit_key);
	CREATE INDEX listings_search_id ON listings(search_id);

	CREATE TABLE units (
		unit_key TEXT PRIMARY KEY,
		status TEXT NOT NULL DEFAULT '新着',
		judgment TEXT,
		base_score REAL,
		adj_score REAL,
		flags TEXT NOT NULL DEFAULT '[]',
		summary TEXT,
		memo TEXT,
		apply_approved INTEGER NOT NULL DEFAULT 0,
		agent_id TEXT,
		viewing_at TEXT,
		next_action TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE agents (
		agent_id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		email TEXT,
		role TEXT NOT NULL,
		median_reply_min REAL,
		redirect_count INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE messages (
		gmail_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		direction TEXT NOT NULL,
		agent_id TEXT,
		unit_keys TEXT NOT NULL DEFAULT '[]',
		category TEXT,
		extracted TEXT,
		action TEXT NOT NULL,
		template_id TEXT,
		created_at TEXT NOT NULL
	);

	CREATE TABLE events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		unit_key TEXT NOT NULL,
		type TEXT NOT NULL,
		from_status TEXT,
		to_status TEXT,
		actor TEXT NOT NULL,
		at TEXT NOT NULL,
		detail TEXT
	);
	CREATE INDEX events_unit_key ON events(unit_key);

	CREATE TABLE fetch_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id TEXT NOT NULL,
		url TEXT NOT NULL,
		status_code INTEGER,
		items INTEGER,
		started_at TEXT NOT NULL,
		jst_date TEXT NOT NULL,
		error TEXT
	);
	CREATE INDEX fetch_log_jst_date ON fetch_log(jst_date);

	CREATE TABLE state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`,
];

export function migrate(db: Database): void {
	const current =
		db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version ?? 0;
	migrations.slice(current).forEach((sql, i) => {
		db.transaction(() => {
			db.exec(sql);
			db.exec(`PRAGMA user_version = ${current + i + 1}`);
		})();
	});
}

export function openDb(path = "data/shinkyo.db"): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
	migrate(db);
	return db;
}

export function getState(db: Database, key: string): string | null {
	return (
		db
			.query<{ value: string }, [string]>(
				"SELECT value FROM state WHERE key = ?",
			)
			.get(key)?.value ?? null
	);
}

export function setState(db: Database, key: string, value: string): void {
	db.query(
		"INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}
