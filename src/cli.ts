#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./config.ts";
import { createImageStore } from "./fetch/images.ts";
import { createRawStore, noopRawStore } from "./fetch/raw.ts";
import { HttpClient, imageLimits, pageLimits } from "./fetch/suumo.ts";
import { jevFromEnv } from "./jev.ts";
import { runEvaluate } from "./jobs/evaluate.ts";
import { runFetch } from "./jobs/fetch.ts";
import { runPrefetch } from "./jobs/prefetch.ts";
import { launchAgentPath, launchAgents, protectedLocation } from "./launchd.ts";
import { spawnClaude } from "./llm.ts";
import { JobLocked, withLock } from "./lock.ts";
import { createNotifier } from "./notify.ts";
import { openDb } from "./store/db.ts";
import { type HourRange, sleep, systemClock } from "./time.ts";
import { createServer, loadBuild } from "./web/server.ts";

export type JobOptions = {
	dryRun: boolean;
	port: number;
	devOwner: boolean;
	ignoreActiveHours: boolean;
	install: boolean;
	configDir: string;
	dbPath: string;
};
type Job = (options: JobOptions) => Promise<void>;

const notImplemented =
	(name: string): Job =>
	async () => {
		throw new Error(`${name} は未実装です`);
	};

// DB と同じ場所に、ロック・生 HTML・画像を置く
const dataDir = (dbPath: string): string => join(dbPath, "..");

const evaluateJob: Job = async ({ dryRun, configDir, dbPath }) => {
	const config = await loadConfig(configDir);
	const db = openDb(dbPath);
	const summary = await withLock(
		join(dataDir(dbPath), "locks"),
		"evaluate",
		async () =>
			runEvaluate({
				db,
				criteria: config.criteria,
				stations: config.stations,
				notify: createNotifier(config.profile, { dryRun }),
				clock: systemClock,
				dryRun,
				log: (m) => console.log(m),
				systemPrompt: await Bun.file(
					new URL("../prompts/evaluate.md", import.meta.url),
				).text(),
				claude: spawnClaude,
				jev: jevFromEnv(),
				webOrigin: config.profile.web.allowed_origins[0] ?? null,
			}),
	);
	console.log(
		`候補 ${summary.candidates.length} 件 / 見送り ${summary.rejected} 件 / 補正できなかった ${summary.llmFailed} 件`,
	);
};

const imageStore = (
	config: Config,
	db: Database,
	dbPath: string,
	options: { activeHours?: HourRange | null } = {},
) =>
	createImageStore({
		db,
		client: new HttpClient({
			db,
			limits: imageLimits(config.policy, options),
			runId: crypto.randomUUID(),
			clock: systemClock,
			sleep,
			random: Math.random,
			fetchImpl: fetch,
		}),
		dir: join(dataDir(dbPath), "images"),
		clock: systemClock,
	});

const fetchJob: Job = async (options) => {
	const { dryRun, ignoreActiveHours, configDir, dbPath } = options;
	const config = await loadConfig(configDir);
	const db = openDb(dbPath);
	const clock = systemClock;
	if (ignoreActiveHours)
		console.log(
			"--ignore-active-hours: 取得時間帯の制限を外して実行する (間隔・上限・robots は守る)",
		);
	const client = new HttpClient({
		db,
		limits: pageLimits(config.policy, { ignoreActiveHours }),
		runId: crypto.randomUUID(),
		clock,
		sleep,
		random: Math.random,
		fetchImpl: fetch,
	});
	const summary = await withLock(join(dataDir(dbPath), "locks"), "fetch", () =>
		runFetch({
			db,
			client,
			searches: config.searches,
			policy: config.policy,
			notify: createNotifier(config.profile, { dryRun }),
			raw: dryRun ? noopRawStore : createRawStore(join(dataDir(dbPath), "raw")),
			clock,
			dryRun,
			log: (m) => console.log(m),
		}),
	);
	console.log(
		`新規掲載 ${summary.newListings} 件 / 新しい部屋 ${summary.newUnits.length} 件 / 詳細 ${summary.details} 件 / 値下げ ${summary.priceDrops.length} 件 / 本日のリクエスト ${client.requestsToday()} 回`,
	);
	// J2 は J1 の直後に走らせる (仕様 5章)
	await evaluateJob(options);
	if (dryRun) return;
	// 画面を開いたときに待たないよう、候補のサムネイルと間取り図を先に取っておく
	const prefetched = await runPrefetch({
		db,
		images: imageStore(config, db, dbPath, {
			activeHours: ignoreActiveHours ? null : config.policy.fetch.active_hours,
		}),
		log: (m) => console.log(m),
	});
	console.log(`写真の先回り取得 ${prefetched.fetched} 枚`);
};

