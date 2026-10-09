import type { Database } from "bun:sqlite";
import type { ImageStore } from "../fetch/images.ts";
import type { RoomImage } from "../fetch/parse.ts";
import { FetchStopped } from "../fetch/suumo.ts";
import { isFloorPlan, pickGallerySource } from "../images/kinds.ts";

export type PrefetchDeps = {
	db: Database;
	images: ImageStore;
	log: (message: string) => void;
};

type Row = { unit_key: string; images: string; total: number };

// 一覧のカードと間取り図は開いた瞬間に見たいので、見送り以外の部屋の分だけ先に取得しておく
export function prefetchTargets(db: Database): string[] {
	const rows = db
		.query<Row, []>(
			`SELECT l.unit_key, l.images, l.rent + l.admin_fee AS total FROM listings l
			JOIN units u ON u.unit_key = l.unit_key WHERE u.status != '見送り' ORDER BY l.unit_key, total, l.last_seen DESC, l.listing_id`,
		)
		.all();
	const urls = new Set<string>();
	for (const listings of Map.groupBy(rows, (r) => r.unit_key).values()) {
		const parsed = listings.map((l) => ({
			images: JSON.parse(l.images) as RoomImage[],
		}));
		// 一覧のカードは家賃が最も安い掲載の1枚目を出す (queries.ts の代表の選び方と同じ)
		const thumbnail = parsed[0]?.images[0];
		const floorPlan = pickGallerySource(parsed)?.images.find(isFloorPlan);
		for (const image of [thumbnail, floorPlan]) if (image) urls.add(image.url);
	}
	return [...urls];
}

export async function runPrefetch({
	db,
	images,
	log,
}: PrefetchDeps): Promise<{ fetched: number; stopped: string | null }> {
	const cached = new Set(
		db
			.query<{ url: string }, []>("SELECT url FROM images")
			.all()
			.map((r) => r.url),
	);
	const pending = prefetchTargets(db).filter((url) => !cached.has(url));
	let fetched = 0;
	for (const url of pending) {
		try {
			if (await images.get(url)) fetched++;
		} catch (error) {
			if (!(error instanceof FetchStopped)) throw error;
			log(`写真の先回り取得を止めた: ${error.message}`);
			return { fetched, stopped: error.reason };
		}
	}
	return { fetched, stopped: null };
}
