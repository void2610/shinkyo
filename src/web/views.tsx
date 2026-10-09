import bootstrapPackage from "bootstrap/package.json";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import htmxPackage from "htmx.org/package.json";
import {
	type Judgment,
	judgments,
	type UnitFlag,
	unitFlags,
	unitStatuses,
} from "../domain.ts";
import { isFloorPlan, pickGallerySource } from "../fetch/images.ts";
import type { RoomImage } from "../fetch/parse.ts";
import { imageKindLabels, imageKinds, kindOf } from "../images/kinds.ts";
import {
	formatAge,
	formatAt,
	formatFloor,
	formatMan,
	formatMonths,
	formatStation,
	imagePath,
	unitName,
	unitPath,
} from "./format.ts";
import {
	type EventRow,
	type FilterOptions,
	type ListingRow,
	type SortKey,
	sortKeys,
	type UnitFilter,
	type UnitRow,
} from "./queries.ts";

// 更新した CSS をすぐ反映させるため、内容のハッシュを URL に付けて長くキャッシュさせる
const cssVersion = Bun.hash(
	await Bun.file(new URL("./style.css", import.meta.url)).text(),
).toString(36);

export type Role = "owner" | "viewer";

// 描画前に配色を決めないと、ダークモードで一瞬白く光る
const themeScript = raw(
	`<script>document.documentElement.dataset.bsTheme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"</script>`,
);

// hx-boost でページが差し替わっても効くよう、document に1回だけ登録する
const galleryScript = raw(`<script>
document.addEventListener("show.bs.modal", (e) => {
	const slide = Number(e.relatedTarget?.dataset.slide ?? 0);
	const carousel = e.target.querySelector(".carousel");
	if (carousel) bootstrap.Carousel.getOrCreateInstance(carousel, { interval: false }).to(slide);
});
const showCaption = (modal) => {
	const caption = modal?.querySelector("#gallery-caption");
	const active = modal?.querySelector(".carousel-item.active");
	if (caption && active) caption.textContent = active.dataset.caption;
};
document.addEventListener("shown.bs.modal", (e) => showCaption(e.target));
document.addEventListener("slid.bs.carousel", (e) => showCaption(e.target.closest(".modal")));
// 空の条件を URL に残さない (共有やブックマークで読みにくくなるため)
document.addEventListener("htmx:configRequest", (e) => {
	const data = e.detail.formData;
	if (!data) return;
	const kept = [...data.entries()].filter(([, v]) => v !== "");
	for (const key of new Set([...data.keys()])) data.delete(key);
	for (const [k, v] of kept) data.append(k, v);
});
</script>`);

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
			{themeScript}
			<link
				rel="stylesheet"
				href={`/static/bootstrap.min.css?v=${bootstrapPackage.version}`}
			/>
			<link rel="stylesheet" href={`/static/style.css?v=${cssVersion}`} />
			<script src={`/static/htmx.min.js?v=${htmxPackage.version}`} defer />
			<script
				src={`/static/bootstrap.bundle.min.js?v=${bootstrapPackage.version}`}
				defer
			/>
			{galleryScript}
		</head>
		<body hx-boost="true">
			<nav class="navbar border-bottom bg-body-tertiary">
				<div class="container-xl">
					<a class="navbar-brand fw-bold" href="/">
						shinkyo
					</a>
					{access === "viewer" && (
						<span class="badge rounded-pill text-bg-secondary">閲覧専用</span>
					)}
				</div>
			</nav>
			<main class="container-xl py-3">{children}</main>
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
			<div id={id}>
				<span
					class={`badge ${judgment ? "text-bg-primary fs-6" : "text-bg-light border"}`}
				>
					{judgment ?? "未判定"}
				</span>
			</div>
		);
	}
	return (
		<fieldset class="btn-group" aria-label="判定" id={id}>
			{judgments.map((j) => (
				<button
					type="button"
					class={`btn judge ${judgment === j ? "btn-primary" : "btn-outline-primary"}`}
					aria-pressed={judgment === j ? "true" : "false"}
					hx-post={`${unitPath(unitKey)}/judgment`}
					hx-vals={JSON.stringify({ judgment: judgment === j ? "" : j })}
					hx-target={`#${id}`}
					hx-swap="outerHTML"
				>
					{j}
				</button>
			))}
		</fieldset>
	);
};

