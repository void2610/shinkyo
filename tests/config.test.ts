import { afterEach, expect, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const copyOfRepoConfig = () => {
	const dir = mkdtempSync(join(tmpdir(), "shinkyo-config-"));
	dirs.push(dir);
	cpSync(join(import.meta.dir, "..", "config"), dir, { recursive: true });
	// 手元の個人の条件に左右されないよう、*.local.yaml はすべて除く
	for (const name of readdirSync(dir))
		if (name.endsWith(".local.yaml")) rmSync(join(dir, name));
	return dir;
};

test("*.local.yaml が無ければリポジトリのサンプルを読む", async () => {
	const config = await loadConfig(copyOfRepoConfig());
	expect(config.searches).toEqual([]);
});

test("*.local.yaml があれば個人の条件としてそちらを優先する", async () => {
	const dir = copyOfRepoConfig();
	writeFileSync(
		join(dir, "searches.local.yaml"),
		"searches:\n  - id: mine\n    url: https://suumo.jp/jj/chintai/ichiran/FR301FC001/?sc=1\n",
	);
	const config = await loadConfig(dir);
	expect(config.searches.map((s) => s.id)).toEqual(["mine"]);
});
