import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { judgments, unitStatuses } from "./domain.ts";
import { parseHourRange, weekdays } from "./time.ts";

const hourRange = z
	.string()
	.regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
	.transform(parseHourRange);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const policySchema = z.object({
	paused: z.boolean(),
	fetch: z.object({
		active_hours: hourRange,
		interval_min: z.number().int().positive(),
		request_gap_sec: z.number().min(0),
		jitter_sec: z.number().min(0),
		max_pages_per_search: z.number().int().positive(),
		daily_request_cap: z.number().int().positive(),
		stop_on_status: z.array(z.number().int()),
	}),
	mail: z.object({
		send_hours: hourRange,
		send_slots: z.array(hhmm),
		no_followup_weekdays: z.array(z.enum(weekdays)),
		followup_after_hours: z.number().positive(),
		auto_send_categories: z.array(z.string()),
		auto_send_to_roles: z.array(z.enum(["hub", "candidate", "excluded"])),
		auto_send_daily_cap: z.number().int().min(0),
	}),
	stop_inquiries_when_status: z.array(z.enum(unitStatuses)),
	stop_fetch_when_status: z.array(z.enum(unitStatuses)),
});
export type Policy = z.infer<typeof policySchema>;
export type FetchPolicy = Policy["fetch"] & { paused: boolean };

export const criteriaSchema = z.object({
	hard: z.object({
		rent_total_max: z.number().int().positive(),
		area_min_m2: z.number().positive(),
		walk_max_min: z.number().int().positive(),
		built_from: z.string().regex(/^\d{4}-\d{2}$/),
		floor_min: z.number().int(),
		layouts: z.array(z.string()),
		exclude: z.array(z.string()),
	}),
	weights: z.record(z.string(), z.number().min(0)),
	features: z.array(z.string()),
	notify_min_score: z.number().min(0).max(100),
});
export type Criteria = z.infer<typeof criteriaSchema>;

export const searchesSchema = z.object({
	searches: z
		.array(z.object({ id: z.string().min(1), url: z.url() }))
		.nullable()
		.transform((s) => s ?? []),
});
export type Search = z.infer<typeof searchesSchema>["searches"][number];

export const stationsSchema = z.object({
	stations: z
		.record(z.string(), z.number().int().min(0))
		.nullable()
		.transform((s) => s ?? {}),
});

// 個人情報の入力は後回しにできるよう、全項目を省略可能にする
export const profileSchema = z.object({
	name: z.string().optional(),
	signature: z.string().optional(),
	move_in: z.string().optional(),
	people: z.number().int().positive().optional(),
	job_income: z.string().optional(),
	viewing_windows: z.array(z.string()).optional(),
	call_window: z.string().optional(),
	ntfy_server: z.url().default("https://ntfy.sh"),
	ntfy_topic: z.string().optional(),
	web: z
		.object({
			owner_logins: z.array(z.string()).default([]),
			// tailscale serve で公開する URL の origin (例: https://m1.example.ts.net)
			allowed_origins: z.array(z.url()).default([]),
		})
		.default({ owner_logins: [], allowed_origins: [] }),
});
export type Profile = z.infer<typeof profileSchema>;

export const judgmentSchema = z.enum(judgments);

export type Config = {
	policy: Policy;
	criteria: Criteria;
	searches: Search[];
	stations: Record<string, number>;
	profile: Profile;
};

async function readYaml(path: string): Promise<unknown> {
	return parse(await Bun.file(path).text());
}

async function readOptionalYaml(path: string): Promise<unknown> {
	const file = Bun.file(path);
	return (await file.exists()) ? (parse(await file.text()) ?? {}) : {};
}

export async function loadConfig(dir = "config"): Promise<Config> {
	const load = async <T>(
		name: string,
		schema: z.ZodType<T>,
		optional = false,
	): Promise<T> => {
		const path = join(dir, name);
		const result = schema.safeParse(
			optional ? await readOptionalYaml(path) : await readYaml(path),
		);
		if (!result.success) {
			throw new Error(
				`${path} の内容が不正です\n${z.prettifyError(result.error)}`,
			);
		}
		return result.data;
	};
	return {
		policy: await load("policy.yaml", policySchema),
		criteria: await load("criteria.yaml", criteriaSchema),
		searches: (await load("searches.yaml", searchesSchema)).searches,
		stations: (await load("stations.yaml", stationsSchema)).stations,
		profile: await load("profile.local.yaml", profileSchema, true),
	};
}
