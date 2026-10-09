import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore } from "../src/fetch/images.ts";
import type { FetchResult } from "../src/fetch/suumo.ts";
import { FakeClock, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const IMAGE =
	"https://img01.suumo.com/front/gazo/fr/bukken/001/900000000001/900000000001_go.jpg";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(result: Partial<FetchResult> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "shinkyo-images-"));
	dirs.push(dir);
	const calls: string[] = [];
	const store = createImageStore({
		db: memoryDb(),
		dir,
		clock: new FakeClock(MONDAY_10_JST).read,
		client: {
			get: async (url) => {
				calls.push(url);
				await Bun.sleep(5);
				return {
					status: 200,
					body: "",
					bytes: new TextEncoder().encode("jpeg"),
					contentType: "image/jpeg",
					logId: 1,
					...result,
				};
			},
		},
	});
	return { store, calls };
}

describe("画像の保存", () => {
	test("一度取得した画像は保存したものを返し、再取得しない", async () => {
		const { store, calls } = setup();
		const first = await store.get(IMAGE);
		const second = await store.get(IMAGE);
		expect(second).toEqual(first);
		expect(await Bun.file(first?.path ?? "").text()).toBe("jpeg");
		expect(calls).toHaveLength(1);
	});

	test("同じ画像への同時リクエストは1回の取得にまとめる", async () => {
		const { store, calls } = setup();
		await Promise.all([store.get(IMAGE), store.get(IMAGE), store.get(IMAGE)]);
		expect(calls).toHaveLength(1);
	});

	test("SUUMO の画像以外や、画像でない応答は保存しない", async () => {
		const { store, calls } = setup({ contentType: "text/html" });
		expect(await store.get("https://example.com/a.jpg")).toBeNull();
		expect(calls).toHaveLength(0);
		expect(await store.get(IMAGE)).toBeNull();
	});
});
