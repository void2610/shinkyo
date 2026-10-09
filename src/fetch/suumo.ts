import type { Database } from "bun:sqlite";
import type { Policy } from "../config.ts";
import { getState, setState } from "../store/db.ts";
import { type Clock, type HourRange, inHourRange, jst } from "../time.ts";
import { looksLikeCaptcha, SUUMO_IMAGE_ORIGIN, SUUMO_ORIGIN } from "./parse.ts";
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

export type RequestKind = "page" | "image";

export type RequestLimits = {
	kind: RequestKind;
	origin: string;
	paused: boolean;
	// null なら時間帯で止めない (人が画面を見たときの画像取得など)
	activeHours: HourRange | null;
	gapSec: number;
	jitterSec: number;
	dailyCap: number;
	stopOnStatus: number[];
};

export const pageLimits = (
	policy: Policy,
	options: { ignoreActiveHours?: boolean } = {},
): RequestLimits => ({
	kind: "page",
	origin: SUUMO_ORIGIN,
	paused: policy.paused,
	activeHours: options.ignoreActiveHours ? null : policy.fetch.active_hours,
	gapSec: policy.fetch.request_gap_sec,
	jitterSec: policy.fetch.jitter_sec,
	dailyCap: policy.fetch.daily_request_cap,
	stopOnStatus: policy.fetch.stop_on_status,
});

export const imageLimits = (policy: Policy): RequestLimits => ({
	kind: "image",
	origin: SUUMO_IMAGE_ORIGIN,
	paused: policy.paused,
	activeHours: null,
	gapSec: policy.images.request_gap_sec,
	jitterSec: policy.images.jitter_sec,
	dailyCap: policy.images.daily_cap,
	stopOnStatus: policy.fetch.stop_on_status,
});

export type HttpClientDeps = {
	db: Database;
	limits: RequestLimits;
	runId: string;
	clock: Clock;
	sleep: (ms: number) => Promise<void>;
	random: () => number;
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
};

export type FetchResult = {
	status: number;
	body: string;
	bytes: Uint8Array;
	contentType: string;
	logId: number;
};

// ページと画像は同じ回線から出るので、どちらかが止められたら両方止める
const STOPPED_ON = "fetch.stopped_on";

// SUUMO へのリクエストはすべてこのクラスを通す。間隔・上限・robots.txt・停止条件をここで強制する
export class HttpClient {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: HttpClientDeps) {}

	get(url: string): Promise<FetchResult> {
		const run = this.queue.then(() => this.getNow(url));
		this.queue = run.catch(() => {});
		return run;
	}

	requestsToday(): number {
		const today = jst(this.deps.clock()).date;
		return (
			this.deps.db
				.query<{ n: number }, [string, string]>(
					"SELECT COUNT(*) AS n FROM fetch_log WHERE kind = ? AND jst_date = ?",
				)
				.get(this.deps.limits.kind, today)?.n ?? 0
		);
	}

	recordItems(logId: number, items: number): void {
		this.deps.db
			.query("UPDATE fetch_log SET items = ? WHERE id = ?")
			.run(items, logId);
	}

	private async getNow(url: string): Promise<FetchResult> {
		const { origin } = this.deps.limits;
		if (new URL(url).origin !== origin)
			throw new Error(`${origin} 以外の URL は取得しない: ${url}`);
		this.assertRunnable();
		if (!isAllowed(parseRobots(await this.robotsTxt(), USER_AGENT), url)) {
			throw new FetchStopped("robots", `robots.txt で除外されている: ${url}`);
		}
		return this.request(url);
	}

	private assertRunnable(): void {
		const { db, limits, clock } = this.deps;
		const now = jst(clock());
		if (limits.paused)
			throw new FetchStopped("paused", "policy.paused が true");
		if (limits.activeHours && !inHourRange(now.minutes, limits.activeHours)) {
			throw new FetchStopped("outside_hours", "active_hours の外");
		}
		if (getState(db, STOPPED_ON) === now.date) {
			throw new FetchStopped("stopped_today", "今日の取得は停止済み");
		}
		if (this.requestsToday() >= limits.dailyCap) {
			throw new FetchStopped(
				"daily_cap",
				`1日の上限 ${limits.dailyCap} 回に達した`,
			);
		}
	}

	private async robotsTxt(): Promise<string> {
		const { db, clock, limits } = this.deps;
		const key = `fetch.robots.${new URL(limits.origin).host}`;
		const today = jst(clock()).date;
		const cached = getState(db, key);
		if (cached) {
			const { date, body } = JSON.parse(cached) as {
				date: string;
				body: string;
			};
			if (date === today) return body;
		}
		const res = await this.request(`${limits.origin}/robots.txt`, true);
		// 4xx は制限なし、5xx は全面禁止として扱う (RFC 9309)
		const body =
			res.status >= 500
				? "User-agent: *\nDisallow: /"
				: res.status >= 400
					? ""
					: res.body;
		setState(db, key, JSON.stringify({ date: today, body }));
		return body;
	}

	private async waitGap(): Promise<void> {
		const { db, limits, clock, sleep, random } = this.deps;
		const last = Number(
			getState(db, `fetch.last_request_at.${limits.kind}`) ?? 0,
		);
		const gapMs = (limits.gapSec + random() * limits.jitterSec) * 1000;
		const waitMs = last + gapMs - clock().getTime();
		if (waitMs > 0) await sleep(waitMs);
	}

	private async request(
		url: string,
		asText = this.deps.limits.kind === "page",
	): Promise<FetchResult> {
		const { db, limits, clock, runId, fetchImpl } = this.deps;
		this.assertRunnable();
		await this.waitGap();
		const startedAt = clock();
		setState(
			db,
			`fetch.last_request_at.${limits.kind}`,
			String(startedAt.getTime()),
		);
		const logId =
			db
				.query<{ id: number }, [string, string, string, string, string]>(
					"INSERT INTO fetch_log (run_id, kind, url, started_at, jst_date) VALUES (?, ?, ?, ?, ?) RETURNING id",
				)
				.get(
					runId,
					limits.kind,
					url,
					startedAt.toISOString(),
					jst(startedAt).date,
				)?.id ?? 0;
		let res: Response;
		let bytes: Uint8Array;
		try {
			res = await fetchImpl(url, {
				headers: { "user-agent": USER_AGENT },
				redirect: "follow",
			});
			bytes = new Uint8Array(await res.arrayBuffer());
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
		const contentType = res.headers.get("content-type") ?? "";
		const isText = asText || contentType.startsWith("text/");
		const body = isText ? new TextDecoder().decode(bytes) : "";
		const captcha = isText && looksLikeCaptcha(body);
		if (limits.stopOnStatus.includes(res.status) || captcha) {
			const reason = captcha ? "CAPTCHA の兆候" : `HTTP ${res.status}`;
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
		return { status: res.status, body, bytes, contentType, logId };
	}
}
