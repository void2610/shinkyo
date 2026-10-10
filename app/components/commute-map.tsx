import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { minutesTone, type WorkplaceView } from "./commute";

export type MapPoint = {
	address: string;
	lat: number;
	lon: number;
	minutes: number | null;
	count: number;
};

// 地理院タイル (淡色地図)。キー不要で、出典の表示だけが条件
const STYLE = {
	version: 8 as const,
	sources: {
		gsi: {
			type: "raster" as const,
			tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
			tileSize: 256,
			maxzoom: 18,
			attribution:
				'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル</a>',
		},
	},
	layers: [{ id: "gsi", type: "raster" as const, source: "gsi" }],
};

// 塗りは通勤時間の色なので変えず、選んだピンは青い輪と大きさで、ほかのピンは薄くして見分ける
const pinClass = (p: MapPoint, state: "active" | "dimmed" | "normal") =>
	`block cursor-pointer rounded-full border-2 border-white px-2 py-0.5 text-xs font-semibold whitespace-nowrap shadow-md tabular-nums ${minutesTone(p.minutes)} ${
		state === "active"
			? "scale-150 ring-4 ring-sky-500 shadow-xl"
			: state === "dimmed"
				? "opacity-40"
				: ""
	}`;

const pinText = (p: MapPoint) =>
	`${p.minutes === null ? "?" : `${p.minutes}分`}${p.count > 1 ? `・${p.count}件` : ""}`;

// maplibre は地図を動かすたびに transform でピンを動かすので、ピンに transition を付けると追従が遅れる
// maplibre は window を使うので、ブラウザでだけ読み込む
export function CommuteMap({
	points,
	workplaces,
	active,
	center,
	onSelect,
}: {
	points: MapPoint[];
	workplaces: WorkplaceView[];
	// active は目立たせる点、center は地図を寄せる点 (一覧にマウスを載せただけでは地図を動かさない)
	active: string | null;
	center: string | null;
	onSelect: (address: string | null) => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const [map, setMap] = useState<MapLibreMap | null>(null);
	const lib = useRef<typeof import("maplibre-gl") | null>(null);
	const markers = useRef(
		new Map<string, { marker: Marker; el: HTMLElement; pin: HTMLElement }>(),
	);
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	// 職場は設定から来るので画面を開いている間は変わらず、地図は1度だけ作る
	const workplacesRef = useRef(workplaces);
	const pointsRef = useRef(points);
	pointsRef.current = points;
	const fitted = useRef(false);

	useEffect(() => {
		let disposed = false;
		let created: MapLibreMap | null = null;
		Promise.all([
			import("maplibre-gl"),
			// v6 は worker を別ファイルから読むが、Vite は自動では同梱しないので URL を渡す
			import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
		]).then(([maplibre, worker]) => {
			if (disposed || !container.current) return;
			maplibre.setWorkerUrl(worker.default);
			lib.current = maplibre;
			created = new maplibre.Map({
				container: container.current,
				style: STYLE,
				center: [139.76, 35.68],
				zoom: 11,
			});
			created.addControl(
				new maplibre.NavigationControl({ showCompass: false }),
				"top-right",
			);
			for (const w of workplacesRef.current) {
				const el = document.createElement("div");
				el.className =
					"rounded-md bg-foreground px-2 py-1 text-xs font-semibold text-background shadow-lg";
				el.textContent = `★ ${w.name}`;
				new maplibre.Marker({ element: el })
					.setLngLat([w.lon, w.lat])
					.addTo(created);
			}
			setMap(created);
		});
		return () => {
			disposed = true;
			created?.remove();
		};
	}, []);

	useEffect(() => {
		const maplibre = lib.current;
		if (!map || !maplibre) return;
		const current = markers.current;
		const seen = new Set<string>();
		for (const p of points) {
			seen.add(p.address);
			let entry = current.get(p.address);
			if (!entry) {
				// el の class は maplibre が位置決めに使う (maplibregl-marker) ので触らず、見た目は内側の pin に持たせる
				const el = document.createElement("div");
				const pin = document.createElement("button");
				pin.type = "button";
				pin.addEventListener("click", (e) => {
					e.stopPropagation();
					onSelectRef.current(p.address);
				});
				el.append(pin);
				const marker = new maplibre.Marker({ element: el })
					.setLngLat([p.lon, p.lat])
					.addTo(map);
				entry = { marker, el, pin };
				current.set(p.address, entry);
			}
			entry.pin.className = pinClass(
				p,
				p.address === active ? "active" : active ? "dimmed" : "normal",
			);
			entry.pin.textContent = pinText(p);
			entry.pin.title = p.address;
			entry.el.style.zIndex = p.address === active ? "10" : "";
		}
		for (const [address, entry] of current) {
			if (seen.has(address)) continue;
			entry.marker.remove();
			current.delete(address);
		}
		if (!fitted.current && (points.length > 0 || workplaces.length > 0)) {
			fitted.current = true;
			const bounds = new maplibre.LngLatBounds();
			for (const p of points) bounds.extend([p.lon, p.lat]);
			for (const w of workplaces) bounds.extend([w.lon, w.lat]);
			map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
		}
	}, [map, points, workplaces, active]);

	// 選び直したときだけ動かし、絞り込みで点が変わっても地図を飛ばさない
	useEffect(() => {
		const p = pointsRef.current.find((x) => x.address === center);
		if (map && p) map.easeTo({ center: [p.lon, p.lat], duration: 500 });
	}, [map, center]);

	return <div ref={container} className="size-full" />;
}
