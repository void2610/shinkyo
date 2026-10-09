export type UnitKeySource = {
	buildingName: string;
	address: string;
	floor: number | null;
	areaM2: number;
	layout: string;
	rent: number;
};

export function normalizeName(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\-‐‑–—―・/()[\]【】「」『』,.、。'"&]/g, "");
}

// 番地以降は掲載ごとに書き方が違うので、丁目までで切る
export function normalizeAddress(text: string): string {
	const t = text.normalize("NFKC").replace(/\s/g, "");
	const chome = t.match(/^(.*?\d+丁目)/);
	if (chome?.[1]) return normalizeName(chome[1]);
	const numbered = t.match(/^(\D*?)(\d+)/);
	if (numbered?.[1] !== undefined && numbered[2])
		return normalizeName(`${numbered[1]}${numbered[2]}丁目`);
	return normalizeName(t);
}

// 「〇〇駅の賃貸」のような名前は別の建物どうしで重なるので建物名として使わない
export const isGenericBuildingName = (name: string): boolean =>
	normalizeName(name) === "" ||
	/の賃貸|^賃貸(マンション|アパート)?$|^(マンション|アパート)$/.test(
		normalizeName(name),
	);

const roundArea = (area: number): string =>
	(Math.round(area * 2) / 2).toFixed(1);

export function unitKey(s: UnitKeySource): string {
	const floor = s.floor ?? "?";
	const layout = normalizeName(s.layout);
	const address = normalizeAddress(s.address);
	if (isGenericBuildingName(s.buildingName)) {
		return ["a", address, floor, roundArea(s.areaM2), layout, s.rent].join("|");
	}
	return [
		"b",
		normalizeName(s.buildingName),
		address,
		floor,
		roundArea(s.areaM2),
		layout,
	].join("|");
}

// 面積だけが少し違う掲載は同じ部屋の可能性があるが、自動では統合せず人に見せる
export function isMergeCandidate(a: UnitKeySource, b: UnitKeySource): boolean {
	if (unitKey(a) === unitKey(b)) return false;
	const sameBuilding =
		!isGenericBuildingName(a.buildingName) &&
		normalizeName(a.buildingName) === normalizeName(b.buildingName);
	const samePlace = normalizeAddress(a.address) === normalizeAddress(b.address);
	return (
		(sameBuilding || samePlace) &&
		a.floor === b.floor &&
		normalizeName(a.layout) === normalizeName(b.layout) &&
		Math.abs(a.areaM2 - b.areaM2) <= 1
	);
}
