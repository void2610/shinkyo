import { describe, expect, test } from "bun:test";
import { isAllowed, parseRobots } from "../src/fetch/robots.ts";

const robots = `
User-agent: *
Disallow: /mb/
Disallow: /chintai/*/__JJ_FR301FC001
Disallow: /baikyaku/*/ek_*/$
Disallow: /*?rnTmp=
Allow: /mb/ok/

User-agent: bingbot
Crawl-delay: 30
Disallow: /
`;

const rules = parseRobots(robots, "shinkyo/0.1");
const allowed = (path: string) => isAllowed(rules, `https://suumo.jp${path}`);

describe("robots.txt", () => {
	test("賃貸の検索一覧と物件詳細は許可", () => {
		expect(allowed("/jj/chintai/ichiran/FR301FC001/?ar=030&page=2")).toBe(true);
		expect(allowed("/chintai/jnc_000000000101/?bc=900000000001")).toBe(true);
	});

	test("前方一致とワイルドカード", () => {
		expect(allowed("/mb/chintai/")).toBe(false);
		expect(allowed("/chintai/tokyo/__JJ_FR301FC001")).toBe(false);
		expect(allowed("/list/?a=1&rnTmp=2")).toBe(true);
		expect(allowed("/list/?rnTmp=2")).toBe(false);
	});

	test("$ は行末にだけ一致する", () => {
		expect(allowed("/baikyaku/tokyo/ek_123/")).toBe(false);
		expect(allowed("/baikyaku/tokyo/ek_123/jisseki")).toBe(true);
	});

	test("より長く一致する Allow が優先される", () => {
		expect(allowed("/mb/ok/page")).toBe(true);
	});

	test("自分の UA の群が無ければ * に従い、他の UA の群は使わない", () => {
		expect(parseRobots(robots, "bingbot")).toEqual([
			{ allow: false, pattern: "/" },
		]);
		expect(rules.some((r) => r.pattern === "/")).toBe(false);
	});
});
