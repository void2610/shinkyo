import type { Child, FC } from "hono/jsx";
import { type Judgment, judgments, unitStatuses } from "../domain.ts";
import {
	formatAge,
	formatAt,
	formatFloor,
	formatMan,
	formatMonths,
	formatStation,
	unitName,
	unitPath,
} from "./format.ts";
import {
	type EventRow,
	type ListingRow,
	type SortKey,
	sortKeys,
	type UnitFilter,
	type UnitRow,
} from "./queries.ts";

export type Role = "owner" | "viewer";

export const Layout: FC<{ title: string; access: Role; children: Child }> = ({
	title,
	access,
	children,
}) => (
	<html lang="ja">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<meta name="robots" content="noindex" />
			<title>{title} | shinkyo</title>
			<link rel="stylesheet" href="/static/style.css" />
			<script src="/static/htmx.min.js" defer />
		</head>
		<body hx-boost="true">
			<header class="site">
				<a class="brand" href="/">
					shinkyo
				</a>
				{access === "viewer" && <span class="badge viewer">閲覧専用</span>}
			</header>
			<main>{children}</main>
		</body>
	</html>
);

export const JudgmentControl: FC<{
	unitKey: string;
	judgment: Judgment | null;
	access: Role;
}> = ({ unitKey, judgment, access }) => {
	const id = `judgment-${Bun.hash(unitKey).toString(36)}`;
	if (access === "viewer") {
		return (
			<div class="judgment" id={id}>
				<span class={`judgment-value ${judgment ? "" : "empty"}`}>
					{judgment ?? "未判定"}
				</span>
			</div>
		);
	}
	return (
		<div class="judgment" id={id}>
			{judgments.map((j) => (
				<button
					type="button"
					class={`judge ${judgment === j ? "selected" : ""}`}
					aria-pressed={judgment === j ? "true" : "false"}
					hx-post={`${unitPath(unitKey)}/judgment`}
					hx-vals={JSON.stringify({ judgment: judgment === j ? "" : j })}
					hx-target={`#${id}`}
					hx-swap="outerHTML"
				>
					{j}
				</button>
			))}
		</div>
	);
};

const Flags: FC<{ flags: string[] }> = ({ flags }) =>
	flags.length === 0 ? null : (
		<ul class="flags">
			{flags.map((f) => (
				<li class={`flag ${f === "値下げ" ? "good" : "warn"}`}>{f}</li>
			))}
		</ul>
	);

const StatusBadge: FC<{ status: string }> = ({ status }) => (
	<span class={`status s-${status}`}>{status}</span>
);

const UnitCard: FC<{ unit: UnitRow; access: Role }> = ({ unit, access }) => {
	const [first, ...restStations] = unit.stations;
	return (
		<li class="card">
			<div class="card-head">
				<a class="card-title" href={unitPath(unit.unit_key)}>
					{unitName(unit)}
				</a>
				<StatusBadge status={unit.status} />
			</div>
			<div class="card-body">
				<div class="price">
					<strong>{formatMan(unit.rent)}</strong>
					<span class="sub">管理費 {formatMan(unit.admin_fee)}</span>
					<span class="sub">
						敷 {formatMonths(unit.deposit, unit.rent)} / 礼{" "}
						{formatMonths(unit.key_money, unit.rent)}
					</span>
				</div>
				<div class="facts">
					<span>{unit.area_m2}㎡</span>
					<span>{formatAge(unit.built_age, unit.built_ym)}</span>
					{first && (
						<span>
							{formatStation(first)}
							{restStations.length > 0 && (
								<span class="sub"> ほか{restStations.length}駅</span>
							)}
						</span>
					)}
					{unit.score !== null && <span>スコア {Math.round(unit.score)}</span>}
					{unit.listing_count > 1 && (
						<span class="sub">掲載 {unit.listing_count} 件</span>
					)}
				</div>
				<Flags flags={unit.flags} />
				{unit.summary && <p class="summary">{unit.summary}</p>}
			</div>
			<JudgmentControl
				unitKey={unit.unit_key}
				judgment={unit.judgment}
				access={access}
			/>
		</li>
	);
};