const serveJob: Job = async ({ port, devOwner, configDir, dbPath }) => {
	// 画面はビルド済みの成果物を読むので、起動のたびに今のコードからビルドし直す
	const built = Bun.spawnSync([process.execPath, "run", "build"], {
		cwd: new URL("..", import.meta.url).pathname,
	});
	if (built.exitCode !== 0)
		throw new Error(`画面のビルドに失敗した\n${built.stderr.toString()}`);
	const config = await loadConfig(configDir);
	const db = openDb(dbPath);
	const images = imageStore(config, db, dbPath);
	const app = createServer({
		db,
		clock: systemClock,
		images,
		ownerLogins: config.profile.web.owner_logins,
		allowedOrigins: config.profile.web.allowed_origins,
		devOwner,
		build: await loadBuild(),
	});
	// tailscale serve からだけ届くように、ループバックにしか bind しない
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		// 写真の取得待ちで接続が切れないよう、既定 (10秒) より長く待つ
		idleTimeout: 60,
		fetch: app.fetch,
	});
	console.log(
		`http://127.0.0.1:${server.port} で待ち受け中${devOwner ? " (dev-owner: 全員が操作できる)" : ""}`,
	);
	await new Promise(() => {});
};

const launchdJob: Job = async ({ install, port, configDir }) => {
	const config = await loadConfig(configDir);
	const repoDir = process.cwd();
	const agents = launchAgents({
		repoDir,
		bunPath: process.execPath,
		port,
		fetchIntervalMin: config.policy.fetch.interval_min,
	});
	if (!install) {
		for (const a of agents)
			console.log(`# ${launchAgentPath(a.label)}\n${a.xml}`);
		return;
	}
	const blocked = protectedLocation(repoDir);
	if (blocked)
		throw new Error(
			`${blocked} の下は launchd から読めない。~/dev などに clone してから実行する`,
		);
	mkdirSync(join(repoDir, "data", "logs"), { recursive: true });
	const uid = process.getuid?.() ?? 0;
	for (const a of agents) {
		const path = launchAgentPath(a.label);
		await Bun.write(path, a.xml);
		Bun.spawnSync(["launchctl", "bootout", `gui/${uid}`, path]);
		const res = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, path]);
		console.log(
			`${a.label}: ${res.exitCode === 0 ? "登録した" : `登録に失敗した (${res.stderr.toString().trim()})`}`,
		);
	}
};

export const jobs = {
	fetch: fetchJob,
	evaluate: evaluateJob,
	inquire: notImplemented("inquire"),
	inbox: notImplemented("inbox"),
	plan: notImplemented("plan"),
	status: notImplemented("status"),
	serve: serveJob,
	launchd: launchdJob,
} satisfies Record<string, Job>;

const isJobName = (name: string): name is keyof typeof jobs =>
	Object.hasOwn(jobs, name);

const usage = `使い方: shinkyo <${Object.keys(jobs).join("|")}> [--dry-run] [--ignore-active-hours] [--port 8787] [--dev-owner] [--install] [--config config] [--db data/shinkyo.db]`;

export async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			"dry-run": { type: "boolean", default: false },
			"ignore-active-hours": { type: "boolean", default: false },
			port: { type: "string", default: "8787" },
			"dev-owner": { type: "boolean", default: false },
			install: { type: "boolean", default: false },
			config: { type: "string", default: "config" },
			db: { type: "string", default: "data/shinkyo.db" },
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
			ignoreActiveHours: values["ignore-active-hours"],
			port: Number(values.port),
			devOwner: values["dev-owner"],
			install: values.install,
			configDir: values.config,
			dbPath: values.db,
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
