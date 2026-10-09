import { z } from "zod";
import {
	judgments,
	type UnitFlag,
	unitFlags,
	unitStatuses,
} from "../domain.ts";
import { sortKeys, type UnitFilter } from "./queries.ts";

const positive = z.coerce.number().positive().nullable().catch(null);
const flagSet = new Set<string>(unitFlags);

// 空欄や不正な値は「指定なし」として扱い、エラーにしない
export function parseFilter(query: URLSearchParams): UnitFilter {
	const one = (name: string) => query.get(name) || null;
	const tags = query.getAll("tag").filter((t) => flagSet.has(t.slice(1)));
	const maxRentMan = positive.parse(one("max_rent"));
	return {
		status: z
			.enum(["active", "all", ...unitStatuses])
			.catch("active")
			.parse(one("status")),
		judgment: z
			.enum(["all", "none", ...judgments])
			.catch("all")
			.parse(one("judgment")),
		sort: z
			.enum(Object.keys(sortKeys) as [keyof typeof sortKeys])
			.catch("new")
			.parse(one("sort")),
		maxRent: maxRentMan === null ? null : Math.round(maxRentMan * 10000),
		minArea: positive.parse(one("min_area")),
		maxWalk: positive.parse(one("max_walk")),
		maxAge: positive.parse(one("max_age")),
		layouts: query.getAll("layout").filter(Boolean),
		station: one("station"),
		withFlags: tags
			.filter((t) => t.startsWith("+"))
			.map((t) => t.slice(1) as UnitFlag),
		withoutFlags: tags
			.filter((t) => t.startsWith("-"))
			.map((t) => t.slice(1) as UnitFlag),
		features: query.getAll("feature").filter(Boolean),
	};
}
