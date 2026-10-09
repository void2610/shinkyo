import { useFetcher } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ButtonGroup } from "~/components/ui/button-group";
import { type Judgment, judgments } from "../../src/domain.ts";
import { unitPath } from "../../src/web/format.ts";
import type { Role } from "../context";

export function JudgmentControl({
	unitKey,
	judgment,
	role,
}: {
	unitKey: string;
	judgment: Judgment | null;
	role: Role;
}) {
	const fetcher = useFetcher();
	// 送信中は押した値を先に表示し、サーバーの応答を待たせない
	const pending = fetcher.formData?.get("judgment");
	const current =
		pending === undefined || pending === null
			? judgment
			: pending === ""
				? null
				: (pending as Judgment);
	if (role === "viewer") {
		return (
			<Badge variant={current ? "default" : "outline"}>
				{current ?? "未判定"}
			</Badge>
		);
	}
	return (
		<ButtonGroup aria-label="判定">
			{judgments.map((j) => (
				<Button
					key={j}
					type="button"
					size="sm"
					variant={current === j ? "default" : "outline"}
					aria-pressed={current === j}
					className="min-w-9"
					onClick={() =>
						fetcher.submit(
							{ intent: "judgment", judgment: current === j ? "" : j },
							{ method: "post", action: unitPath(unitKey) },
						)
					}
				>
					{j}
				</Button>
			))}
		</ButtonGroup>
	);
}
