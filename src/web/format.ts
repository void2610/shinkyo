import type { Station } from "../domain.ts";

export const formatMan = (yen: number): string => {
	if (yen === 0) return "なし";
	if (yen < 10000) return `${yen.toLocaleString()}円`;
	return `${Number((yen / 10000).toFixed(2))}万円`;
};

export const formatMonths = (amount: number, rent: number): string =>
	amount === 0
		? "なし"
		: rent > 0
			? `${Number((amount / rent).toFixed(2))}か月`
			: formatMan(amount);

export const formatFloor = (floor: number | null): string =>
	floor === null ? "階不明" : floor < 0 ? `B${-floor}階` : `${floor}階`;

export const formatAge = (age: number | null, ym: string | null): string => {
	if (ym) return `${ym.replace("-", "年")}月築`;
	if (age === null) return "築年不明";
	return age === 0 ? "新築" : `築${age}年`;
};

export const formatStation = (s: Station): string =>
	`${s.station} 歩${s.walkMin}分`;

export const unitName = (u: {
	building_name: string;
	floor: number | null;
	layout: string;
}): string =>
	`${u.building_name.normalize("NFKC")} ${formatFloor(u.floor)} ${u.layout}`;

const jstFormat = new Intl.DateTimeFormat("ja-JP", {
	timeZone: "Asia/Tokyo",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export const formatAt = (iso: string): string =>
	jstFormat.format(new Date(iso));

export const imagePath = (listingId: string, index: number): string =>
	`/images/${encodeURIComponent(listingId)}/${index}`;

export const unitPath = (key: string): string =>
	`/units/${encodeURIComponent(key)}`;

// Access のメールアドレスに表示名が無ければ、@ より前を名前として出す
export const displayName = (
	people: Record<string, string>,
	person: string,
): string =>
	people[person] ??
	(person === "local" ? "自分" : (person.split("@")[0] ?? person));
