import type { Database } from "bun:sqlite";
import { createContext } from "react-router";
import type { Workplace } from "../src/commute/workplace.ts";
import type { Clock } from "../src/time.ts";

// Hono の入口で作って loader / action に渡す。DB や人の見分けは画面側では作らない
export type AppContext = {
	db: Database;
	clock: Clock;
	// 操作した人 (Cloudflare Access のメールアドレス、開発時は local)。権限の区別には使わない
	person: string;
	people: Record<string, string>;
	workplaces: Workplace[];
};

// Hono の入口 (ソースを読む) と画面のビルド (同梱のコピーを読む) で同じキーを共有するため、globalThis に1つだけ置く
const shared = globalThis as typeof globalThis & {
	__shinkyoAppContext?: ReturnType<typeof createContext<AppContext>>;
};
shared.__shinkyoAppContext ??= createContext<AppContext>();
export const appContext = shared.__shinkyoAppContext;
