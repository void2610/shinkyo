import { ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { parseFilter } from "../../src/web/filter.ts";
import {
	formatMan,
	imagePath,
	unitName,
	unitPath,
} from "../../src/web/format.ts";
import {
	countByStatus,
	filterOptions,
	listUnits,
	type UnitRow,
} from "../../src/web/queries.ts";
import {
	CommuteSummary,
	MINUTE_STEPS,
	minutesOf,
	UNKNOWN_TONE,
	type WorkplaceView,
	workplaceViews,
} from "../components/commute";
import { CommuteMap, type MapPoint } from "../components/commute-map";
import { FilterBar } from "../components/filter-bar";
import { appContext } from "../context";
import type { Route } from "./+types/map";

export const meta: Route.MetaFunction = () => [
	{ title: "地図と通勤 | shinkyo" },
];

// 地図は横幅いっぱいに使う (root の Layout が見る)
export const handle = { wide: true };

export function loader({ request, context }: Route.LoaderArgs) {
	const { db, clock, person, workplaces } = context.get(appContext);
	const url = new URL(request.url);
	const filter = parseFilter(url.searchParams);
	return {
		units: listUnits(db, filter, clock().getFullYear(), person, workplaces),
		filter,
		options: filterOptions(db),
		counts: Object.fromEntries(countByStatus(db)),
		workplaces: workplaceViews(workplaces),
		focus: url.searchParams.get("unit"),
	};
}

const MAX = "max";

// 行を押すと地図でその場所を選ぶ。物件ページは右下の小さなボタンから開く
function UnitItem({
	unit,
	workplaces,
	picked,
	onPick,
	onHover,
}: {
	unit: UnitRow;
	workplaces: WorkplaceView[];
	picked: boolean;
	onPick: () => void;
	onHover: (address: string | null) => void;
}) {
	return (
		<li
			data-unit={unit.unit_key}
			className={`flex items-start border-b ${picked ? "bg-accent" : "hover:bg-muted/50"}`}
			onMouseEnter={() => onHover(unit.address)}
			onMouseLeave={() => onHover(null)}
		>
			<button
				type="button"
				onClick={onPick}
				className="flex min-w-0 flex-1 cursor-pointer gap-3 p-3 text-left"
			>
				<span className="relative h-16 w-20 shrink-0 overflow-hidden rounded bg-muted">
					{unit.images.length > 0 && (
						<img
							className="absolute inset-0 size-full object-cover"
							src={imagePath(unit.listing_id, 0)}
							alt=""
							loading="lazy"
						/>
					)}
				</span>
				<span className="grid min-w-0 flex-1 gap-1">
					<span className="truncate text-sm font-medium" title={unitName(unit)}>
						{unitName(unit)}
					</span>
					<span className="flex flex-wrap gap-x-2 text-sm">
						<span className="font-semibold">{formatMan(unit.rent)}</span>
						<span className="text-muted-foreground">
							+{formatMan(unit.admin_fee)}・{unit.area_m2}㎡
						</span>
					</span>
					{unit.lat === null && (
						<span className="text-xs text-muted-foreground">
							位置をまだ調べていない
						</span>
					)}
					<CommuteSummary unit={unit} workplaces={workplaces} />
				</span>
			</button>
			<Button
				variant="ghost"
				size="icon-xs"
				className="mr-2 mb-3 shrink-0 self-end text-muted-foreground"
				nativeButton={false}
				aria-label="物件ページを開く"
				title="物件ページを開く"
				render={<Link to={unitPath(unit.unit_key)} />}
			>
				<ArrowUpRight />
			</Button>
		</li>
	);
}

export default function MapPage({ loaderData }: Route.ComponentProps) {
	const { units, filter, options, counts, workplaces, focus } = loaderData;
	const [by, setBy] = useState(MAX);
	// selected は地図のピンで選んだ地点 (一覧をその地点に絞る)、picked は一覧で選んだ部屋 (地図をそこへ寄せる)
	const [selected, setSelected] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(focus);
	const [hovered, setHovered] = useState<string | null>(null);
	const pickedAddress =
		units.find((u) => u.unit_key === picked)?.address ?? null;
	// 詳細ページの「地図で見る」から来たときは、その部屋を一覧で見える位置に出す
	useEffect(() => {
		if (!focus) return;
		document
			.querySelector(`[data-unit="${CSS.escape(focus)}"]`)
			?.scrollIntoView({ block: "center" });
	}, [focus]);
	const key = by === MAX ? null : by;

	const located = units.filter((u) => u.lat !== null && u.lon !== null);
	const unlocated = units.length - located.length;
	const points = useMemo<MapPoint[]>(() => {
		const groups = Map.groupBy(
			units.filter((u) => u.lat !== null && u.lon !== null),
			(u) => u.address,
		);
		return [...groups.entries()].map(([address, us]) => {
			const known = us
				.map((u) => minutesOf(u, key))
				.filter((m): m is number => m !== null);
			return {
				address,
				lat: us[0]?.lat ?? 0,
				lon: us[0]?.lon ?? 0,
				// 同じ町丁目の部屋はまとめて1つの点にし、いちばん近い部屋の時間を出す
				minutes: known.length > 0 ? Math.min(...known) : null,
				count: us.length,
			};
		});
	}, [units, key]);

	const shown = [
		...(selected ? units.filter((u) => u.address === selected) : units),
	].sort(
		(a, b) =>
			(minutesOf(a, key) ?? Number.POSITIVE_INFINITY) -
			(minutesOf(b, key) ?? Number.POSITIVE_INFINITY),
	);

	return (
		<>
			<FilterBar
				filter={filter}
				options={options}
				counts={counts}
				commute={workplaces.length > 0}
			/>
			<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				{workplaces.length > 0 ? (
					<>
						<span className="text-muted-foreground">色分け</span>
						<ToggleGroup
							value={[by]}
							onValueChange={(v) => setBy(v[0] ?? MAX)}
							variant="outline"
							size="sm"
						>
							{workplaces.length > 1 && (
								<ToggleGroupItem value={MAX}>いちばん長い人</ToggleGroupItem>
							)}
							{workplaces.map((w) => (
								<ToggleGroupItem
									key={w.key}
									value={workplaces.length > 1 ? w.key : MAX}
								>
									{w.name}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<span className="flex flex-wrap gap-1.5">
							{MINUTE_STEPS.map((s) => (
								<span
									key={s.label}
									className={`rounded px-1.5 text-xs ${s.tone}`}
								>
									{s.label}
								</span>
							))}
							<span className={`rounded px-1.5 text-xs ${UNKNOWN_TONE}`}>
								不明
							</span>
						</span>
					</>
				) : (
					<span className="text-muted-foreground">
						通勤先は config/profile.local.yaml の workplaces
						に書くと、通勤時間で色分けします。
					</span>
				)}
				<span className="ml-auto text-muted-foreground">
					地図上 {located.length} 件
					{unlocated > 0 && ` / 位置を調べていない ${unlocated} 件`}
				</span>
			</div>
			<div className="grid gap-4 lg:grid-cols-[1fr_420px]">
				<Card className="h-[72vh] min-h-[480px] overflow-hidden p-0">
					<CommuteMap
						points={points}
						workplaces={workplaces}
						active={hovered ?? pickedAddress ?? selected}
						center={pickedAddress ?? selected}
						onSelect={(address) => {
							setSelected(address);
							setPicked(null);
						}}
					/>
				</Card>
				<Card className="flex h-[72vh] min-h-[480px] flex-col gap-0 overflow-hidden p-0">
					<div className="flex items-center justify-between border-b px-3 py-2 text-sm">
						<span className="truncate font-medium">
							{selected ? `${selected} の部屋` : "通勤が短い順"} ({shown.length}
							)
						</span>
						{selected && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setSelected(null)}
							>
								すべて表示
							</Button>
						)}
					</div>
					<ul className="flex-1 overflow-y-auto">
						{shown.map((u) => (
							<UnitItem
								key={u.unit_key}
								unit={u}
								workplaces={workplaces}
								picked={u.unit_key === picked}
								onPick={() => setPicked(u.unit_key)}
								onHover={setHovered}
							/>
						))}
					</ul>
				</Card>
			</div>
		</>
	);
}