const goodFlags = new Set(["値下げ", "相場より安い"]);

const Flags: FC<{ flags: string[] }> = ({ flags }) =>
	flags.length === 0 ? null : (
		<div class="d-flex flex-wrap gap-1">
			{flags.map((f) => (
				<span
					class={`badge ${goodFlags.has(f) ? "text-bg-success" : "text-bg-warning"}`}
				>
					{f}
				</span>
			))}
		</div>
	);

const statusColor = (status: string): string =>
	status === "見送り"
		? "text-bg-secondary"
		: status === "確定"
			? "text-bg-success"
			: "text-bg-info";

const StatusBadge: FC<{ status: string }> = ({ status }) => (
	<span class={`badge ${statusColor(status)}`}>{status}</span>
);

const Thumbnail: FC<{ unit: UnitRow }> = ({ unit }) => (
	<a
		class="ratio ratio-4x3 d-block bg-body-secondary rounded overflow-hidden"
		href={unitPath(unit.unit_key)}
	>
		{unit.images.length > 0 ? (
			<img
				class="object-fit-cover"
				src={imagePath(unit.listing_id, 0)}
				alt={unitName(unit)}
				loading="lazy"
				decoding="async"
			/>
		) : (
			<span class="d-flex align-items-center justify-content-center text-body-secondary small">
				画像なし
			</span>
		)}
	</a>
);

