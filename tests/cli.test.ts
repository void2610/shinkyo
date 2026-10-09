import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

describe("cli", () => {
	test("ジョブ名がなければ使い方を出して 2 で終わる", async () => {
		expect(await main([])).toBe(2);
	});

	test("未知のジョブ名は 2 で終わる", async () => {
		expect(await main(["unknown"])).toBe(2);
	});

	test("未実装のジョブは例外になる", async () => {
		await expect(main(["fetch", "--dry-run"])).rejects.toThrow("未実装");
	});
});
