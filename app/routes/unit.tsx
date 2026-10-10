import { useState } from "react";
import { data, Link, useFetcher } from "react-router";
import { z } from "zod";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { judgments } from "../../src/domain.ts";
import {
	displayName,
	formatAge,
	formatAt,
	formatFloor,
	formatMan,
	formatMonths,
	formatStation,
	unitName,
} from "../../src/web/format.ts";
import {
	approveApplication,
	type Evaluation,
	type EventRow,
	getEvents,
	getListings,
	getUnit,
	setJudgment,
	setMemo,
	type UnitRow,
} from "../../src/web/queries.ts";
import { CommuteSummary, workplaceViews } from "../components/commute";
import { JudgmentControl } from "../components/judgment-control";
import {
	FloorPlans,
	Gallery,
	PhotoViewer,
	photosOf,
} from "../components/photos";
import { Flags, ScoreBadge, StatusBadge } from "../components/unit-badges";
import { appContext } from "../context";
import type { Route } from "./+types/unit";

export const meta: Route.MetaFunction = ({ loaderData }) => [
	{
		title: `${loaderData ? unitName(loaderData.unit) : "見つかりません"} | shinkyo`,
	},
];

export function loader({ params, context }: Route.LoaderArgs) {
	const { db, person, people, workplaces } = context.get(appContext);
	const unit = getUnit(db, params.key, workplaces);
	if (!unit) throw data("部屋が見つかりません", { status: 404 });
	return {
		unit,
		listings: getListings(db, params.key),
		events: getEvents(db, params.key),
		person,
		people,
		workplaces: workplaceViews(workplaces),
	};
}

const actionSchema = z.discriminatedUnion("intent", [
	z.object({
		intent: z.literal("judgment"),
		judgment: z.union([z.enum(judgments), z.literal("").transform(() => null)]),
	}),
	z.object({ intent: z.literal("memo"), memo: z.string().max(10_000) }),
	z.object({ intent: z.literal("approve") }),
]);

// 人によって権限は変えない。誰の操作かを記録するために person を渡す
export async function action({ params, request, context }: Route.ActionArgs) {
	const { db, clock, person } = context.get(appContext);
	const form = actionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	);
	if (!form.success) throw data("入力が不正です", { status: 400 });
	const at = clock().toISOString();
	const input = form.data;
	if (input.intent === "judgment") {
		if (!setJudgment(db, params.key, person, input.judgment, at))
			throw data("部屋が見つかりません", { status: 404 });
		return { ok: true as const, at };
	}
	if (input.intent === "memo") {
		if (!setMemo(db, params.key, person, input.memo, at))
			throw data("部屋が見つかりません", { status: 404 });
		return { ok: true as const, at };
	}
	const result = approveApplication(db, params.key, person, at);
	if (result === "not_found")
		throw data("部屋が見つかりません", { status: 404 });
	if (result === "invalid_status")
		throw data("申込を承認できるのは内見済の部屋だけです", { status: 409 });
	return { ok: true as const, at };
}

const eventLabel = (
	e: EventRow,
	who: (d: Record<string, unknown>) => string,
): string => {
	const d = (e.detail ?? {}) as Record<string, unknown>;
	switch (e.type) {
		case "created":
			return "新着として登録";
		case "listing_added":
			return "別の掲載を追加";
		case "judgment":
			return `${who(d)}判定 ${d.from ?? "未判定"} → ${d.to ?? "未判定"}`;
		case "memo":
			return `${who(d)}メモを更新`;
		case "apply_approved":
			return `${who(d)}申込を承認`;
		case "flag_on":
			return `「${d.flag}」を付与`;
		case "flag_off":
			return `「${d.flag}」を解除`;
		case "price_drop":
		case "price_change":
			return `家賃+管理費 ${formatMan(Number(d.from))} → ${formatMan(Number(d.to))}`;
		case "rescored":
			return `評価し直し: 基礎点 ${d.base}${d.adjust ? `、補正 ${Number(d.adjust) > 0 ? "+" : ""}${d.adjust}` : ""}${d.reason ? `（${d.reason}）` : ""}`;
		case "evaluated":
			return `評価: 基礎点 ${d.base}${d.adjust ? `、補正 ${Number(d.adjust) > 0 ? "+" : ""}${d.adjust}` : ""}${d.reason ? `（${d.reason}）` : ""}`;
		case "auto_rejected":
			return `必須条件外で見送り: ${((d.failures as string[] | undefined) ?? []).join("、")}`;
		default:
			return e.from_status || e.to_status
				? `${e.from_status ?? ""} → ${e.to_status ?? ""}`
				: e.type;
	}
};

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-[7rem_1fr] gap-3 py-2">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="text-sm">{children}</dd>
		</div>
	);
}

