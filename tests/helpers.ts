import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/store/db.ts";

export const fixture = (name: string): Promise<string> =>
	Bun.file(join(import.meta.dir, "fixtures", "suumo", name)).text();

export const memoryDb = (): Database => openDb(":memory:");

// 手元の *.local.yaml (実際の条件) に左右されないよう、テストは常にリポジトリのサンプルを読む
export const repoConfig = (): Promise<Config> =>
	loadConfig(join(import.meta.dir, "..", "config"), { local: false });

// JST 2026-10-12(月) 10:00
export const MONDAY_10_JST = new Date("2026-10-12T01:00:00Z");

export class FakeClock {
	constructor(private now: Date) {}
	readonly read = (): Date => new Date(this.now);
	advance(ms: number): void {
		this.now = new Date(this.now.getTime() + ms);
	}
	set(at: Date): void {
		this.now = new Date(at);
	}
}

export type Route = { status?: number; body: string };

export function fakeFetch(routes: Record<string, Route | (() => Route)>) {
	const calls: string[] = [];
	const impl = async (url: string): Promise<Response> => {
		calls.push(url);
		const route = routes[url];
		const r = typeof route === "function" ? route() : route;
		if (!r) return new Response("not found", { status: 404 });
		return new Response(r.body, { status: r.status ?? 200 });
	};
	return { impl, calls };
}
