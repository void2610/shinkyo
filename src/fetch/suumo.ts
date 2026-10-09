import type { Database } from "bun:sqlite";
import type { FetchPolicy } from "../config.ts";
import { getState, setState } from "../store/db.ts";
import { type Clock, inHourRange, jst } from "../time.ts";
import { looksLikeCaptcha, SUUMO_ORIGIN } from "./parse.ts";
import { isAllowed, parseRobots } from "./robots.ts";

// UA は偽装もローテーションもしない (仕様 7章)
export const USER_AGENT = "shinkyo/0.1 (personal rental search; low-frequency)";

export type StopReason =
	| "paused"
	| "outside_hours"
	| "stopped_today"
	| "daily_cap"
	| "robots"
	| "blocked";

export class FetchStopped extends Error {
	constructor(
		readonly reason: StopReason,
		message: string,
	) {
		super(message);
		this.name = "FetchStopped";
	}
}

export type HttpClientDeps = {
	db: Database;
	policy: FetchPolicy;
	runId: string;
	clock: Clock;
	sleep: (ms: number) => Promise<void>;
	random: () => number;
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
};

export type FetchResult = { status: number; body: string; logId: number };

const STOPPED_ON = "fetch.stopped_on";
const LAST_REQUEST_AT = "fetch.last_request_at";
const ROBOTS = "fetch.robots";

// SUUMO へのリクエストはすべてこのクラスを通す。間隔・上限・robots.txt・停止条件をここで強制する
export class HttpClient {
	constructor(private readonly deps: HttpClientDeps) {}

	async get(url: string): Promise<FetchResult> {
		if (new URL(url).origin !== SUUMO_ORIGIN)
			throw new Error(`SUUMO 以外の URL は取得しない: ${url}`);
		this.assertRunnable();
		if (!isAllowed(parseRobots(await this.robotsTxt(), USER_AGENT), url)) {
			throw new FetchStopped("robots", `robots.txt で除外されている: ${url}`);
		}
		return this.request(url);
	}

	requestsToday(): number {
		const today = jst(this.deps.clock()).date;
		return (
			this.deps.db
				.query<{ n: number }, [string]>(
					"SELECT COUNT(*) AS n FROM fetch_log WHERE jst_date = ?",
				)
				.get(today)?.n ?? 0
		);
	}

	recordItems(logId: number, items: number): void {
		this.deps.db
			.query("UPDATE fetch_log SET items = ? WHERE id = ?")
			.run(items, logId);
	}

	private assertRunnable(): void {
		const { db, policy, clock } = this.deps;
		const now = jst(clock());
		if (policy.paused)
			throw new FetchStopped("paused", "policy.paused が true");
		if (!inHourRange(now.minutes, policy.active_hours)) {
			throw new FetchStopped("outside_hours", "active_hours の外");
		}
		if (getState(db, STOPPED_ON) === now.date) {
			throw new FetchStopped("stopped_today", "今日の取得は停止済み");
		}
		if (this.requestsToday() >= policy.daily_request_cap) {
			throw new FetchStopped(
				"daily_cap",
				`1日の上限 ${policy.daily_request_cap} 回に達した`,
			);
		}
	}

	private async robotsTxt(): Promise<string> {
		const today = jst(this.deps.clock()).date;
		const cached = getState(this.deps.db, ROBOTS);
		if (cached) {
			const { date, body } = JSON.parse(cached) as {
				date: string;
				body: string;
			};
			if (date === today) return body;
		}
		const res = await this.request(`${SUUMO_ORIGIN}/robots.txt`);
		// 4xx は制限なし、5xx は全面禁止として扱う (RFC 9309)
		const body =
			res.status >= 500
				? "User-agent: *\nDisallow: /"
				: res.status >= 400
					? ""
					: res.body;
		setState(this.deps.db, ROBOTS, JSON.stringify({ date: today, body }));
		return body;
	}

	private async waitGap(): Promise<void> {
		const { db, policy, clock, sleep, random } = this.deps;
		const last = Number(getState(db, LAST_REQUEST_AT) ?? 0);
		const gapMs =
			(policy.request_gap_sec + random() * policy.jitter_sec) * 1000;
		const waitMs = last + gapMs - clock().getTime();
		if (waitMs > 0) await sleep(waitMs);
	}

	private async request(url: string): Promise<FetchResult> {
		const { db, policy, clock, runId, fetchImpl } = this.deps;
		this.assertRunnable();
		await this.waitGap();
		const startedAt = clock();
		setState(db, LAST_REQUEST_AT, String(startedAt.getTime()));
		const insert = db.query<{ id: number }, [string, string, string, string]>(
			"INSERT INTO fetch_log (run_id, url, started_at, jst_date) VALUES (?, ?, ?, ?) RETURNING id",
		);
		const logId =
			insert.get(runId, url, startedAt.toISOString(), jst(startedAt).date)
				?.id ?? 0;
		let res: Response;
		let body: string;
		try {
			res = await fetchImpl(url, {
				headers: { "user-agent": USER_AGENT },
				redirect: "follow",
			});
			body = await res.text();
		} catch (error) {
			db.query("UPDATE fetch_log SET error = ? WHERE id = ?").run(
				String(error),
				logId,
			);
			throw error;
		}
		db.query("UPDATE fetch_log SET status_code = ? WHERE id = ?").run(
			res.status,
			logId,
		);
		const blocked =
			policy.stop_on_status.includes(res.status) || looksLikeCaptcha(body);
		if (blocked) {
			const reason = looksLikeCaptcha(body)
				? "CAPTCHA の兆候"
				: `HTTP ${res.status}`;
			db.query("UPDATE fetch_log SET error = ? WHERE id = ?").run(
				reason,
				logId,
			);
			setState(db, STOPPED_ON, jst(startedAt).date);
			throw new FetchStopped(
				"blocked",
				`${reason} のため今日の取得を止めた: ${url}`,
			);
		}
		return { status: res.status, body, logId };
	}
}
