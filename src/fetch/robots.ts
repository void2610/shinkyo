type Rule = { allow: boolean; pattern: string };

// 自分の UA 名の群がなければ * の群に従う
export function parseRobots(text: string, agent: string): Rule[] {
	const groups: { agents: string[]; rules: Rule[] }[] = [];
	let current: { agents: string[]; rules: Rule[] } | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, "").trim();
		const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
		if (!m?.[1]) continue;
		const field = m[1].toLowerCase();
		const value = (m[2] ?? "").trim();
		if (field === "user-agent") {
			if (!current || current.rules.length > 0) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
		} else if ((field === "allow" || field === "disallow") && current) {
			if (value !== "")
				current.rules.push({ allow: field === "allow", pattern: value });
		}
	}
	const name = agent.toLowerCase();
	const own = groups.filter((g) =>
		g.agents.some((a) => a !== "*" && name.includes(a)),
	);
	const chosen =
		own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
	return chosen.flatMap((g) => g.rules);
}

function toRegExp(pattern: string): RegExp {
	const anchored = pattern.endsWith("$");
	const body = (anchored ? pattern.slice(0, -1) : pattern)
		.split("*")
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

// 最長一致の規則に従い、同じ長さなら Allow を優先する (RFC 9309)
export function isAllowed(rules: Rule[], url: string): boolean {
	const u = new URL(url);
	const path = `${u.pathname}${u.search}`;
	let best: Rule | null = null;
	for (const rule of rules) {
		if (!toRegExp(rule.pattern).test(path)) continue;
		if (
			!best ||
			rule.pattern.length > best.pattern.length ||
			(rule.pattern.length === best.pattern.length && rule.allow)
		) {
			best = rule;
		}
	}
	return best?.allow ?? true;
}
