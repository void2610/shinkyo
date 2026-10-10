#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { createGsiGeocoder } from "./commute/gsi.ts";
import { navitimeFromEnv } from "./commute/navitime.ts";
import { type Config, loadConfig } from "./config.ts";
import { ciStateOf, deployPaths, runDeploy } from "./deploy.ts";
import { createImageStore } from "./fetch/images.ts";
import { createRawStore, noopRawStore } from "./fetch/raw.ts";
import { HttpClient, imageLimits, pageLimits } from "./fetch/suumo.ts";
import { jevFromEnv } from "./jev.ts";
import { runCommute } from "./jobs/commute.ts";
import { runEvaluate } from "./jobs/evaluate.ts";
import { runFetch } from "./jobs/fetch.ts";
import { runPrefetch } from "./jobs/prefetch.ts";
import {
	launchAgentPath,
	launchAgents,
	logDir,
	protectedLocation,
} from "./launchd.ts";
import { spawnClaude } from "./llm.ts";
import { JobLocked, withLock } from "./lock.ts";
import { createNotifier, logNotifier } from "./notify.ts";
import { openDb } from "./store/db.ts";
import { type HourRange, sleep, systemClock } from "./time.ts";
import { accessIdentity, localIdentity } from "./web/identity.ts";
import { createServer, loadBuild } from "./web/server.ts";

export type JobOptions = {
	dryRun: boolean;
	port: number;
	ignoreActiveHours: boolean;
	install: boolean;
	skipBuild: boolean;
	configDir: string;
	dbPath: string;
	root: string;
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
				workplaces: config.profile.workplaces,
			}),
	);
	console.log(
		`候補 ${summary.candidates.length} 件 / 見送り ${summary.rejected} 件 / 補正できなかった ${summary.llmFailed} 件`,
	);
};

const commuteJob: Job = async ({ dryRun, configDir, dbPath }) => {
	const config = await loadConfig(configDir);
	if (dryRun) {
		console.log("[dry-run] 座標と通勤時間の取得は行わない");
		return;
	}
	const route = navitimeFromEnv();
	if (!route)
		console.log("RAPIDAPI_KEY が無いので、通勤時間は調べず座標だけ取る");
	const { commute } = config.policy;
	const summary = await withLock(
		join(dataDir(dbPath), "locks"),
		"commute",
		() =>
			runCommute({
				db: openDb(dbPath),
				criteria: config.criteria,
				workplaces: config.profile.workplaces,
				geocode: createGsiGeocoder(fetch),
				route,
				limits: {
					geocodeDailyCap: commute.geocode_daily_cap,
					routeDailyCap: commute.route_daily_cap,
					gapMs: commute.request_gap_sec * 1000,
				},
				clock: systemClock,
				sleep,
				log: (m) => console.log(m),
				runId: crypto.randomUUID(),
			}),
	);
	console.log(
		`座標 ${summary.geocoded} 件 / 通勤時間 ${summary.routed} 件を新たに調べた`,
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
			criteria: config.criteria,
			notify: createNotifier(config.profile, { dryRun }),
			raw: dryRun ? noopRawStore : createRawStore(join(dataDir(dbPath), "raw")),
			clock,
			dryRun,
			log: (m) => console.log(m),
		}),
	);
	console.log(
		`新規掲載 ${summary.newListings} 件 / 新しい部屋 ${summary.newUnits.length} 件 / 詳細 ${summary.details} 件 (条件外で省略 ${summary.skippedDetails} 件) / 値下げ ${summary.priceDrops.length} 件 / 本日のリクエスト ${client.requestsToday()} 回`,
	);
	// 採点に通勤時間を使うので、評価 (J2) の前に調べる。J2 は J1 の直後に走らせる (仕様 5章)
	await commuteJob(options);
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

const serveJob: Job = async ({ port, configDir, dbPath, skipBuild }) => {
	// 画面はビルド済みの成果物を読むので、開発中は起動のたびに今のコードからビルドし直す (本番はデプロイ時にビルド済み)
	if (!skipBuild) await run([process.execPath, "run", "build"], repoRoot);
	const config = await loadConfig(configDir);
	const db = openDb(dbPath);
	const images = imageStore(config, db, dbPath);
	const access = config.profile.web.access;
	if (!access)
		console.log(
			"Cloudflare Access が未設定なので、全員を local として扱う (開発用)",
		);
	const identify = access
		? accessIdentity({ teamDomain: access.team_domain, aud: access.aud })
		: localIdentity;
	const app = createServer({
		db,
		clock: systemClock,
		images,
		identify,
		people: config.profile.web.people,
		workplaces: config.profile.workplaces,
		allowedOrigins: config.profile.web.allowed_origins,
		build: await loadBuild(),
	});
	// cloudflared からだけ届くように、ループバックにしか bind しない
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		// 写真の取得待ちで接続が切れないよう、既定 (10秒) より長く待つ
		idleTimeout: 60,
		fetch: app.fetch,
	});
	console.log(`http://127.0.0.1:${server.port} で待ち受け中`);
	await new Promise(() => {});
};

const repoRoot = new URL("..", import.meta.url).pathname;

async function run(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`${cmd.slice(0, 2).join(" ")} が失敗した\n${err.trim()}`);
	return out;
}

