import { type HTMLElement, parse } from "node-html-parser";
import type { Station } from "../domain.ts";

export const SUUMO_ORIGIN = "https://suumo.jp";

export type ListedRoom = {
	listingId: string;
	url: string;
	buildingName: string;
	propertyType: string | null;
	address: string;
	stations: Station[];
	builtAge: number | null;
	buildingFloors: string | null;
	floor: number | null;
	rent: number;
	adminFee: number;
	deposit: number;
	keyMoney: number;
	layout: string;
	areaM2: number;
	isNewArrival: boolean;
	images: RoomImage[];
};

export type ListPage = {
	rooms: ListedRoom[];
	nextUrl: string | null;
	hitCount: number | null;
};

export type RoomImage = {
	url: string;
	caption: string | null;
};

export type RoomDetail = {
	listingId: string | null;
	agentName: string | null;
	builtYm: string | null;
	orientation: string | null;
	features: string[];
	otherCosts: string | null;
	guarantor: string | null;
	notes: string | null;
	images: RoomImage[];
};

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

const childElements = (el: HTMLElement, tag: string): HTMLElement[] =>
	el.childNodes.filter(
		(n): n is HTMLElement =>
			"tagName" in n && (n as HTMLElement).tagName === tag,
	);

// 「28万円」「10000円」「-」を円に直す
export function parseYen(text: string): number {
	const t = clean(text).normalize("NFKC");
	const man = t.match(/([\d.]+)万円/);
	if (man?.[1]) return Math.round(Number(man[1]) * 10000);
	const yen = t.match(/([\d,]+)円/);
	if (yen?.[1]) return Number(yen[1].replaceAll(",", ""));
	return 0;
}

// 「4階」「B1階」「1-2階」の先頭の階を数値にする。地下は負数
export function parseFloor(text: string): number | null {
	const m = clean(text)
		.normalize("NFKC")
		.match(/(B)?(\d+)/);
	if (!m?.[2]) return null;
	return m[1] ? -Number(m[2]) : Number(m[2]);
}

export function parseAge(text: string): number | null {
	const t = clean(text).normalize("NFKC");
	if (t.includes("新築")) return 0;
	const m = t.match(/築(\d+)年/);
	return m?.[1] ? Number(m[1]) : null;
}

export function parseStation(text: string): Station | null {
	const m = clean(text)
		.normalize("NFKC")
		.match(/^(.+?)\/(.+?)駅? 歩(\d+)分/);
	if (!m?.[1] || !m[2] || !m[3]) return null;
	return {
		line: m[1],
		station: m[2].replace(/駅$/, ""),
		walkMin: Number(m[3]),
	};
}

export const SUUMO_IMAGE_ORIGIN = "https://img01.suumo.com";

// 画像サーバーの robots.txt が許可しているのは /front/gazo/ 配下だけ
export const isImageUrl = (url: string): boolean =>
	url.startsWith(`${SUUMO_IMAGE_ORIGIN}/front/gazo/`);

const absolute = (href: string): string =>
	new URL(href, SUUMO_ORIGIN).toString();

function parseRoomRow(
	row: HTMLElement,
	building: Omit<ListedRoom, RoomOwnKeys>,
): ListedRoom | null {
	const cells = childElements(row, "TD");
	const link = row.querySelector("a.js-cassette_link_href");
	const href = link?.getAttribute("href");
	const listingId =
		row.querySelector("input.js-clipkey")?.getAttribute("value") ??
		row.querySelector("input[name=bc]")?.getAttribute("value");
	if (!href || !listingId) return null;
	return {
		...building,
		listingId,
		url: absolute(href),
		floor: parseFloor(cells[2]?.text ?? ""),
		rent: parseYen(row.querySelector(".cassetteitem_price--rent")?.text ?? ""),
		adminFee: parseYen(
			row.querySelector(".cassetteitem_price--administration")?.text ?? "",
		),
		deposit: parseYen(
			row.querySelector(".cassetteitem_price--deposit")?.text ?? "",
		),
		keyMoney: parseYen(
			row.querySelector(".cassetteitem_price--gratuity")?.text ?? "",
		),
		layout: clean(
			row.querySelector(".cassetteitem_madori")?.text ?? "",
		).normalize("NFKC"),
		areaM2:
			Number.parseFloat(
				clean(row.querySelector(".cassetteitem_menseki")?.text ?? "").normalize(
					"NFKC",
				),
			) || 0,
		isNewArrival:
			row.querySelector(".cassetteitem_other-checkbox--newarrival") !== null,
		images: (row.querySelector("[data-imgs]")?.getAttribute("data-imgs") ?? "")
			.split(",")
			.map((url) => url.trim())
			.filter(isImageUrl)
			.map((url) => ({ url, caption: null })),
	};
}

