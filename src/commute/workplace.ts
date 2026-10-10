export type Workplace = {
	name: string;
	lat: number;
	lon: number;
	// この時刻に着くように調べる (HH:MM、JST)
	arrive_by: string;
};

// 名前を変えても調べ直さず、場所か到着時刻を変えたときだけ調べ直すよう、キーには名前を含めない
export const workplaceKey = (w: Workplace): string =>
	`${w.lat.toFixed(5)},${w.lon.toFixed(5)}@${w.arrive_by}`;

// 週末や祝日の時刻表で調べないよう、明日以降で最初の水曜を使う
export function arrivalTime(now: Date, arriveBy: string): string {
	const jstNow = new Date(now.getTime() + 9 * 3600_000);
	const ahead = (3 - jstNow.getUTCDay() + 7) % 7 || 7;
	const day = new Date(jstNow.getTime() + ahead * 86400_000);
	return `${day.toISOString().slice(0, 10)}T${arriveBy}:00`;
}
