import { Link } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardFooter } from "~/components/ui/card";
import {
	formatAge,
	formatMan,
	formatMonths,
	formatStation,
	imagePath,
	unitName,
	unitPath,
} from "../../src/web/format.ts";
import type { UnitRow } from "../../src/web/queries.ts";
import {
	JudgmentControl,
	myEvaluation,
	OthersJudgments,
} from "./judgment-control";
import { Flags, ScoreBadge } from "./unit-badges";

export function UnitCard({
	unit,
	person,
	people,
}: {
	unit: UnitRow;
	person: string;
	people: Record<string, string>;
}) {
	const [first, ...restStations] = unit.stations;
	const name = unitName(unit);
	return (
		<Card className="gap-0 overflow-hidden py-0">
			<Link
				className="relative block aspect-[4/3] shrink-0 overflow-hidden bg-muted"
				to={unitPath(unit.unit_key)}
			>
				{unit.images.length > 0 ? (
					<img
						className="absolute inset-0 size-full object-cover transition-transform duration-300 hover:scale-[1.03]"
						src={imagePath(unit.listing_id, 0)}
						alt={name}
						loading="lazy"
						decoding="async"
					/>
				) : (
					<span className="flex h-full items-center justify-center text-sm text-muted-foreground">
						画像なし
					</span>
				)}
				<span className="absolute top-3 left-3 flex gap-1">
					<Badge variant="secondary" className="bg-background/90 backdrop-blur">
						{unit.status}
					</Badge>
					<ScoreBadge score={unit.score} />
				</span>
			</Link>
			<CardContent className="flex flex-1 flex-col gap-2 pt-4">
				<Link
					className="line-clamp-1 font-medium hover:underline"
					to={unitPath(unit.unit_key)}
					title={name}
				>
					{name}
				</Link>
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="text-2xl font-semibold tracking-tight">
						{formatMan(unit.rent)}
					</span>
					<span className="text-sm text-muted-foreground">
						管理費 {formatMan(unit.admin_fee)}・敷{" "}
						{formatMonths(unit.deposit, unit.rent)}・礼{" "}
						{formatMonths(unit.key_money, unit.rent)}
					</span>
				</div>
				<div className="flex flex-wrap gap-x-3 text-sm">
					<span>{unit.layout}</span>
					<span>{unit.area_m2}㎡</span>
					<span>{formatAge(unit.built_age, unit.built_ym)}</span>
					{first && (
						<span>
							{formatStation(first)}
							{restStations.length > 0 && (
								<span className="text-muted-foreground">
									{" "}
									ほか{restStations.length}駅
								</span>
							)}
						</span>
					)}
				</div>
				<Flags flags={unit.flags} />
				<OthersJudgments
					evaluations={unit.evaluations}
					person={person}
					people={people}
				/>
				{unit.summary && (
					<p className="line-clamp-2 text-sm text-muted-foreground">
						{unit.summary}
					</p>
				)}
			</CardContent>
			<CardFooter className="mt-auto justify-between gap-2 pt-2 pb-4">
				<span className="text-xs text-muted-foreground">
					{unit.listing_count > 1 ? `掲載 ${unit.listing_count} 件` : ""}
				</span>
				<JudgmentControl
					unitKey={unit.unit_key}
					judgment={myEvaluation(unit.evaluations, person)?.judgment ?? null}
				/>
			</CardFooter>
		</Card>
	);
}
