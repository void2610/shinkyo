import { useFetcher } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ButtonGroup } from "~/components/ui/button-group";
import { type Judgment, judgments } from "../../src/domain.ts";
import { displayName, unitPath } from "../../src/web/format.ts";
import type { Evaluation } from "../../src/web/queries.ts";

// 自分の判定を付けるボタン。押した人の判定として保存される
export function JudgmentControl({
	unitKey,
	judgment,
}: {
	unitKey: string;
	judgment: Judgment | null;
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

// 自分以外の人の判定を並べる
export function OthersJudgments({
	evaluations,
	person,
	people,
}: {
	evaluations: Evaluation[];
	person: string;
	people: Record<string, string>;
}) {
	const others = evaluations.filter((e) => e.person !== person && e.judgment);
	if (others.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1">
			{others.map((e) => (
				<Badge key={e.person} variant="secondary" title={e.person}>
					{displayName(people, e.person)} {e.judgment}
				</Badge>
			))}
		</div>
	);
}

export const myEvaluation = (
	evaluations: Evaluation[],
	person: string,
): Evaluation | undefined => evaluations.find((e) => e.person === person);
