import { z } from "zod";
import type { LatLon } from "./gsi.ts";

export const NAVITIME_HOST = "navitime-route-totalnavi.p.rapidapi.com";

export type Route = {
	minutes: number;
	transfers: number;
	walkMin: number;
	lines: string[];
};
export type RouteFinder = (
	from: LatLon,
	to: LatLon,
	arriveAt: string,
) => Promise<Route | null>;

const sectionSchema = z.object({
	type: z.string(),
	move: z.string().optional(),
	time: z.number().optional(),
	line_name: z.string().optional(),
});
const responseSchema = z.object({
	items: z
		.array(
			z.object({
				summary: z.object({
					move: z.object({ time: z.number(), transit_count: z.number() }),
				}),
				sections: z.array(sectionSchema),
			}),
		)
		.default([]),
});

export function parseRoute(body: unknown): Route | null {
	const [item] = responseSchema.parse(body).items;
	if (!item) return null;
	const moves = item.sections.filter((s) => s.type === "move");
	const walks = moves.filter((s) => s.move === "walk");
	return {
		minutes: item.summary.move.time,
		transfers: item.summary.move.transit_count,
		walkMin: walks.reduce((sum, s) => sum + (s.time ?? 0), 0),
		lines: moves
			.filter((s) => s.move !== "walk" && s.line_name)
			.map((s) => s.line_name ?? ""),
	};
}

export function createNavitime(options: {
	apiKey: string;
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
}): RouteFinder {
	return async (from, to, arriveAt) => {
		const query = new URLSearchParams({
			start: `${from.lat},${from.lon}`,
			goal: `${to.lat},${to.lon}`,
			goal_time: arriveAt,
			limit: "1",
		});
		const res = await options.fetchImpl(
			`https://${NAVITIME_HOST}/route_transit?${query}`,
			{
				headers: {
					"x-rapidapi-key": options.apiKey,
					"x-rapidapi-host": NAVITIME_HOST,
				},
			},
		);
		if (!res.ok) throw new Error(`NAVITIME: HTTP ${res.status}`);
		return parseRoute(await res.json());
	};
}

export const navitimeFromEnv = (): RouteFinder | null => {
	const apiKey = process.env.RAPIDAPI_KEY;
	return apiKey ? createNavitime({ apiKey, fetchImpl: fetch }) : null;
};
