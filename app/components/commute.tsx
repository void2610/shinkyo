import { type Workplace, workplaceKey } from "../../src/commute/workplace.ts";
import type { Commute, UnitRow } from "../../src/web/queries.ts";

export type WorkplaceView = {
	key: string;
	name: string;
	lat: number;
	lon: number;
};

export const workplaceViews = (workplaces: Workplace[]): WorkplaceView[] =>
	workplaces.map((w) => ({
		key: workplaceKey(w),
		name: w.name,
		lat: w.lat,
		lon: w.lon,
	}));

// by が null ならいちばん長い人の時間、職場のキーならその職場までの時間
export const minutesOf = (unit: UnitRow, by: string | null): number | null =>
	by === null
		? unit.max_commute
		: (unit.commutes.find((c) => c.workplace === by)?.minutes ?? null);

export const MINUTE_STEPS = [
	{ max: 30, tone: "bg-emerald-600 text-white", label: "30分以内" },
	{ max: 45, tone: "bg-amber-500 text-black", label: "45分以内" },
	{ max: 60, tone: "bg-orange-600 text-white", label: "60分以内" },
	{
		max: Number.POSITIVE_INFINITY,
		tone: "bg-red-600 text-white",
		label: "60分超",
	},
] as const;
export const UNKNOWN_TONE = "bg-zinc-500 text-white";

export const minutesTone = (minutes: number | null): string =>
	minutes === null
		? UNKNOWN_TONE
		: (MINUTE_STEPS.find((s) => minutes <= s.max)?.tone ?? UNKNOWN_TONE);

function CommuteLine({
	name,
	commute,
}: {
	name: string;
	commute: Commute | undefined;
}) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2 text-sm">
			<span className="min-w-16 text-muted-foreground">{name}</span>
			{commute?.minutes == null ? (
				<span className="text-muted-foreground">
					{commute ? "経路なし" : "未取得"}
				</span>
			) : (
				<>
					<span
						className={`rounded px-1.5 font-semibold tabular-nums ${minutesTone(commute.minutes)}`}
					>
						{commute.minutes}分
					</span>
					<span className="text-xs text-muted-foreground">
						乗換{commute.transfers ?? 0}回・徒歩{commute.walk_min ?? 0}分
						{commute.lines.length > 0 && `・${commute.lines.join(" → ")}`}
					</span>
				</>
			)}
		</div>
	);
}

// 職場ごとの通勤時間。住所の町丁目の代表点から調べた目安
export function CommuteSummary({
	unit,
	workplaces,
}: {
	unit: UnitRow;
	workplaces: WorkplaceView[];
}) {
	if (workplaces.length === 0) return null;
	return (
		<div className="grid gap-1">
			{workplaces.map((w) => (
				<CommuteLine
					key={w.key}
					name={w.name}
					commute={unit.commutes.find((c) => c.workplace === w.key)}
				/>
			))}
		</div>
	);
}
