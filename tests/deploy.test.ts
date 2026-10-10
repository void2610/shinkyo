import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CiState,
	ciStateOf,
	currentRelease,
	type DeployDeps,
	runDeploy,
} from "../src/deploy.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shinkyo-deploy-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Fake = {
	sha?: string;
	ci?: CiState;
	buildFails?: boolean;
	registered?: boolean;
	healthy?: boolean;
};

function deps(fake: Fake = {}) {
	const calls: string[] = [];
	const d: DeployDeps = {
		root,
		latest: async () => fake.sha ?? "b".repeat(40),
		ciState: async (sha) => {
			calls.push(`ci ${sha.slice(0, 1)}`);
			return fake.ci ?? "success";
		},
		extract: async (sha, dir) => {
			mkdirSync(join(dir, "config"));
			writeFileSync(join(dir, "config", "policy.yaml"), sha);
		},
		build: async (dir) => {
			calls.push(
				`build ${readFileSync(join(dir, "config", "policy.yaml"), "utf8").slice(0, 1)}`,
			);
			if (fake.buildFails) throw new Error("vite が落ちた");
		},
		restart: async () => {
			calls.push(`restart ${currentRelease(root)?.slice(0, 1)}`);
			return fake.registered ?? true;
		},
		healthy: async () => fake.healthy ?? true,
		log: () => {},
	};
	return { d, calls };
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("デプロイ", () => {
	test("CI を通った新しいコミットをビルドし、current を差し替えて画面を再起動する", async () => {
		const { d, calls } = deps();
		expect(await runDeploy(d)).toEqual({
			kind: "deployed",
			sha: B,
			from: null,
		});
		expect(readlinkSync(join(root, "current"))).toBe(join("releases", B));
		expect(calls).toEqual(["ci b", "build b", "restart b"]);
	});

	test("DB・画像・個人の設定・.env は shared/ から各版に貼る", async () => {
		mkdirSync(join(root, "shared", "config"), { recursive: true });
		writeFileSync(join(root, "shared", "config", "criteria.local.yaml"), "x");
		writeFileSync(join(root, "shared", ".env"), "K=v");
		await runDeploy(deps().d);
		const release = join(root, "releases", B);
		expect(readlinkSync(join(release, "config", "criteria.local.yaml"))).toBe(
			join(root, "shared", "config", "criteria.local.yaml"),
		);
		expect(readlinkSync(join(release, ".env"))).toBe(
			join(root, "shared", ".env"),
		);
		expect(readlinkSync(join(release, "data"))).toBe(
			join(root, "shared", "data"),
		);
		expect(existsSync(join(release, "config", "policy.yaml"))).toBe(true);
	});

	test("今の版と同じなら何もせず、CI の確認もしない", async () => {
		await runDeploy(deps().d);
		const { d, calls } = deps();
		expect((await runDeploy(d)).kind).toBe("up_to_date");
		expect(calls).toEqual([]);
	});

	test("今の版と同じでも、あとから shared/ に置いたものは貼り、貼ってある DB は壊さない", async () => {
		mkdirSync(join(root, "shared", "data"), { recursive: true });
		writeFileSync(join(root, "shared", "data", "shinkyo.db"), "db");
		await runDeploy(deps().d);
		writeFileSync(join(root, "shared", "config", "criteria.local.yaml"), "x");
		writeFileSync(join(root, "shared", ".env"), "K=v");
		expect((await runDeploy(deps().d)).kind).toBe("up_to_date");
		const current = join(root, "current");
		expect(
			readFileSync(join(current, "config", "criteria.local.yaml"), "utf8"),
		).toBe("x");
		expect(readFileSync(join(current, ".env"), "utf8")).toBe("K=v");
		expect(
			readFileSync(join(root, "shared", "data", "shinkyo.db"), "utf8"),
		).toBe("db");
	});

	test("CI が終わっていなければ待ち、失敗していれば入れない (再実行で通れば次に入る)", async () => {
		expect((await runDeploy(deps({ ci: "pending" }).d)).kind).toBe(
			"waiting_ci",
		);
		expect((await runDeploy(deps({ ci: "failure" }).d)).kind).toBe("ci_failed");
		expect(currentRelease(root)).toBeNull();
		expect((await runDeploy(deps({ ci: "success" }).d)).kind).toBe("deployed");
	});

	test("ビルドに失敗したら今の版のまま残し、同じコミットは二度とビルドしない", async () => {
		await runDeploy(deps({ sha: A }).d);
		const failed = await runDeploy(deps({ buildFails: true }).d);
		expect(failed).toMatchObject({ kind: "failed", sha: B });
		expect(currentRelease(root)).toBe(A);
		expect(existsSync(join(root, "releases", B))).toBe(false);
		const { d, calls } = deps();
		expect((await runDeploy(d)).kind).toBe("skipped");
		expect(calls).toEqual([]);
	});

	test("新しい版で画面が起動しなければ前の版に戻す", async () => {
		await runDeploy(deps({ sha: A }).d);
		const { d, calls } = deps({ healthy: false });
		expect((await runDeploy(d)).kind).toBe("failed");
		expect(currentRelease(root)).toBe(A);
		expect(calls).toEqual(["ci b", "build b", "restart b", "restart a"]);
	});

	test("画面がまだ launchd に無ければ、起動の確認をせずに切り替える", async () => {
		expect(
			(await runDeploy(deps({ registered: false, healthy: false }).d)).kind,
		).toBe("deployed");
	});

	test("古い版は新しいほうから決まった数だけ残す", async () => {
		const shas = ["1", "2", "3", "4"].map((c) => c.repeat(40));
		for (const [i, sha] of shas.entries()) {
			await runDeploy({ ...deps({ sha }).d, keep: 2 });
			const t = new Date(Date.now() + i * 1000);
			utimesSync(join(root, "releases", sha), t, t);
		}
		expect(existsSync(join(root, "releases", shas[0] ?? ""))).toBe(false);
		expect(existsSync(join(root, "releases", shas[2] ?? ""))).toBe(true);
		expect(existsSync(join(root, "releases", shas[3] ?? ""))).toBe(true);
	});
});

describe("CI の状態", () => {
	const run = (status: string, conclusion: string | null = null) => ({
		status,
		conclusion,
	});
	test("すべて完了して成功 (またはスキップ) なら成功", () => {
		expect(
			ciStateOf([run("completed", "success"), run("completed", "skipped")]),
		).toBe("success");
	});
	test("まだ始まっていないか、走っているものがあれば待つ", () => {
		expect(ciStateOf([])).toBe("pending");
		expect(ciStateOf([run("completed", "success"), run("in_progress")])).toBe(
			"pending",
		);
	});
	test("1つでも失敗・取り消しがあれば失敗", () => {
		expect(
			ciStateOf([run("completed", "success"), run("completed", "cancelled")]),
		).toBe("failure");
	});
});
