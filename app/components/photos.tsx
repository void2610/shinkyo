import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
	Carousel,
	type CarouselApi,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
} from "~/components/ui/carousel";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import type { RoomImage } from "../../src/fetch/parse.ts";
import {
	imageKindLabels,
	imageKinds,
	isFloorPlan,
	kindOf,
	pickGallerySource,
} from "../../src/images/kinds.ts";
import { imagePath } from "../../src/web/format.ts";
import type { ListingRow } from "../../src/web/queries.ts";

export type Photo = RoomImage & { src: string; slide: number };

// 間取り図から順に並べた順が、拡大表示で送る順になる
export function photosOf(listings: ListingRow[]): Photo[] {
	const source = pickGallerySource(listings);
	if (!source) return [];
	const images = source.images.map((image, index) => ({
		...image,
		src: imagePath(source.listing_id, index),
	}));
	return imageKinds
		.flatMap((kind) => images.filter((i) => kindOf(i) === kind))
		.map((p, slide) => ({ ...p, slide }));
}

type OpenPhoto = (slide: number) => void;

function ZoomButton({
	photo,
	onOpen,
	className,
	children,
}: {
	photo: Photo;
	onOpen: OpenPhoto;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={cn("cursor-zoom-in", className)}
			onClick={() => onOpen(photo.slide)}
			aria-label={`${photo.caption ?? "写真"}を拡大`}
		>
			{children}
		</button>
	);
}

// 間取り図は比べるときに必ず見るので、切り取らずに全体を常に出す
export function FloorPlans({
	photos,
	onOpen,
}: {
	photos: Photo[];
	onOpen: OpenPhoto;
}) {
	const plans = photos.filter(isFloorPlan);
	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle>間取り図</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-1 flex-col justify-center gap-2">
				{plans.length === 0 ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						間取り図はまだありません
					</p>
				) : (
					plans.map((plan) => (
						<ZoomButton
							key={plan.src}
							photo={plan}
							onOpen={onOpen}
							className="block w-full rounded-lg bg-white p-2"
						>
							<img
								className="mx-auto block max-h-72 w-full object-contain"
								src={plan.src}
								alt={plan.caption ?? "間取り図"}
								decoding="async"
							/>
						</ZoomButton>
					))
				)}
			</CardContent>
		</Card>
	);
}

function PhotoGrid({
	photos,
	onOpen,
	small,
}: {
	photos: Photo[];
	onOpen: OpenPhoto;
	small?: boolean;
}) {
	return (
		<div
			className={cn(
				"grid gap-3",
				small
					? "grid-cols-4 md:grid-cols-6 xl:grid-cols-8"
					: "grid-cols-2 md:grid-cols-4 xl:grid-cols-5",
			)}
		>
			{photos.map((photo) => (
				<figure key={photo.src} className="grid gap-1.5">
					<ZoomButton
						photo={photo}
						onOpen={onOpen}
						className="relative block aspect-[4/3] overflow-hidden rounded-lg bg-muted"
					>
						<img
							className="absolute inset-0 size-full object-cover transition-transform duration-300 hover:scale-105"
							src={photo.src}
							alt={photo.caption ?? "物件の写真"}
							loading="lazy"
							decoding="async"
						/>
					</ZoomButton>
					{photo.caption && (
						<figcaption
							className={cn(
								"truncate text-muted-foreground",
								small ? "text-[11px]" : "text-xs",
							)}
							title={photo.caption}
						>
							{photo.caption}
						</figcaption>
					)}
				</figure>
			))}
		</div>
	);
}

// 間取り図は上に別枠で出すので、ここでは室内・建物・その他・周辺を分けて並べる
const galleryKinds = ["room", "building", "other", "surroundings"] as const;

export function Gallery({
	photos,
	onOpen,
}: {
	photos: Photo[];
	onOpen: OpenPhoto;
}) {
	return (
		<section className="grid gap-6">
			{galleryKinds.map((kind) => {
				const group = photos.filter((p) => kindOf(p) === kind);
				if (group.length === 0) return null;
				// 周辺施設の写真はほぼ見ないので、開いたときだけ出す
				if (kind === "surroundings") {
					return (
						<Collapsible key={kind}>
							<CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
								<ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" />
								{imageKindLabels[kind]} ({group.length})
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-3">
								<PhotoGrid photos={group} onOpen={onOpen} small />
							</CollapsibleContent>
						</Collapsible>
					);
				}
				return (
					<div key={kind} className="grid gap-3">
						<h2 className="text-sm font-medium text-muted-foreground">
							{imageKindLabels[kind]} ({group.length})
						</h2>
						<PhotoGrid photos={group} onOpen={onOpen} />
					</div>
				);
			})}
		</section>
	);
}

export function PhotoViewer({
	photos,
	openAt,
	onClose,
}: {
	photos: Photo[];
	openAt: number | null;
	onClose: () => void;
}) {
	const [api, setApi] = useState<CarouselApi>();
	const [current, setCurrent] = useState(0);
	useEffect(() => {
		if (!api) return;
		const update = () => setCurrent(api.selectedScrollSnap());
		update();
		api.on("select", update);
		return () => {
			api.off("select", update);
		};
	}, [api]);
	const photo = photos[current];
	return (
		<Dialog open={openAt !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="h-[92vh] max-w-[94vw] gap-3 bg-black p-4 text-white ring-0 sm:max-w-[94vw]">
				<div className="flex items-center gap-3 pr-10 text-sm">
					<DialogTitle className="truncate font-normal text-white">
						{photo?.caption ?? "写真"}
					</DialogTitle>
					<span className="ml-auto shrink-0 text-white/60 tabular-nums">
						{current + 1} / {photos.length}
					</span>
				</div>
				<Carousel
					setApi={setApi}
					opts={{ startIndex: openAt ?? 0, loop: true }}
					className="min-h-0 px-12"
				>
					<CarouselContent className="h-[calc(92vh-5rem)]">
						{photos.map((p) => (
							<CarouselItem
								key={p.src}
								className="flex h-full items-center justify-center"
							>
								<img
									className="size-full object-contain"
									src={p.src}
									alt={p.caption ?? "物件の写真"}
								/>
							</CarouselItem>
						))}
					</CarouselContent>
					<CarouselPrevious className="left-0 size-10 border-0 bg-white/90 text-black hover:bg-white" />
					<CarouselNext className="right-0 size-10 border-0 bg-white/90 text-black hover:bg-white" />
				</Carousel>
			</DialogContent>
		</Dialog>
	);
}
