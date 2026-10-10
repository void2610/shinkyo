import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchAgents, protectedLocation } from "../src/launchd.ts";

const [fetch, serve, deploy] = launchAgents({
	root: "/Users/me/shinkyo",
	bunPath: "/bin/bun",
	port: 8787,
	fetchIntervalMin: 45,
});

test("取得は一定間隔、画面は常駐で登録する", () => {
	expect(fetch?.xml).toContain("<string>fetch</string>");
	expect(fetch?.xml).toContain("<integer>2700</integer>");
	expect(serve?.xml).toContain("<key>KeepAlive</key>");
	expect(serve?.xml).toContain("<string>8787</string>");
	expect(fetch?.xml).not.toContain("ignore-active-hours");
});

test("どのジョブも今の版で動き、ログは版をまたいで残る場所に出す", () => {
	for (const agent of [fetch, serve, deploy]) {
		expect(agent?.xml).toContain("<string>/Users/me/shinkyo/current</string>");
		expect(agent?.xml).toContain("/Users/me/shinkyo/shared/data/logs/");
	}
});

test("画面はデプロイ時のビルドを使い、デプロイは 2 分ごとに確認する", () => {
	expect(serve?.xml).toContain("<string>--skip-build</string>");
	expect(deploy?.xml).toContain("<string>deploy</string>");
	expect(deploy?.xml).toContain("<integer>120</integer>");
	expect(deploy?.xml).toContain("<string>/Users/me/shinkyo</string>");
});

test("Documents などの下からは登録させない", () => {
	expect(
		protectedLocation(join(homedir(), "Documents", "GitHub", "shinkyo")),
	).toBe(join(homedir(), "Documents"));
	expect(protectedLocation(join(homedir(), "shinkyo"))).toBeNull();
});