const UnitCard: FC<{ unit: UnitRow; access: Role }> = ({ unit, access }) => {
	const [first, ...restStations] = unit.stations;
	return (
		<div class="col">
			<div class="card h-100 shadow-sm">
				<div class="row g-0 h-100">
					<div class="col-4 p-2">
						<Thumbnail unit={unit} />
					</div>
					<div class="col-8">
						<div class="card-body d-flex flex-column h-100 p-2 pe-3">
							<div class="d-flex justify-content-between align-items-start gap-2">
								<a
									class="card-title h6 mb-1 text-body text-decoration-none unit-name"
									href={unitPath(unit.unit_key)}
								>
									{unitName(unit)}
								</a>
								<StatusBadge status={unit.status} />
							</div>
							<div class="d-flex flex-wrap align-items-baseline column-gap-2">
								<span class="fs-5 fw-bold">{formatMan(unit.rent)}</span>
								<span class="small text-body-secondary">
									管理費 {formatMan(unit.admin_fee)}
								</span>
							</div>
							<div class="small text-body-secondary">
								敷 {formatMonths(unit.deposit, unit.rent)} / 礼{" "}
								{formatMonths(unit.key_money, unit.rent)}
							</div>
							<div class="small d-flex flex-wrap column-gap-2">
								<span>{unit.area_m2}㎡</span>
								<span>{formatAge(unit.built_age, unit.built_ym)}</span>
								{first && (
									<span>
										{formatStation(first)}
										{restStations.length > 0 && (
											<span class="text-body-secondary">
												{" "}
												ほか{restStations.length}駅
											</span>
										)}
									</span>
								)}
							</div>
							<div class="mt-1">
								<Flags flags={unit.flags} />
							</div>
							{unit.summary && (
								<p class="small mt-1 mb-0 summary">{unit.summary}</p>
							)}
							<div class="d-flex flex-wrap justify-content-between align-items-center mt-auto pt-2 gap-2">
								<div class="small text-body-secondary text-nowrap">
									{unit.score !== null && (
										<span class="fw-semibold text-body me-2">
											{Math.round(unit.score)}点
										</span>
									)}
									{unit.listing_count > 1 && (
										<span>掲載 {unit.listing_count} 件</span>
									)}
								</div>
								<div class="ms-auto">
									<JudgmentControl
										unitKey={unit.unit_key}
										judgment={unit.judgment}
										access={access}
									/>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

const Select: FC<{
	name: string;
	value: string;
	options: [string, string][];
	label: string;
	wide?: boolean;
}> = ({ name, value, options, label, wide }) => (
	<div class={`${wide ? "col-12" : "col-6"} col-sm-auto`}>
		<label
			class="form-label small text-body-secondary mb-0"
			for={`filter-${name}`}
		>
			{label}
		</label>
		<select
			class="form-select form-select-sm"
			name={name}
			id={`filter-${name}`}
		>
			{options.map(([v, text]) => (
				<option value={v} selected={v === value}>
					{text}
				</option>
			))}
		</select>
	</div>
);

const NumberField: FC<{
	name: string;
	label: string;
	unit: string;
	value: number | null;
	step: number;
}> = ({ name, label, unit, value, step }) => (
	<div class="col-6 col-sm-3 col-lg-2">
		<label
			class="form-label small text-body-secondary mb-0"
			for={`filter-${name}`}
		>
			{label}
		</label>
		<div class="input-group input-group-sm">
			<input
				class="form-control"
				type="number"
				inputmode="decimal"
				min="0"
				step={step}
				name={name}
				id={`filter-${name}`}
				value={value ?? ""}
			/>
			<span class="input-group-text">{unit}</span>
		</div>
	</div>
);

const TagSelect: FC<{ flag: UnitFlag; filter: UnitFilter }> = ({
	flag,
	filter,
}) => {
	const value = filter.withFlags.includes(flag)
		? `+${flag}`
		: filter.withoutFlags.includes(flag)
			? `-${flag}`
			: "";
	return (
		<div class="col-6 col-md-4 col-lg-3">
			<label
				class="form-label small text-body-secondary mb-0 text-truncate d-block"
				for={`tag-${flag}`}
			>
				{flag}
			</label>
			<select class="form-select form-select-sm" name="tag" id={`tag-${flag}`}>
				{[
					["", "指定なし"],
					[`+${flag}`, "あり"],
					[`-${flag}`, "なし"],
				].map(([v, text]) => (
					<option value={v} selected={v === value}>
						{text}
					</option>
				))}
			</select>
		</div>
	);
};

const advancedCount = (f: UnitFilter): number =>
	f.layouts.length +
	(f.station ? 1 : 0) +
	f.withFlags.length +
	f.withoutFlags.length;

export const UnitListPage: FC<{
	units: UnitRow[];
	filter: UnitFilter;
	options: FilterOptions;
	counts: Map<string, number>;
	access: Role;
}> = ({ units, filter, options, counts, access }) => {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	const advanced = advancedCount(filter);
	return (
		<Layout title="部屋一覧" access={access}>
			{/* 一覧だけを差し替え、入力中の値や開いた条件欄はそのまま残す */}
			<form
				class="card card-body p-2 mb-3"
				action="/"
				method="get"
				hx-get="/"
				hx-trigger="change, input delay:500ms"
				hx-target="#results"
				hx-select="#results"
				hx-swap="outerHTML"
				hx-push-url="true"
			>
				<div class="row g-2 align-items-end">
					<Select
						wide
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
				</div>
				<div class="row g-2 align-items-end mt-0">
					<NumberField
						name="max_rent"
						label="家賃+管理費"
						unit="万円以下"
						step={0.5}
						value={filter.maxRent === null ? null : filter.maxRent / 10000}
					/>
					<NumberField
						name="min_area"
						label="面積"
						unit="㎡以上"
						step={1}
						value={filter.minArea}
					/>
					<NumberField
						name="max_walk"
						label="駅徒歩"
						unit="分以内"
						step={1}
						value={filter.maxWalk}
					/>
					<NumberField
						name="max_age"
						label="築年数"
						unit="年以内"
						step={1}
						value={filter.maxAge}
					/>
				</div>
				<div class="d-flex align-items-center gap-3 mt-2">
					<button
						class="btn btn-sm btn-outline-secondary"
						type="button"
						data-bs-toggle="collapse"
						data-bs-target="#more-filters"
						aria-expanded={advanced > 0 ? "true" : "false"}
						aria-controls="more-filters"
					>
						条件を追加
						{advanced > 0 && (
							<span class="badge text-bg-primary ms-1">{advanced}</span>
						)}
					</button>
					<a class="small" href="/">
						条件をクリア
					</a>
					<noscript>
						<button class="btn btn-sm btn-primary" type="submit">
							絞り込む
						</button>
					</noscript>
				</div>
				<div class={`collapse ${advanced > 0 ? "show" : ""}`} id="more-filters">
					<div class="pt-3">
						<div class="small text-body-secondary mb-1">間取り</div>
						<div class="d-flex flex-wrap gap-1 mb-3">
							{options.layouts.map((layout) => (
								<>
									<input
										type="checkbox"
										class="btn-check"
										name="layout"
										value={layout}
										id={`layout-${layout}`}
										autocomplete="off"
										checked={filter.layouts.includes(layout)}
									/>
									<label
										class="btn btn-sm btn-outline-primary"
										for={`layout-${layout}`}
									>
										{layout}
									</label>
								</>
							))}
						</div>
						<div class="row g-2 mb-3">
							<div class="col-12 col-sm-6 col-lg-3">
								<label
									class="form-label small text-body-secondary mb-0"
									for="filter-station"
								>
									最寄駅
								</label>
								<select
									class="form-select form-select-sm"
									name="station"
									id="filter-station"
								>
									<option value="">指定なし</option>
									{options.stations.map((station) => (
										<option
											value={station}
											selected={station === filter.station}
										>
											{station}
										</option>
									))}
								</select>
							</div>
						</div>
						<div class="small text-body-secondary mb-1">タグ</div>
						<div class="row g-2">
							{unitFlags.map((flag) => (
								<TagSelect flag={flag} filter={filter} />
							))}
						</div>
					</div>
				</div>
			</form>
			<div id="results">
				<p class="small text-body-secondary mb-2">{units.length} 件</p>
				{units.length === 0 ? (
					<p class="text-center text-body-secondary py-5">
						該当する部屋はありません。
					</p>
				) : (
					<div class="row row-cols-1 row-cols-lg-2 g-3">
						{units.map((u) => (
							<UnitCard unit={u} access={access} />
						))}
					</div>
				)}
			</div>
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

const GALLERY_MODAL = "gallery-modal";
const GALLERY_CAROUSEL = "gallery-carousel";

type Photo = RoomImage & { index: number; slide: number };

// 間取り図を先頭に並べた順が、拡大表示で送る順になる
function photosOf(
	listings: ListingRow[],
): { listingId: string; photos: Photo[] } | null {
	const source = pickGallerySource(listings);
	if (!source || source.images.length === 0) return null;
	const images = source.images.map((image, index) => ({ ...image, index }));
	const ordered = imageKinds.flatMap((kind) =>
		images.filter((i) => kindOf(i) === kind),
	);
	return {
		listingId: source.listing_id,
		photos: ordered.map((p, slide) => ({ ...p, slide })),
	};
}

const ZoomButton: FC<{ photo: Photo; class: string; children: Child }> = ({
	photo,
	class: className,
	children,
}) => (
	<button
		type="button"
		class={`border-0 p-0 ${className}`}
		data-bs-toggle="modal"
		data-bs-target={`#${GALLERY_MODAL}`}
		data-slide={photo.slide}
		aria-label={`${photo.caption ?? "写真"}を拡大`}
	>
		{children}
	</button>
);

// 間取り図は比べるときに必ず見るので、切り取らずに全体を常に出す
const FloorPlans: FC<{ listingId: string; photos: Photo[] }> = ({
	listingId,
	photos,
}) => {
	const plans = photos.filter(isFloorPlan);
	return (
		<section class="card h-100">
			<div class="card-header">間取り図</div>
			<div class="card-body d-flex flex-column gap-2 justify-content-center">
				{plans.length === 0 ? (
					<p class="text-body-secondary text-center mb-0">
						間取り図はまだありません
					</p>
				) : (
					plans.map((plan) => (
						<ZoomButton photo={plan} class="d-block w-100 bg-white rounded">
							<img
								class="d-block w-100 floor-plan"
								src={imagePath(listingId, plan.index)}
								alt={plan.caption ?? "間取り図"}
								decoding="async"
							/>
						</ZoomButton>
					))
				)}
			</div>
		</section>
	);
};

const PhotoGrid: FC<{
	listingId: string;
	photos: Photo[];
	small?: boolean;
}> = ({ listingId, photos, small }) => (
	<div
		class={`row g-2 ${small ? "row-cols-3 row-cols-sm-4 row-cols-md-6" : "row-cols-2 row-cols-sm-3 row-cols-md-4"}`}
	>
		{photos.map((image) => (
			<div class="col">
				<figure class="figure w-100 mb-0">
					<ZoomButton
						photo={image}
						class="ratio ratio-4x3 d-block w-100 bg-body-secondary rounded overflow-hidden"
					>
						<img
							class="object-fit-cover"
							src={imagePath(listingId, image.index)}
							alt={image.caption ?? "物件の写真"}
							loading="lazy"
							decoding="async"
						/>
					</ZoomButton>
					{image.caption && (
						<figcaption
							class={`figure-caption text-truncate mt-1 ${small ? "small" : ""}`}
							title={image.caption}
						>
							{image.caption}
						</figcaption>
					)}
				</figure>
			</div>
		))}
	</div>
);

// 間取り図は別枠に出すので、ここでは室内・建物・周辺を分けて並べる。周辺施設は参考程度なので小さくする
const galleryKinds = ["room", "building", "other", "surroundings"] as const;

const Gallery: FC<{ listingId: string; photos: Photo[] }> = ({
	listingId,
	photos,
}) => {
	return (
		<section class="mb-4">
			{galleryKinds.map((kind) => {
				const group = photos.filter((p) => kindOf(p) === kind);
				return group.length === 0 ? null : (
					<div class="mb-3">
						<h2 class="h6 text-body-secondary">
							{imageKindLabels[kind]} ({group.length})
						</h2>
						<PhotoGrid
							listingId={listingId}
							photos={group}
							small={kind === "surroundings"}
						/>
					</div>
				);
			})}
			<div
				class="modal fade"
				role="dialog"
				id={GALLERY_MODAL}
				tabindex={-1}
				aria-label="写真の拡大表示"
				aria-hidden="true"
			>
				<div class="modal-dialog modal-xl modal-dialog-centered modal-fullscreen-md-down">
					<div class="modal-content bg-black border-0">
						<div class="modal-header border-0 py-2" data-bs-theme="dark">
							<span class="modal-title text-white small" id="gallery-caption" />
							<button
								type="button"
								class="btn-close"
								data-bs-dismiss="modal"
								aria-label="閉じる"
							/>
						</div>
						<div class="modal-body p-0 d-flex align-items-center">
							<div
								id={GALLERY_CAROUSEL}
								class="carousel slide w-100"
								data-bs-keyboard="true"
								data-bs-touch="true"
							>
								<div class="carousel-inner">
									{photos.map((image) => (
										<div
											class={`carousel-item ${image.slide === 0 ? "active" : ""}`}
											data-caption={image.caption ?? ""}
										>
											<img
												class="d-block mx-auto gallery-full"
												src={imagePath(listingId, image.index)}
												alt={image.caption ?? "物件の写真"}
												loading="lazy"
												decoding="async"
											/>
										</div>
									))}
								</div>
								<button
									class="carousel-control-prev"
									type="button"
									data-bs-target={`#${GALLERY_CAROUSEL}`}
									data-bs-slide="prev"
								>
									<span class="carousel-control-prev-icon" aria-hidden="true" />
									<span class="visually-hidden">前の写真</span>
								</button>
								<button
									class="carousel-control-next"
									type="button"
									data-bs-target={`#${GALLERY_CAROUSEL}`}
									data-bs-slide="next"
								>
									<span class="carousel-control-next-icon" aria-hidden="true" />
									<span class="visually-hidden">次の写真</span>
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

export const MemoSaved: FC<{ at: string }> = ({ at }) => (
	<span class="small text-success">{formatAt(at)} に保存しました</span>
);

export const ApproveControl: FC<{ unit: UnitRow; access: Role }> = ({
	unit,
	access,
}) => {
	if (unit.apply_approved)
		return <div class="alert alert-success py-2 mb-0">申込を承認済み</div>;
	if (access === "viewer" || unit.status !== "内見済") return null;
	return (
		<form
			method="post"
			action={`${unitPath(unit.unit_key)}/approve`}
			hx-post={`${unitPath(unit.unit_key)}/approve`}
			hx-swap="outerHTML"
			hx-confirm="この部屋の申込を承認します。T3 の下書きが作られます。よろしいですか？"
		>
			<button type="submit" class="btn btn-outline-danger">
				申込を承認
			</button>
		</form>
	);
};

const Row: FC<{ label: string; children: Child }> = ({ label, children }) => (
	<>
		<dt class="col-4 col-sm-3 fw-normal small text-body-secondary text-nowrap pt-1">
			{label}
		</dt>
		<dd class="col-8 col-sm-9 mb-2">{children}</dd>
	</>
);

export const UnitDetailPage: FC<{
	unit: UnitRow;
	listings: ListingRow[];
	events: EventRow[];
	access: Role;
}> = ({ unit, listings, events, access }) => {
	const detail = listings.find((l) => l.features.length > 0) ?? listings[0];
	const memoPath = `${unitPath(unit.unit_key)}/memo`;
	const gallery = photosOf(listings);
	return (
		<Layout title={unitName(unit)} access={access}>
			<nav aria-label="breadcrumb">
				<ol class="breadcrumb small mb-2">
					<li class="breadcrumb-item">
						<a href="/">一覧</a>
					</li>
					<li class="breadcrumb-item active text-truncate" aria-current="page">
						{unitName(unit)}
					</li>
				</ol>
			</nav>
			<div class="d-flex flex-wrap align-items-center gap-2 mb-1">
				<h1 class="h4 mb-0 unit-name">{unitName(unit)}</h1>
				<StatusBadge status={unit.status} />
				{unit.score !== null && (
					<span class="badge bg-primary-subtle text-primary-emphasis border border-primary-subtle">
						{Math.round(unit.score)}点
					</span>
				)}
			</div>
			<div class="d-flex flex-wrap align-items-baseline column-gap-3 mb-2">
				<span class="fs-2 fw-bold lh-sm">{formatMan(unit.rent)}</span>
				<span class="text-body-secondary">
					管理費 {formatMan(unit.admin_fee)}・敷{" "}
					{formatMonths(unit.deposit, unit.rent)}・礼{" "}
					{formatMonths(unit.key_money, unit.rent)}
				</span>
				<span class="text-body-secondary">
					{unit.layout}・{unit.area_m2}㎡
				</span>
			</div>
			<div class="mb-2">
				<Flags flags={unit.flags} />
			</div>
			<div class="d-flex flex-wrap align-items-center gap-3 mb-3">
				<JudgmentControl
					unitKey={unit.unit_key}
					judgment={unit.judgment}
					access={access}
				/>
				<ApproveControl unit={unit} access={access} />
			</div>
			{unit.summary && <p class="lead fs-6 summary">{unit.summary}</p>}

			<div class="row g-3 mb-4">
				<div class="col-lg-6">
					<FloorPlans
						listingId={gallery?.listingId ?? ""}
						photos={gallery?.photos ?? []}
					/>
				</div>
				<div class="col-lg-6">
					<section class="card h-100">
						<div class="card-header">概要</div>
						<div class="card-body">
							<dl class="row mb-0">
								<Row label="家賃">
									<span class="fw-bold">{formatMan(unit.rent)}</span>（管理費{" "}
									{formatMan(unit.admin_fee)}）
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
								<Row label="築年">
									{formatAge(unit.built_age, unit.built_ym)}
								</Row>
								<Row label="向き">{unit.orientation ?? "不明"}</Row>
								<Row label="所在地">{unit.address}</Row>
								<Row label="最寄駅">
									<ul class="list-unstyled mb-0">
										{unit.stations.map((s) => (
											<li>
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
						</div>
					</section>
				</div>
			</div>

			{gallery && (
				<Gallery listingId={gallery.listingId} photos={gallery.photos} />
			)}

			<div class="row g-3 mb-4">
				<div class="col-12">
					<section class="card h-100">
						<div class="card-header">評価メモ</div>
						<div class="card-body">
							{access === "owner" ? (
								<form
									method="post"
									action={memoPath}
									hx-post={memoPath}
									hx-target="next .memo-status"
								>
									<textarea
										class="form-control mb-2"
										name="memo"
										rows={6}
										aria-label="評価メモ"
									>
										{unit.memo ?? ""}
									</textarea>
									<div class="d-flex justify-content-between align-items-center">
										<div class="memo-status" />
										<button class="btn btn-primary btn-sm" type="submit">
											保存
										</button>
									</div>
								</form>
							) : (
								<p class="mb-0 memo-view">{unit.memo ?? "なし"}</p>
							)}
						</div>
					</section>
				</div>
			</div>

			<section class="card mb-4">
				<div class="card-header">掲載 ({listings.length})</div>
				<ul class="list-group list-group-flush">
					{listings.map((l) => (
						<li class="list-group-item d-flex flex-wrap justify-content-between column-gap-3">
							<a href={l.url} target="_blank" rel="noreferrer noopener">
								{l.agent_name ?? "業者名未取得"}
							</a>
							<span>
								{formatMan(l.rent)} + {formatMan(l.admin_fee)}
							</span>
							<span class="small text-body-secondary w-100">
								{formatAt(l.first_seen)} 〜 {formatAt(l.last_seen)}
								{l.missing_runs > 0 && `（一覧に無い: ${l.missing_runs} 回）`}
							</span>
						</li>
					))}
				</ul>
			</section>

			{detail && detail.features.length > 0 && (
				<section class="mb-4">
					<h2 class="h6 text-body-secondary">設備</h2>
					<div class="d-flex flex-wrap gap-1">
						{detail.features.map((f) => (
							<span class="badge text-bg-light border fw-normal">{f}</span>
						))}
					</div>
				</section>
			)}

			<section class="card mb-4">
				<div class="card-header">履歴</div>
				<ul class="list-group list-group-flush small">
					{events.map((e) => (
						<li class="list-group-item d-flex gap-3">
							<time class="text-body-secondary text-nowrap">
								{formatAt(e.at)}
							</time>
							<span>
								{eventLabel(e)}
								{e.actor === "human" && (
									<span class="text-body-secondary">（人）</span>
								)}
							</span>
						</li>
					))}
				</ul>
			</section>
		</Layout>
	);
};

export const NotFoundPage: FC<{ access: Role }> = ({ access }) => (
	<Layout title="見つかりません" access={access}>
		<p class="text-center text-body-secondary py-5">部屋が見つかりません。</p>
		<p class="text-center">
			<a href="/">一覧へ戻る</a>
		</p>
	</Layout>
);
