import { describe, expect, test } from "bun:test";
import {
	FetchStopped,
	HttpClient,
	imageLimits,
	pageLimits,
	type RequestLimits,
} from "../src/fetch/suumo.ts";
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
	limits: Partial<RequestLimits> = {},
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
		limits: { ...pageLimits(config.policy), ...limits },
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
		const { client, calls } = setup({ dailyCap: 3 });
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

	test("系統の origin 以外の URL は取得しない", async () => {
		const { client } = setup();
		expect(client.get("https://example.com/")).rejects.toThrow(
			"以外の URL は取得しない",
		);
	});

	test("--ignore-active-hours では時間帯の外でも取得するが、間隔は守る", async () => {
		const { client, clock, sleeps } = setup(
			pageLimits(config.policy, { ignoreActiveHours: true }),
		);
		clock.set(new Date("2026-10-12T15:52:00Z")); // JST 0:52
		await client.get(LIST);
		await client.get(LIST);
		expect(sleeps).toEqual([11500, 11500]);
	});
});

describe("画像の取得", () => {
	const IMAGE =
		"https://img01.suumo.com/front/gazo/fr/bukken/001/900000000001/900000000001_go.jpg";
	const IMAGE_ROBOTS = "https://img01.suumo.com/robots.txt";
	const imageRoutes = {
		[IMAGE_ROBOTS]: {
			body: "User-Agent: *\nDisallow: /\nAllow: /front/gazo/\n",
		},
		[IMAGE]: { body: "jpeg-bytes" },
	};

	test("画像サーバーの robots.txt に従い、/front/gazo/ 以外は取得しない", async () => {
		const { client, calls } = setup(imageLimits(config.policy), imageRoutes);
		expect((await client.get(IMAGE)).bytes.length).toBeGreaterThan(0);
		expect(
			await stopReason(client.get("https://img01.suumo.com/jj/other.jpg")),
		).toBe("robots");
		expect(calls).toEqual([IMAGE_ROBOTS, IMAGE]);
	});

	test("画像は時間帯で止めず、上限はページと別に数える", async () => {
		const { client, clock, db } = setup(
			imageLimits(config.policy),
			imageRoutes,
		);
		clock.set(new Date("2026-10-12T15:52:00Z"));
		await client.get(IMAGE);
		const kinds = db
			.query<{ kind: string }, []>("SELECT DISTINCT kind FROM fetch_log")
			.all();
		expect(kinds).toEqual([{ kind: "image" }]);
	});

	test("画像で 429 を受けたらページの取得もその日は止める", async () => {
		const image = setup(imageLimits(config.policy), {
			...imageRoutes,
			[IMAGE]: { status: 429, body: "" },
		});
		expect(await stopReason(image.client.get(IMAGE))).toBe("blocked");
		const page = new HttpClient({
			db: image.db,
			limits: pageLimits(config.policy),
			runId: "test",
			clock: image.clock.read,
			sleep: async () => {},
			random: () => 0,
			fetchImpl: async () => new Response(""),
		});
		expect(await stopReason(page.get(LIST))).toBe("stopped_today");
	});

	test("同時に呼ばれても1本ずつ間隔をあけて送る", async () => {
		const { client, sleeps } = setup();
		await Promise.all([client.get(LIST), client.get(LIST), client.get(LIST)]);
		expect(sleeps).toEqual([11500, 11500, 11500]);
	});
});
