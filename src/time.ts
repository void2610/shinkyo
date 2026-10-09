export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const weekdays = [
	"sun",
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
] as const;
export type Weekday = (typeof weekdays)[number];

export type HourRange = { start: number; end: number };

export type JstParts = {
	date: string;
	minutes: number;
	weekday: Weekday;
};

const jstFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	weekday: "short",
	hourCycle: "h23",
});

export function jst(at: Date): JstParts {
	const parts = Object.fromEntries(
		jstFormat.formatToParts(at).map((p) => [p.type, p.value]),
	);
	const weekday = String(parts.weekday).toLowerCase().slice(0, 3) as Weekday;
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		minutes: Number(parts.hour) * 60 + Number(parts.minute),
		weekday,
	};
}

export function parseHourRange(text: string): HourRange {
	const [start, end] = text.split("-").map((hm) => {
		const [h, m] = hm.split(":").map(Number);
		return (h ?? 0) * 60 + (m ?? 0);
	});
	return { start: start ?? 0, end: end ?? 0 };
}

export const inHourRange = (minutes: number, range: HourRange): boolean =>
	range.start <= minutes && minutes < range.end;

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