type RoomOwnKeys =
	| "listingId"
	| "url"
	| "floor"
	| "rent"
	| "adminFee"
	| "deposit"
	| "keyMoney"
	| "layout"
	| "areaM2"
	| "isNewArrival"
	| "images";

export function parseListPage(html: string): ListPage {
	const root = parse(html);
	const rooms = root.querySelectorAll(".cassetteitem").flatMap((cassette) => {
		const col3 = cassette
			.querySelectorAll(".cassetteitem_detail-col3 > div")
			.map((d) => clean(d.text));
		const building = {
			buildingName: clean(
				cassette.querySelector(".cassetteitem_content-title")?.text ?? "",
			),
			propertyType:
				clean(
					cassette.querySelector(".cassetteitem_content-label")?.text ?? "",
				) || null,
			address: clean(
				cassette.querySelector(".cassetteitem_detail-col1")?.text ?? "",
			),
			stations: cassette
				.querySelectorAll(".cassetteitem_detail-col2 .cassetteitem_detail-text")
				.map((d) => parseStation(d.text))
				.filter((s): s is Station => s !== null),
			builtAge: parseAge(col3[0] ?? ""),
			buildingFloors: col3[1] ?? null,
		};
		return cassette
			.querySelectorAll("table.cassetteitem_other tr.js-cassette_link")
			.map((row) => parseRoomRow(row, building))
			.filter((r): r is ListedRoom => r !== null);
	});
	const next = root
		.querySelectorAll(".pagination-parts a")
		.find((a) => clean(a.text) === "次へ");
	const nextHref = next?.getAttribute("href");
	const hit = root
		.querySelector(".pagination_set-hit")
		?.childNodes[0]?.text.replace(/[^\d]/g, "");
	return {
		rooms,
		nextUrl: nextHref ? absolute(nextHref.replaceAll("&amp;", "&")) : null,
		hitCount: hit ? Number(hit) : null,
	};
}

function tableEntries(
	root: HTMLElement,
	selector: string,
): Map<string, string> {
	const entries = new Map<string, string>();
	for (const row of root.querySelectorAll(`${selector} tr`)) {
		const cells = row.childNodes.filter(
			(n): n is HTMLElement =>
				"tagName" in n && ["TH", "TD"].includes((n as HTMLElement).tagName),
		);
		for (let i = 0; i + 1 < cells.length; i += 2) {
			const th = cells[i];
			const td = cells[i + 1];
			if (th?.tagName === "TH" && td)
				entries.set(th.text.replace(/\s/g, ""), clean(td.text));
		}
	}
	return entries;
}

const orNull = (text: string | undefined): string | null =>
	text && text !== "-" ? text : null;

// 定期借家は契約期間の行に出ることも条件や備考に出ることもあるので、まとめて残す
function noteOf(outline: Map<string, string>): string | null {
	const picked = ["契約期間", "条件", "備考"].map((k) =>
		orNull(outline.get(k)),
	);
	const fixedTerm = [...outline.values()].find((v) => v.includes("定期借家"));
	const notes = [
		...new Set(
			[...picked, fixedTerm ?? null].filter((n): n is string => n !== null),
		),
	];
	return notes.length > 0 ? notes.join(" / ") : null;
}

export function parseDetailPage(html: string): RoomDetail {
	const root = parse(html);
	const outline = tableEntries(root, "table.table_gaiyou");
	const view = tableEntries(root, "table.property_view_table");
	const builtYm = outline.get("築年月")?.match(/(\d{4})年(\d{1,2})月/);
	const features = clean(root.querySelector("#bkdt-option li")?.text ?? "");
	return {
		listingId: orNull(outline.get("SUUMO物件コード")),
		agentName: orNull(
			clean(root.querySelector(".itemcassette-header-ttl")?.text ?? ""),
		),
		builtYm:
			builtYm?.[1] && builtYm[2]
				? `${builtYm[1]}-${builtYm[2].padStart(2, "0")}`
				: null,
		orientation: orNull(view.get("向き")),
		features: features
			? features
					.split("、")
					.map((f) => f.trim())
					.filter(Boolean)
			: [],
		otherCosts: orNull(outline.get("ほか初期費用")),
		guarantor: orNull(outline.get("保証会社")),
		notes: noteOf(outline),
		images: root
			.querySelectorAll("#js-view_gallery-list img")
			.map((img) => ({
				url: img.getAttribute("data-src") ?? img.getAttribute("src") ?? "",
				caption: clean(img.getAttribute("alt") ?? "") || null,
			}))
			.filter((image) => isImageUrl(image.url)),
	};
}

export const looksLikeCaptcha = (html: string): boolean =>
	/captcha/i.test(html);
