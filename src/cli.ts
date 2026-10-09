#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { createRawStore, noopRawStore } from "./fetch/raw.ts";
import { HttpClient } from "./fetch/suumo.ts";
import { runFetch } from "./jobs/fetch.ts";
import { JobLocked, withLock } from "./lock.ts";
import { createNotifier } from "./notify.ts";
import { openDb } from "./store/db.ts";
import { sleep, systemClock } from "./time.ts";
import { createApp } from "./web/app.tsx";

export type JobOptions = { dryRun: boolean; port: number; devOwner: boolean };
type Job = (options: JobOptions) => Promise<void>;

const LOCK_DIR = "data/locks";

const notImplemented =
	(name: string): Job =>
	async () => {
		throw new Error(`${name} は未実装です`);
	};

const fetchJob: Job = async ({ dryRun }) => {
	const config = await loadConfig();
	const db = openDb();
	const clock = systemClock;
	const client = new HttpClient({
		db,
		policy: { ...config.policy.fetch, paused: config.policy.paused },
		runId: crypto.randomUUID(),
		clock,
		sleep,
		random: Math.random,
		fetchImpl: fetch,
	});
	const summary = await withLock(LOCK_DIR, "fetch", () =>
		runFetch({
			db,
			client,
			searches: config.searches,
			policy: config.policy,
			notify: createNotifier(config.profile, { dryRun }),
			raw: dryRun ? noopRawStore : createRawStore("data/raw"),
			clock,
			dryRun,
			log: (m) => console.log(m),
		}),
	);
	console.log(
		`新規掲載 ${summary.newListings} 件 / 新しい部屋 ${summary.newUnits.length} 件 / 詳細 ${summary.details} 件 / 値下げ ${summary.priceDrops.length} 件 / 本日のリクエスト ${client.requestsToday()} 回`,
	);
};

const serveJob: Job = async ({ port, devOwner }) => {
	const config = await loadConfig();
	const app = createApp({
		db: openDb(),
		clock: systemClock,
		ownerLogins: config.profile.web.owner_logins,
		allowedOrigins: config.profile.web.allowed_origins,
		devOwner,
	});
	// tailscale serve からだけ届くように、ループバックにしか bind しない
	const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
	console.log(
		`http://127.0.0.1:${server.port} で待ち受け中${devOwner ? " (dev-owner: 全員が操作できる)" : ""}`,
	);
	await new Promise(() => {});
};

export const jobs = {
	fetch: fetchJob,
	evaluate: notImplemented("evaluate"),
	inquire: notImplemented("inquire"),
	inbox: notImplemented("inbox"),
	plan: notImplemented("plan"),
	status: notImplemented("status"),
	serve: serveJob,
} satisfies Record<string, Job>;

const isJobName = (name: string): name is keyof typeof jobs =>
	Object.hasOwn(jobs, name);

const usage = `使い方: shinkyo <${Object.keys(jobs).join("|")}> [--dry-run] [--port 8787] [--dev-owner]`;

export async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			"dry-run": { type: "boolean", default: false },
			port: { type: "string", default: "8787" },
			"dev-owner": { type: "boolean", default: false },
		},
	});
	const [name] = positionals;
	if (name === undefined || !isJobName(name)) {
		console.error(usage);
		return 2;
	}
	try {
		await jobs[name]({
			dryRun: values["dry-run"],
			port: Number(values.port),
			devOwner: values["dev-owner"],
		});
	} catch (error) {
		if (!(error instanceof JobLocked)) throw error;
		console.log(error.message);
	}
	return 0;
}

if (import.meta.main) {
	process.exit(await main(Bun.argv.slice(2)));
}