const Select: FC<{
	name: string;
	value: string;
	options: [string, string][];
	label: string;
}> = ({ name, value, options, label }) => (
	<label class="field">
		<span>{label}</span>
		<select name={name}>
			{options.map(([v, text]) => (
				<option value={v} selected={v === value}>
					{text}
				</option>
			))}
		</select>
	</label>
);

export const UnitListPage: FC<{
	units: UnitRow[];
	filter: UnitFilter;
	counts: Map<string, number>;
	access: Role;
}> = ({ units, filter, counts, access }) => {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return (
		<Layout title="部屋一覧" access={access}>
			<form
				class="filters"
				action="/"
				method="get"
				hx-trigger="change"
				hx-get="/"
				hx-target="body"
				hx-push-url="true"
			>
				<Select
					name="status"
					label="状態"
					value={filter.status}
					options={[
						["active", `見送り以外 (${total - (counts.get("見送り") ?? 0)})`],
						["all", `すべて (${total})`],
						...unitStatuses.map((s): [string, string] => [
							s,
							`${s} (${counts.get(s) ?? 0})`,
						]),
					]}
				/>
				<Select
					name="judgment"
					label="判定"
					value={filter.judgment}
					options={[
						["all", "すべて"],
						["none", "未判定"],
						...judgments.map((j): [string, string] => [j, j]),
					]}
				/>
				<Select
					name="sort"
					label="並び"
					value={filter.sort}
					options={Object.entries(sortKeys) as [SortKey, string][]}
				/>
				<noscript>
					<button type="submit">絞り込む</button>
				</noscript>
			</form>
			{units.length === 0 ? (
				<p class="empty">該当する部屋はありません。</p>
			) : (
				<ul class="cards">
					{units.map((u) => (
						<UnitCard unit={u} access={access} />
					))}
				</ul>
			)}
		</Layout>
	);
};

const eventLabel = (e: EventRow): string => {
	const d = (e.detail ?? {}) as Record<string, unknown>;
	switch (e.type) {
		case "created":
			return "新着として登録";
		case "listing_added":
			return "別の掲載を追加";
		case "judgment":
			return `判定 ${d.from ?? "未判定"} → ${d.to ?? "未判定"}`;
		case "memo":
			return "メモを更新";
		case "apply_approved":
			return "申込を承認";
		case "flag_on":
			return `「${d.flag}」を付与`;
		case "flag_off":
			return `「${d.flag}」を解除`;
		case "price_drop":
		case "price_change":
			return `家賃+管理費 ${formatMan(Number(d.from))} → ${formatMan(Number(d.to))}`;
		default:
			return e.from_status || e.to_status
				? `${e.from_status ?? ""} → ${e.to_status ?? ""}`
				: e.type;
	}
};

export const MemoSaved: FC<{ at: string }> = ({ at }) => (
	<span class="saved">{formatAt(at)} に保存しました</span>
);

export const ApproveControl: FC<{ unit: UnitRow; access: Role }> = ({
	unit,
	access,
}) => {
	if (unit.apply_approved) return <p class="approved">申込を承認済み</p>;
	if (access === "viewer" || unit.status !== "内見済") return null;
	return (
		<form
			class="approve"
			method="post"
			action={`${unitPath(unit.unit_key)}/approve`}
			hx-post={`${unitPath(unit.unit_key)}/approve`}
			hx-swap="outerHTML"
			hx-confirm="この部屋の申込を承認します。T3 の下書きが作られます。よろしいですか？"
		>
			<button type="submit" class="danger">
				申込を承認
			</button>
		</form>
	);
};

