import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "~/components/ui/input-group";
import { Label } from "~/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "~/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
	judgments,
	type UnitFlag,
	unitFlags,
	unitStatuses,
} from "../../src/domain.ts";
import {
	type FilterOptions,
	type SortKey,
	sortKeys,
	type UnitFilter,
} from "../../src/web/queries.ts";

const FEATURES_SHOWN = 30;
// 選んだボタンが薄い灰色だと見分けにくいので、塗りつぶして目立たせる
const PRESSED =
	"data-[pressed]:bg-primary data-[pressed]:text-primary-foreground";

type Props = {
	filter: UnitFilter;
	options: FilterOptions;
	counts: Record<string, number>;
};

// 条件はすべて URL に持たせる。共有やブックマークでそのまま同じ一覧を開けるようにするため
function useParamSetter() {
	const [params, setParams] = useSearchParams();
	return (update: (next: URLSearchParams) => void) => {
		const next = new URLSearchParams(params);
		update(next);
		setParams(next, { replace: true, preventScrollReset: true });
	};
}

function SelectField({
	id,
	label,
	value,
	options,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	options: [string, string][];
	onChange: (value: string) => void;
}) {
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</Label>
			<NativeSelect
				id={id}
				className="w-full"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				{options.map(([v, text]) => (
					<NativeSelectOption key={v} value={v}>
						{text}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}

// 入力のたびに一覧を引き直さないよう、打ち終わってから URL に反映する
function NumberField({
	id,
	label,
	unit,
	value,
	step,
	onCommit,
}: {
	id: string;
	label: string;
	unit: string;
	value: number | null;
	step: number;
	onCommit: (value: string) => void;
}) {
	const [text, setText] = useState(value === null ? "" : String(value));
	useEffect(() => setText(value === null ? "" : String(value)), [value]);
	useEffect(() => {
		if (text === (value === null ? "" : String(value))) return;
		const timer = setTimeout(() => onCommit(text), 500);
		return () => clearTimeout(timer);
	}, [text, value, onCommit]);
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</Label>
			<InputGroup>
				<InputGroupInput
					id={id}
					type="number"
					inputMode="decimal"
					min={0}
					step={step}
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupText>{unit}</InputGroupText>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

const tagValue = (filter: UnitFilter, flag: UnitFlag): string =>
	filter.withFlags.includes(flag)
		? `+${flag}`
		: filter.withoutFlags.includes(flag)
			? `-${flag}`
			: "";

export function FilterBar({ filter, options, counts }: Props) {
	const set = useParamSetter();
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	const advanced =
		filter.layouts.length +
		(filter.station ? 1 : 0) +
		filter.withFlags.length +
		filter.withoutFlags.length +
		filter.features.length;
	const [open, setOpen] = useState(advanced > 0);
	const [allFeatures, setAllFeatures] = useState(false);
	// 設備は100種類近くあるので、多い順に絞って出す。選んだものは常に出す
	const shownFeatures = allFeatures
		? options.features
		: [
				...new Set([
					...options.features.slice(0, FEATURES_SHOWN),
					...filter.features,
				]),
			];

	const setOne = (name: string) => (value: string) =>
		set((p) => {
			if (value) p.set(name, value);
			else p.delete(name);
		});

	return (
		<Card className="mb-6 py-4">
			<CardContent className="grid gap-4">
				<div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
					<SelectField
						id="filter-status"
						label="状態"
						value={filter.status}
						onChange={setOne("status")}
						options={[
							["active", `見送り以外 (${total - (counts.見送り ?? 0)})`],
							["all", `すべて (${total})`],
							...unitStatuses.map((s): [string, string] => [
								s,
								`${s} (${counts[s] ?? 0})`,
							]),
						]}
					/>
					<SelectField
						id="filter-judgment"
						label="判定"
						value={filter.judgment}
						onChange={setOne("judgment")}
						options={[
							["all", "すべて"],
							["none", "未判定"],
							...judgments.map((j): [string, string] => [j, j]),
						]}
					/>
					<SelectField
						id="filter-sort"
						label="並び"
						value={filter.sort}
						onChange={setOne("sort")}
						options={Object.entries(sortKeys) as [SortKey, string][]}
					/>
					<NumberField
						id="filter-max-rent"
						label="家賃+管理費"
						unit="万円以下"
						step={0.5}
						value={filter.maxRent === null ? null : filter.maxRent / 10000}
						onCommit={setOne("max_rent")}
					/>
					<NumberField
						id="filter-min-area"
						label="面積"
						unit="㎡以上"
						step={1}
						value={filter.minArea}
						onCommit={setOne("min_area")}
					/>
					<NumberField
						id="filter-max-walk"
						label="駅徒歩"
						unit="分以内"
						step={1}
						value={filter.maxWalk}
						onCommit={setOne("max_walk")}
					/>
					<NumberField
						id="filter-max-age"
						label="築年数"
						unit="年以内"
						step={1}
						value={filter.maxAge}
						onCommit={setOne("max_age")}
					/>
				</div>
				<Collapsible open={open} onOpenChange={setOpen}>
					<div className="flex items-center gap-3 text-sm">
						<CollapsibleTrigger className="flex items-center gap-1.5 font-medium">
							<ChevronDown
								className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
							/>
							条件を追加
							{advanced > 0 && <Badge>{advanced}</Badge>}
						</CollapsibleTrigger>
						<Link
							className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground"
							to="/"
							replace
						>
							<X className="size-3.5" />
							条件をクリア
						</Link>
					</div>
					<CollapsibleContent className="grid gap-5 pt-4">
						<div className="grid gap-2">
							<span className="text-xs text-muted-foreground">間取り</span>
							<ToggleGroup
								multiple
								variant="outline"
								size="sm"
								value={filter.layouts}
								onValueChange={(values: string[]) =>
									set((p) => {
										p.delete("layout");
										for (const v of values) p.append("layout", v);
									})
								}
								className="flex-wrap justify-start"
							>
								{options.layouts.map((layout) => (
									<ToggleGroupItem
										key={layout}
										value={layout}
										className={PRESSED}
									>
										{layout}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</div>
						<div className="grid gap-2">
							<span className="text-xs text-muted-foreground">
								設備 (選んだものをすべて備えた部屋)
							</span>
							<ToggleGroup
								multiple
								variant="outline"
								size="sm"
								value={filter.features}
								onValueChange={(values: string[]) =>
									set((p) => {
										p.delete("feature");
										for (const v of values) p.append("feature", v);
									})
								}
								className="flex-wrap justify-start"
							>
								{shownFeatures.map((feature) => (
									<ToggleGroupItem
										key={feature}
										value={feature}
										className={PRESSED}
									>
										{feature}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
							{options.features.length > FEATURES_SHOWN && (
								<button
									type="button"
									className="justify-self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
									onClick={() => setAllFeatures(!allFeatures)}
								>
									{allFeatures
										? "よく使う設備だけ表示"
										: `すべての設備を表示 (${options.features.length})`}
								</button>
							)}
						</div>
						<div className="max-w-xs">
							<SelectField
								id="filter-station"
								label="最寄駅"
								value={filter.station ?? ""}
								onChange={setOne("station")}
								options={[
									["", "指定なし"],
									...options.stations.map((s): [string, string] => [s, s]),
								]}
							/>
						</div>
						<div className="grid gap-2">
							<span className="text-xs text-muted-foreground">タグ</span>
							<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
								{unitFlags.map((flag) => (
									<SelectField
										key={flag}
										id={`tag-${flag}`}
										label={flag}
										value={tagValue(filter, flag)}
										onChange={(value) =>
											set((p) => {
												const others = p
													.getAll("tag")
													.filter((t) => t.slice(1) !== flag);
												p.delete("tag");
												for (const t of [...others, value].filter(Boolean))
													p.append("tag", t);
											})
										}
										options={[
											["", "指定なし"],
											[`+${flag}`, "あり"],
											[`-${flag}`, "なし"],
										]}
									/>
								))}
							</div>
						</div>
					</CollapsibleContent>
				</Collapsible>
			</CardContent>
		</Card>
	);
}
