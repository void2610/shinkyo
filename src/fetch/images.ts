import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { kindOf } from "../images/kinds.ts";
import type { Clock } from "../time.ts";
import { isImageUrl, type RoomImage } from "./parse.ts";
import type { HttpClient } from "./suumo.ts";

export const isFloorPlan = (image: RoomImage): boolean =>
	kindOf(image) === "floor_plan";

// 説明付きの画像は詳細を取得した掲載にしかないので、説明の多い掲載を写真の出どころにする
export function pickGallerySource<T extends { images: RoomImage[] }>(
	listings: T[],
): T | undefined {
	const captioned = (l: T) => l.images.filter((i) => i.caption).length;
	return [...listings].sort(
		(a, b) => captioned(b) - captioned(a) || b.images.length - a.images.length,
	)[0];
}

export type StoredImage = { path: string; contentType: string };

export type ImageStore = { get: (url: string) => Promise<StoredImage | null> };

const extensionOf = (contentType: string, url: string): string => {
	if (contentType.includes("png")) return ".png";
	if (contentType.includes("webp")) return ".webp";
	if (contentType.includes("gif")) return ".gif";
	return extname(new URL(url).pathname) || ".jpg";
};

// 掲載が終わっても見返せるよう、一度取得した画像は消さずに残す
export function createImageStore(deps: {
	db: Database;
	client: Pick<HttpClient, "get">;
	dir: string;
	clock: Clock;
}): ImageStore {
	const { db, client, dir, clock } = deps;
	const pending = new Map<string, Promise<StoredImage | null>>();

	const cached = (url: string): StoredImage | null => {
		const row = db
			.query<{ path: string; content_type: string }, [string]>(
				"SELECT path, content_type FROM images WHERE url = ?",
			)
			.get(url);
		return row ? { path: row.path, contentType: row.content_type } : null;
	};

	const download = async (url: string): Promise<StoredImage | null> => {
		const res = await client.get(url);
		if (res.status !== 200 || !res.contentType.startsWith("image/"))
			return null;
		mkdirSync(dir, { recursive: true });
		const path = join(
			dir,
			`${new Bun.CryptoHasher("sha1").update(url).digest("hex")}${extensionOf(res.contentType, url)}`,
		);
		await Bun.write(path, res.bytes);
		db.query(
			"INSERT OR REPLACE INTO images (url, path, content_type, fetched_at) VALUES (?, ?, ?, ?)",
		).run(url, path, res.contentType, clock().toISOString());
		return { path, contentType: res.contentType };
	};

	return {
		async get(url) {
			if (!isImageUrl(url)) return null;
			const hit = cached(url);
			if (hit && (await Bun.file(hit.path).exists())) return hit;
			// 同じ画像への同時リクエストは1回の取得にまとめる
			const inflight =
				pending.get(url) ?? download(url).finally(() => pending.delete(url));
			pending.set(url, inflight);
			return inflight;
		},
	};
}
