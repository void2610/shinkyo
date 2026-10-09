import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "~/components/ui/empty";
import { parseFilter } from "../../src/web/filter.ts";
import {
	countByStatus,
	filterOptions,
	listUnits,
} from "../../src/web/queries.ts";
import { FilterBar } from "../components/filter-bar";
import { UnitCard } from "../components/unit-card";
import { appContext } from "../context";
import type { Route } from "./+types/home";

export const meta: Route.MetaFunction = () => [{ title: "部屋一覧 | shinkyo" }];

export function loader({ request, context }: Route.LoaderArgs) {
	const { db, clock, role } = context.get(appContext);
	const filter = parseFilter(new URL(request.url).searchParams);
	return {
		units: listUnits(db, filter, clock().getFullYear()),
		filter,
		options: filterOptions(db),
		counts: Object.fromEntries(countByStatus(db)),
		role,
	};
}

export default function Home({ loaderData }: Route.ComponentProps) {
	const { units, filter, options, counts, role } = loaderData;
	return (
		<>
			<FilterBar filter={filter} options={options} counts={counts} />
			<p className="mb-3 text-sm text-muted-foreground">{units.length} 件</p>
			{units.length === 0 ? (
				<Empty className="py-16">
					<EmptyHeader>
						<EmptyTitle>該当する部屋はありません。</EmptyTitle>
						<EmptyDescription>
							条件をゆるめると見つかるかもしれません。
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
					{units.map((u) => (
						<UnitCard key={u.unit_key} unit={u} role={role} />
					))}
				</div>
			)}
		</>
	);
}
