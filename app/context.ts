import type { Database } from "bun:sqlite";
import { createContext } from "react-router";
import type { Clock } from "../src/time.ts";

export type Role = "owner" | "viewer";

// Hono の入口で作って loader / action に渡す。DB や権限は画面側では作らない
export type AppContext = { db: Database; clock: Clock; role: Role };

// Hono の入口 (ソースを読む) と画面のビルド (同梱のコピーを読む) で同じキーを共有するため、globalThis に1つだけ置く
const shared = globalThis as typeof globalThis & {
	__shinkyoAppContext?: ReturnType<typeof createContext<AppContext>>;
};
shared.__shinkyoAppContext ??= createContext<AppContext>();
export const appContext = shared.__shinkyoAppContext;
