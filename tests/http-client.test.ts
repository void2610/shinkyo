import { describe, expect, test } from "bun:test";
import type { FetchPolicy } from "../src/config.ts";
import { FetchStopped, HttpClient } from "../src/fetch/suumo.ts";
import {
	FakeClock,
	fakeFetch,
	MONDAY_10_JST,
	memoryDb,
	type Route,
	repoConfig,
} from "./helpers.ts";

const LIST = "https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&sc=99999";
const ROBOTS = "https://suumo.jp/robots.txt";
const config = await repoConfig();

function setup(
	policy: Partial<FetchPolicy> = {},
	routes: Record<string, Route | (() => Route)> = {},
) {
	const db = memoryDb();
	const clock = new FakeClock(MONDAY_10_JST);
	const sleeps: number[] = [];
	const fetch = fakeFetch({
		[ROBOTS]: { body: "User-agent: *\nDisallow: /mb/\n" },
		[LIST]: { body: "<html></html>" },
		...routes,
	});
	const client = new HttpClient({
		db,
		policy: { ...config.policy.fetch, paused: false, ...policy },
		runId: "test",
		clock: clock.read,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.advance(ms);
		},
		random: () => 0.5,
		fetchImpl: fetch.impl,
	});
	return { db, clock, sleeps, calls: fetch.calls, client };
}

const stopReason = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		if (error instanceof FetchStopped) return error.reason;
		throw error;
	}
	throw new Error("止まらなかった");
};

describe("HttpClient", () => {
	test("リクエストの間隔を request_gap_sec + jitter 以上あける", async () => {
		const { client, sleeps, calls } = setup();
		await client.get(LIST);
		await client.get(LIST);
		expect(calls).toEqual([ROBOTS, LIST, LIST]);
		// 10 秒 + 0.5 × 3 秒
		expect(sleeps).toEqual([11500, 11500]);
	});

	test("robots.txt は1日1回だけ取得する", async () => {
		const { client, clock, calls } = setup();
		await client.get(LIST);
		await client.get(LIST);
		clock.advance(24 * 3600_000);
		await client.get(LIST);
		expect(calls.filter((u) => u === ROBOTS)).toHaveLength(2);
	});

	test("1日の上限に達したら送らない", async () => {
		const { client, calls } = setup({ daily_request_cap: 3 });
		await client.get(LIST);
		await client.get(LIST);
		expect(await stopReason(client.get(LIST))).toBe("daily_cap");
		expect(calls).toHaveLength(3);
		expect(client.requestsToday()).toBe(3);
	});

	test("429 を受けたらその日は止め、翌日に再開する", async () => {
		let status = 429;
		const { client, clock, calls } = setup(
			{},
			{ [LIST]: () => ({ status, body: "" }) },
		);
		expect(await stopReason(client.get(LIST))).toBe("blocked");
		status = 200;
		expect(await stopReason(client.get(LIST))).toBe("stopped_today");
		expect(calls).toEqual([ROBOTS, LIST]);
		clock.advance(24 * 3600_000);
		expect((await client.get(LIST)).status).toBe(200);
	});

	test("CAPTCHA の兆候でも止める", async () => {
		const { client } = setup(
			{},
			{ [LIST]: { body: '<div class="g-recaptcha"></div>' } },
		);
		expect(await stopReason(client.get(LIST))).toBe("blocked");
	});

	test("robots.txt で除外された URL はリクエストしない", async () => {
		const { client, calls } = setup();
		expect(await stopReason(client.get("https://suumo.jp/mb/chintai/"))).toBe(
			"robots",
		);
		expect(calls).toEqual([ROBOTS]);
	});

	test("停止中と active_hours の外では何も送らない", async () => {
		const paused = setup({ paused: true });
		expect(await stopReason(paused.client.get(LIST))).toBe("paused");
		expect(paused.calls).toEqual([]);

		const night = setup();
		night.clock.set(new Date("2026-10-12T13:30:00Z")); // JST 22:30
		expect(await stopReason(night.client.get(LIST))).toBe("outside_hours");
		expect(night.calls).toEqual([]);
	});

	test("SUUMO 以外の URL は取得しない", async () => {
		const { client } = setup();
		expect(client.get("https://example.com/")).rejects.toThrow("SUUMO 以外");
	});
});