const repoSlug = (): string => {
	const slug = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];
	if (!slug)
		throw new Error("package.json の repository が GitHub の URL ではない");
	return slug;
};

const serveLabel = "com.shinkyo.serve";

const deployJob: Job = async ({ root, port }) => {
	const { repo } = deployPaths(root);
	const uid = process.getuid?.() ?? 0;
	const result = await withLock(root, "deploy", () =>
		runDeploy({
			root,
			latest: async () => {
				if (!existsSync(repo))
					await run(
						["git", "clone", "--bare", "--quiet", pkg.repository.url, repo],
						root,
					);
				await run(
					[
						"git",
						"-C",
						repo,
						"fetch",
						"--quiet",
						"origin",
						"+refs/heads/main:refs/heads/main",
					],
					root,
				);
				return (
					await run(["git", "-C", repo, "rev-parse", "main"], root)
				).trim();
			},
			// 公開リポジトリなので認証なしの API で足りる (1時間 60 回まで。新しいコミットがあるときだけ呼ぶ)
			ciState: async (sha) => {
				const res = await fetch(
					`https://api.github.com/repos/${repoSlug()}/commits/${sha}/check-runs`,
					{
						headers: {
							accept: "application/vnd.github+json",
							"user-agent": "shinkyo-deploy",
						},
					},
				);
				if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
				const body = (await res.json()) as {
					check_runs: { status: string; conclusion: string | null }[];
				};
				return ciStateOf(body.check_runs);
			},
			extract: async (sha, dir) => {
				const tar = `${dir}.tar`;
				await run(["git", "-C", repo, "archive", `--output=${tar}`, sha], root);
				try {
					await run(["tar", "-xf", tar, "-C", dir], root);
				} finally {
					await Bun.file(tar).delete();
				}
			},
			build: async (dir) => {
				await run([process.execPath, "install", "--frozen-lockfile"], dir);
				await run([process.execPath, "run", "build"], dir);
			},
			restart: async () => {
				const target = `gui/${uid}/${serveLabel}`;
				if (Bun.spawnSync(["launchctl", "print", target]).exitCode !== 0)
					return false;
				await run(["launchctl", "kickstart", "-k", target], root);
				return true;
			},
			healthy: async () => {
				for (let i = 0; i < 30; i++) {
					await sleep(1000);
					try {
						// Access が有効なら 401 が返る。起動していれば十分
						const res = await fetch(`http://127.0.0.1:${port}/`);
						if (res.status < 500) return true;
					} catch {}
				}
				return false;
			},
			log: (m) => console.log(m),
		}),
	);
	const short = result.sha.slice(0, 7);
	if (result.kind === "deployed")
		console.log(
			`${short} に切り替えた (前の版: ${result.from?.slice(0, 7) ?? "なし"})`,
		);
	else if (result.kind === "failed") {
		console.error(`${short} のデプロイに失敗した: ${result.reason}`);
		const notify = await loadConfig(join(root, "current", "config"))
			.then((c) => createNotifier(c.profile, { dryRun: false }))
			.catch(() => logNotifier);
		await notify({
			title: "デプロイに失敗",
			message: `${short}: ${result.reason}`,
			priority: 4,
			tags: ["warning"],
		});
	} else if (result.kind === "ci_failed")
		console.log(`${short} は CI が失敗しているので入れない`);
};

const launchdJob: Job = async ({ install, port, root }) => {
	const repoDir = deployPaths(root).current;
	if (!existsSync(repoDir))
		throw new Error(
			`${repoDir} が無い。先に shinkyo deploy --root ${root} で最初の版を入れる`,
		);
	const config = await loadConfig(join(repoDir, "config"));
	const agents = launchAgents({
		root,
		bunPath: process.execPath,
		port,
		fetchIntervalMin: config.policy.fetch.interval_min,
	});
	if (!install) {
		for (const a of agents)
			console.log(`# ${launchAgentPath(a.label)}\n${a.xml}`);
		return;
	}
	const blocked = protectedLocation(root);
	if (blocked)
		throw new Error(
			`${blocked} の下は launchd から読めない。--root を ~/shinkyo などにする`,
		);
	mkdirSync(logDir(root), { recursive: true });
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
	commute: commuteJob,
	inquire: notImplemented("inquire"),
	inbox: notImplemented("inbox"),
	plan: notImplemented("plan"),
	status: notImplemented("status"),
	serve: serveJob,
	deploy: deployJob,
	launchd: launchdJob,
} satisfies Record<string, Job>;

const isJobName = (name: string): name is keyof typeof jobs =>
	Object.hasOwn(jobs, name);

const usage = `使い方: shinkyo <${Object.keys(jobs).join("|")}> [--dry-run] [--ignore-active-hours] [--port 8787] [--install] [--skip-build] [--config config] [--db data/shinkyo.db] [--root ~/shinkyo]`;

export async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			"dry-run": { type: "boolean", default: false },
			"ignore-active-hours": { type: "boolean", default: false },
			port: { type: "string", default: "8787" },
			install: { type: "boolean", default: false },
			"skip-build": { type: "boolean", default: false },
			root: { type: "string", default: join(homedir(), "shinkyo") },
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
			install: values.install,
			skipBuild: values["skip-build"],
			root: values.root,
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
