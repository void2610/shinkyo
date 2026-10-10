import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export type CiState = "success" | "pending" | "failure";

export type DeployDeps = {
	root: string;
	latest: () => Promise<string>;
	ciState: (sha: string) => Promise<CiState>;
	extract: (sha: string, dir: string) => Promise<void>;
	build: (dir: string) => Promise<void>;
	// 画面が launchd に登録されていなければ false
	restart: () => Promise<boolean>;
	healthy: () => Promise<boolean>;
	log: (message: string) => void;
	keep?: number;
};

export type DeployResult =
	| { kind: "up_to_date" | "waiting_ci" | "ci_failed" | "skipped"; sha: string }
	| { kind: "deployed"; sha: string; from: string | null }
	| { kind: "failed"; sha: string; reason: string };

export const deployPaths = (root: string) => ({
	repo: join(root, "repo.git"),
	releases: join(root, "releases"),
	current: join(root, "current"),
	shared: join(root, "shared"),
});

const failedMarker = (root: string, sha: string) =>
	join(deployPaths(root).releases, `${sha}.failed`);

export function currentRelease(root: string): string | null {
	try {
		return basename(readlinkSync(deployPaths(root).current));
	} catch {
		return null;
	}
}

// 走っている取得ジョブが途中で別の版を読まないよう、symlink を rename で一度に差し替える
function switchTo(root: string, sha: string): void {
	const { current } = deployPaths(root);
	const next = `${current}.next`;
	rmSync(next, { force: true });
	symlinkSync(join("releases", sha), next);
	renameSync(next, current);
}

// shared/ の中身 (DB・画像・*.local.yaml・.env) を、同じ相対パスで各版に貼る
export function linkShared(from: string, to: string): void {
	if (!existsSync(from)) return;
	for (const name of readdirSync(from)) {
		const source = join(from, name);
		const target = join(to, name);
		const existing = lstatSync(target, { throwIfNoEntry: false });
		// 貼ってある symlink をたどって中を貼り直すと、shared の実体を自分自身へのリンクで消してしまう
		if (existing?.isSymbolicLink() && readlinkSync(target) === source) continue;
		if (statSync(source).isDirectory() && existing?.isDirectory()) {
			linkShared(source, target);
			continue;
		}
		rmSync(target, { recursive: true, force: true });
		symlinkSync(source, target);
	}
}

function prune(root: string, keep: number, protect: (string | null)[]): void {
	const { releases } = deployPaths(root);
	const dirs = readdirSync(releases)
		.filter((name) => statSync(join(releases, name)).isDirectory())
		.sort(
			(a, b) =>
				statSync(join(releases, b)).mtimeMs -
				statSync(join(releases, a)).mtimeMs,
		);
	for (const name of dirs.slice(keep)) {
		if (protect.includes(name)) continue;
		rmSync(join(releases, name), { recursive: true, force: true });
	}
}

export function ensureLayout(root: string): void {
	const { releases, shared } = deployPaths(root);
	for (const dir of [releases, join(shared, "data"), join(shared, "config")])
		mkdirSync(dir, { recursive: true });
}

export async function runDeploy(deps: DeployDeps): Promise<DeployResult> {
	const { root, log } = deps;
	ensureLayout(root);
	const sha = await deps.latest();
	const from = currentRelease(root);
	if (sha === from) {
		// 版が変わらなくても、あとから shared/ に置いた設定はすぐ効かせる
		linkShared(deployPaths(root).shared, join(root, "current"));
		return { kind: "up_to_date", sha };
	}
	if (existsSync(failedMarker(root, sha))) return { kind: "skipped", sha };
	// CI の失敗は再実行で直ることがあるので印を付けず、次の確認でまた見る
	const ci = await deps.ciState(sha);
	if (ci === "pending") return { kind: "waiting_ci", sha };
	if (ci === "failure") return { kind: "ci_failed", sha };

	const fail = (reason: string): DeployResult => {
		writeFileSync(failedMarker(root, sha), `${reason}\n`);
		return { kind: "failed", sha, reason };
	};
	const dir = join(deployPaths(root).releases, sha);
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		await deps.extract(sha, dir);
		linkShared(deployPaths(root).shared, dir);
		log(`${sha} をビルドする`);
		await deps.build(dir);
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		return fail(`ビルドに失敗した: ${(error as Error).message}`);
	}

	switchTo(root, sha);
	if ((await deps.restart()) && !(await deps.healthy())) {
		if (from) {
			switchTo(root, from);
			await deps.restart();
		}
		return fail("新しい版で画面が起動しなかったので、前の版に戻した");
	}
	prune(root, deps.keep ?? 5, [sha, from]);
	return { kind: "deployed", sha, from };
}

type CheckRun = { status: string; conclusion: string | null };

// まだ CI が始まっていない (0件) ときも待つ
export function ciStateOf(runs: CheckRun[]): CiState {
	if (runs.length === 0 || runs.some((r) => r.status !== "completed"))
		return "pending";
	const ok = ["success", "skipped", "neutral"];
	return runs.every((r) => ok.includes(r.conclusion ?? ""))
		? "success"
		: "failure";
}