function ApproveControl({ unit }: { unit: UnitRow }) {
	const fetcher = useFetcher();
	if (unit.apply_approved) return <Badge>申込を承認済み</Badge>;
	if (unit.status !== "内見済") return null;
	return (
		<AlertDialog>
			<AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
				申込を承認
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>この部屋の申込を承認しますか？</AlertDialogTitle>
					<AlertDialogDescription>
						承認したことを記録します。申込の連絡や申込フォームの入力は、Claude
						Code から行います。
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>やめる</AlertDialogCancel>
					<AlertDialogAction
						onClick={() =>
							fetcher.submit({ intent: "approve" }, { method: "post" })
						}
					>
						承認する
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function MyMemo({ memo }: { memo: string | null }) {
	const fetcher = useFetcher<typeof action>();
	return (
		<fetcher.Form method="post" className="grid gap-2">
			<input type="hidden" name="intent" value="memo" />
			<Textarea
				name="memo"
				rows={2}
				defaultValue={memo ?? ""}
				aria-label="自分の評価メモ"
				placeholder="内見や比較で気づいたこと"
				className="min-h-0 resize-y"
			/>
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">
					{fetcher.state !== "idle"
						? "保存中…"
						: fetcher.data?.ok
							? `${formatAt(fetcher.data.at)} に保存しました`
							: ""}
				</span>
				<Button type="submit" size="xs" variant="outline">
					保存
				</Button>
			</div>
		</fetcher.Form>
	);
}

// 自分以外の人の判定とメモを、誰のものか分かるように並べる
function OthersNotes({
	evaluations,
	person,
	people,
}: {
	evaluations: Evaluation[];
	person: string;
	people: Record<string, string>;
}) {
	const others = evaluations.filter(
		(e) => e.person !== person && (e.judgment || e.memo),
	);
	if (others.length === 0) return null;
	return (
		<ul className="grid gap-2">
			{others.map((e) => (
				<li
					key={e.person}
					className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
				>
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span className="font-medium text-foreground">
							{displayName(people, e.person)}
						</span>
						{e.judgment && <Badge variant="secondary">{e.judgment}</Badge>}
						<span className="ml-auto">{formatAt(e.updated_at)}</span>
					</div>
					{e.memo && <p className="mt-1 whitespace-pre-wrap">{e.memo}</p>}
				</li>
			))}
		</ul>
	);
}

export default function UnitPage({ loaderData }: Route.ComponentProps) {
	const { unit, listings, events, person, people, workplaces } = loaderData;
	const mine = unit.evaluations.find((e) => e.person === person);
	const detail = listings.find((l) => l.features.length > 0) ?? listings[0];
	const photos = photosOf(listings);
	const [openAt, setOpenAt] = useState<number | null>(null);
	const name = unitName(unit);
	return (
		<>
			<Breadcrumb className="mb-4">
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink render={<Link to="/" />}>一覧</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbItem>
						<BreadcrumbPage>{name}</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>

			<div className="mb-8 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="font-heading text-2xl font-semibold tracking-tight">
							{name}
						</h1>
						<StatusBadge status={unit.status} />
						<ScoreBadge score={unit.score} />
					</div>
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
						<span
							className="text-4xl font-semibold tracking-tight"
							data-testid="rent"
						>
							{formatMan(unit.rent)}
						</span>
						<span className="text-muted-foreground">
							管理費 {formatMan(unit.admin_fee)}・敷{" "}
							{formatMonths(unit.deposit, unit.rent)}・礼{" "}
							{formatMonths(unit.key_money, unit.rent)}
						</span>
					</div>
					<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
						<span>
							{unit.layout}・{unit.area_m2}㎡
						</span>
						{unit.stations[0] && <span>{formatStation(unit.stations[0])}</span>}
						<span>{formatAge(unit.built_age, unit.built_ym)}</span>
						<span>{formatFloor(unit.floor)}</span>
						{unit.orientation && <span>{unit.orientation}向き</span>}
					</div>
					<div className="flex flex-wrap items-start gap-x-6 gap-y-2">
						<CommuteSummary unit={unit} workplaces={workplaces} />
						<Button
							variant="outline"
							size="sm"
							nativeButton={false}
							render={
								<Link to={`/map?unit=${encodeURIComponent(unit.unit_key)}`} />
							}
						>
							地図で見る
						</Button>
					</div>
					<Flags flags={unit.flags} />
					{unit.summary && (
						<p className="rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed">
							{unit.summary}
						</p>
					)}
					<div className="flex flex-wrap items-center gap-3">
						<JudgmentControl
							unitKey={unit.unit_key}
							judgment={mine?.judgment ?? null}
						/>
						<ApproveControl unit={unit} />
					</div>
					<div className="grid gap-1.5">
						<span className="text-xs text-muted-foreground">
							自分の評価メモ
						</span>
						<MyMemo memo={mine?.memo ?? null} />
						<OthersNotes
							evaluations={unit.evaluations}
							person={person}
							people={people}
						/>
					</div>
				</div>
				{/* PC で見出しの右が空くので、比較で一番見る間取り図を置く */}
				<FloorPlans photos={photos} onOpen={setOpenAt} />
			</div>

			{photos.length > 0 && (
				<div className="mb-8">
					<Gallery photos={photos} onOpen={setOpenAt} />
				</div>
			)}
			<PhotoViewer
				key={openAt ?? "closed"}
				photos={photos}
				openAt={openAt}
				onClose={() => setOpenAt(null)}
			/>

			<div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<Card>
					<CardHeader>
						<CardTitle>概要</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="divide-y">
							<Row label="家賃">
								<span className="font-semibold">{formatMan(unit.rent)}</span>
								（管理費 {formatMan(unit.admin_fee)}）
							</Row>
							<Row label="敷金・礼金">
								{formatMonths(unit.deposit, unit.rent)} /{" "}
								{formatMonths(unit.key_money, unit.rent)}
							</Row>
							<Row label="間取り・面積">
								{unit.layout} / {unit.area_m2}㎡
							</Row>
							<Row label="階">
								{formatFloor(unit.floor)}
								{detail?.building_floors && ` / ${detail.building_floors}`}
							</Row>
							<Row label="築年">{formatAge(unit.built_age, unit.built_ym)}</Row>
							<Row label="向き">{unit.orientation ?? "不明"}</Row>
							<Row label="所在地">{unit.address}</Row>
							<Row label="最寄駅">
								<ul className="grid gap-0.5">
									{unit.stations.map((s) => (
										<li key={`${s.line}-${s.station}`}>
											{s.line} {formatStation(s)}
										</li>
									))}
								</ul>
							</Row>
							{unit.viewing_at && (
								<Row label="内見日時">{formatAt(unit.viewing_at)}</Row>
							)}
							{unit.next_action && (
								<Row label="次アクション">{unit.next_action}</Row>
							)}
							{detail?.other_costs && (
								<Row label="ほか初期費用">{detail.other_costs}</Row>
							)}
							{detail?.guarantor && (
								<Row label="保証会社">{detail.guarantor}</Row>
							)}
						</dl>
					</CardContent>
				</Card>
				<div className="grid content-start gap-6">
					<Card>
						<CardHeader>
							<CardTitle>掲載 ({listings.length})</CardTitle>
						</CardHeader>
						<CardContent className="divide-y">
							{listings.map((l) => (
								<div
									key={l.listing_id}
									className="flex flex-wrap items-baseline justify-between gap-x-3 py-2.5"
								>
									<a
										className="text-sm font-medium underline-offset-4 hover:underline"
										href={l.url}
										target="_blank"
										rel="noreferrer noopener"
									>
										{l.agent_name ?? "業者名未取得"}
									</a>
									<span className="text-sm">
										{formatMan(l.rent)} + {formatMan(l.admin_fee)}
									</span>
									<span className="w-full text-xs text-muted-foreground">
										{formatAt(l.first_seen)} 〜 {formatAt(l.last_seen)}
										{l.missing_runs > 0 &&
											`（一覧に無い: ${l.missing_runs} 回）`}
									</span>
								</div>
							))}
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>履歴</CardTitle>
						</CardHeader>
						<CardContent className="divide-y">
							{events.map((e) => (
								<div key={e.id} className="flex gap-3 py-2 text-sm">
									<time className="shrink-0 text-muted-foreground tabular-nums">
										{formatAt(e.at)}
									</time>
									<span>
										{eventLabel(e, (d) =>
											typeof d.person === "string"
												? `${displayName(people, d.person)}: `
												: "",
										)}
										{e.actor === "human" && (
											<span className="text-muted-foreground">（人）</span>
										)}
									</span>
								</div>
							))}
						</CardContent>
					</Card>
				</div>
			</div>

			{detail && detail.features.length > 0 && (
				<section className="mt-8 grid gap-3">
					<h2 className="text-sm font-medium text-muted-foreground">設備</h2>
					<div className="flex flex-wrap gap-1.5">
						{detail.features.map((f) => (
							<Badge key={f} variant="outline">
								{f}
							</Badge>
						))}
					</div>
				</section>
			)}
		</>
	);
}
