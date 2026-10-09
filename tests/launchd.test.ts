import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchAgents, protectedLocation } from "../src/launchd.ts";

test("取得は一定間隔、画面は常駐で登録する", () => {
	const [fetch, serve] = launchAgents({
		repoDir: "/Users/me/dev/shinkyo",
		bunPath: "/bin/bun",
		port: 8787,
		fetchIntervalMin: 45,
	});
	expect(fetch?.xml).toContain("<string>fetch</string>");
	expect(fetch?.xml).toContain("<integer>2700</integer>");
	expect(serve?.xml).toContain("<key>KeepAlive</key>");
	expect(serve?.xml).toContain("<string>8787</string>");
	expect(fetch?.xml).not.toContain("ignore-active-hours");
});

test("Documents などの下からは登録させない", () => {
	expect(
		protectedLocation(join(homedir(), "Documents", "GitHub", "shinkyo")),
	).toBe(join(homedir(), "Documents"));
	expect(protectedLocation(join(homedir(), "dev", "shinkyo"))).toBeNull();
});