export const UnitDetailPage: FC<{
	unit: UnitRow;
	listings: ListingRow[];
	events: EventRow[];
	access: Role;
}> = ({ unit, listings, events, access }) => {
	const detail = listings.find((l) => l.features.length > 0) ?? listings[0];
	const memoPath = `${unitPath(unit.unit_key)}/memo`;
	return (
		<Layout title={unitName(unit)} access={access}>
			<p class="back">
				<a href="/">← 一覧へ</a>
			</p>
			<div class="detail-head">
				<h1>{unitName(unit)}</h1>
				<StatusBadge status={unit.status} />
			</div>
			<Flags flags={unit.flags} />
			<JudgmentControl
				unitKey={unit.unit_key}
				judgment={unit.judgment}
				access={access}
			/>
			<ApproveControl unit={unit} access={access} />
			{unit.summary && <p class="summary">{unit.summary}</p>}

			<section>
				<h2>概要</h2>
				<dl class="spec">
					<dt>家賃</dt>
					<dd>
						{formatMan(unit.rent)}（管理費 {formatMan(unit.admin_fee)}）
					</dd>
					<dt>敷金 / 礼金</dt>
					<dd>
						{formatMonths(unit.deposit, unit.rent)} /{" "}
						{formatMonths(unit.key_money, unit.rent)}
					</dd>
					<dt>間取り / 面積</dt>
					<dd>
						{unit.layout} / {unit.area_m2}㎡
					</dd>
					<dt>階</dt>
					<dd>
						{formatFloor(unit.floor)}
						{detail?.building_floors && ` / ${detail.building_floors}`}
					</dd>
					<dt>築年</dt>
					<dd>{formatAge(unit.built_age, unit.built_ym)}</dd>
					<dt>向き</dt>
					<dd>{unit.orientation ?? "不明"}</dd>
					<dt>所在地</dt>
					<dd>{unit.address}</dd>
					<dt>最寄駅</dt>
					<dd>
						<ul class="plain">
							{unit.stations.map((s) => (
								<li>
									{s.line} {formatStation(s)}
								</li>
							))}
						</ul>
					</dd>
					{unit.viewing_at && (
						<>
							<dt>内見日時</dt>
							<dd>{formatAt(unit.viewing_at)}</dd>
						</>
					)}
					{unit.next_action && (
						<>
							<dt>次アクション</dt>
							<dd>{unit.next_action}</dd>
						</>
					)}
					{detail?.other_costs && (
						<>
							<dt>ほか初期費用</dt>
							<dd>{detail.other_costs}</dd>
						</>
					)}
					{detail?.guarantor && (
						<>
							<dt>保証会社</dt>
							<dd>{detail.guarantor}</dd>
						</>
					)}
				</dl>
			</section>

			<section>
				<h2>評価メモ</h2>
				{access === "owner" ? (
					<form
						class="memo"
						method="post"
						action={memoPath}
						hx-post={memoPath}
						hx-target="next .memo-status"
					>
						<textarea name="memo" rows={5}>
							{unit.memo ?? ""}
						</textarea>
						<div class="row">
							<button type="submit">保存</button>
						</div>
					</form>
				) : (
					<p class="memo-view">{unit.memo ?? "なし"}</p>
				)}
				<div class="memo-status" />
			</section>

			<section>
				<h2>掲載 ({listings.length})</h2>
				<ul class="listings">
					{listings.map((l) => (
						<li>
							<a href={l.url} target="_blank" rel="noreferrer noopener">
								{l.agent_name ?? "業者名未取得"}
							</a>
							<span>
								{formatMan(l.rent)} + {formatMan(l.admin_fee)}
							</span>
							<span class="sub">
								{formatAt(l.first_seen)} 〜 {formatAt(l.last_seen)}
								{l.missing_runs > 0 && `（一覧に無い: ${l.missing_runs} 回）`}
							</span>
						</li>
					))}
				</ul>
			</section>

			{detail && detail.features.length > 0 && (
				<section>
					<h2>設備</h2>
					<ul class="chips">
						{detail.features.map((f) => (
							<li>{f}</li>
						))}
					</ul>
				</section>
			)}

			<section>
				<h2>履歴</h2>
				<ol class="events">
					{events.map((e) => (
						<li>
							<time>{formatAt(e.at)}</time>
							<span>{eventLabel(e)}</span>
							{e.actor === "human" && <span class="sub">（人）</span>}
						</li>
					))}
				</ol>
			</section>
		</Layout>
	);
};

export const NotFoundPage: FC<{ access: Role }> = ({ access }) => (
	<Layout title="見つかりません" access={access}>
		<p class="empty">部屋が見つかりません。</p>
		<p>
			<a href="/">一覧へ戻る</a>
		</p>
	</Layout>
);
