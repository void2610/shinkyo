import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ImageStore } from "../src/fetch/images.ts";
import { isFloorPlan } from "../src/fetch/images.ts";
import { parseDetailPage, parseListPage } from "../src/fetch/parse.ts";
import { FetchStopped } from "../src/fetch/suumo.ts";
import { prefetchTargets, runPrefetch } from "../src/jobs/prefetch.ts";
import { applyDetail, upsertListing } from "../src/store/listings.ts";
import { fixture, MONDAY_10_JST, memoryDb } from "./helpers.ts";

const page = parseListPage(await fixture("list_p1.html"));
const detail = parseDetailPage(await fixture("detail.html"));
const base = "https://img01.suumo.com/front/gazo/fr/bukken";

function seed(): Database {
	const db = memoryDb();
	const at = MONDAY_10_JST.toISOString();
	for (const room of page.rooms) upsertListing(db, room, "test", at);
	applyDetail(db, "900000000002", detail, "", at);
	return db;
}

test("見送り以外の部屋について、カードの1枚目と間取り図だけを対象にする", () => {
	const db = seed();
	db.query(
		"UPDATE units SET status = '見送り' WHERE unit_key = (SELECT unit_key FROM listings WHERE listing_id = '900000000003')",
	).run();
	expect(prefetchTargets(db).sort()).toEqual(
		[
			`${base}/001/900000000001/900000000001_go.jpg`,
			`${base}/002/900000000002/900000000002_co.jpg`,
		].sort(),
	);
});

test("保存済みの画像は取り直さず、取得が止められたらそこでやめる", async () => {
	const db = seed();
	db.query(
		"INSERT INTO images (url, path, content_type, fetched_at) VALUES (?, '/tmp/x', 'image/jpeg', 'now')",
	).run(`${base}/001/900000000001/900000000001_go.jpg`);
	const requested: string[] = [];
	const images: ImageStore = {
		get: async (url) => {
			requested.push(url);
			throw new FetchStopped("outside_hours", "active_hours の外");
		},
	};
	const result = await runPrefetch({ db, images, log: () => {} });
	expect(requested).toEqual([`${base}/002/900000000002/900000000002_co.jpg`]);
	expect(result).toEqual({ fetched: 0, stopped: "outside_hours" });
});

test("説明の無い一覧の画像は、ファイル名の末尾 _co で間取り図と見分ける", () => {
	expect(isFloorPlan({ url: `${base}/001/1/1_co.jpg`, caption: null })).toBe(
		true,
	);
	expect(isFloorPlan({ url: `${base}/001/1/1_go.jpg`, caption: null })).toBe(
		false,
	);
	expect(isFloorPlan({ url: `${base}/001/1/1_co.jpg`, caption: "外観" })).toBe(
		false,
	);
});
