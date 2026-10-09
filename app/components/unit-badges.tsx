import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

const goodFlags = new Set(["値下げ", "相場より安い"]);

export function Flags({ flags }: { flags: string[] }) {
	if (flags.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1">
			{flags.map((f) => (
				<Badge
					key={f}
					variant="outline"
					className={cn(
						"border-transparent",
						goodFlags.has(f)
							? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
							: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
					)}
				>
					{f}
				</Badge>
			))}
		</div>
	);
}

export function StatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	return (
		<Badge
			variant={status === "見送り" ? "secondary" : "outline"}
			className={className}
		>
			{status}
		</Badge>
	);
}

export function ScoreBadge({ score }: { score: number | null }) {
	if (score === null) return null;
	return <Badge>{Math.round(score)}点</Badge>;
}
