import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Criteria } from "../src/config.ts";
import { parseDetailPage, parseListPage } from "../src/fetch/parse.ts";
import { type Jev, JevFailed } from "../src/jev.ts";
import { runEvaluate } from "../src/jobs/evaluate.ts";
import type { ClaudeRunner } from "../src/llm.ts";
import type { Notification } from "../src/notify.ts";
import { applyDetail, upsertListing } from "../src/store/listings.ts";
import {
	FakeClock,
	fixture,
	MONDAY_10_JST,
	memoryDb,
	repoConfig,
} from "./helpers.ts";

const config = await repoConfig();
const page = parseListPage(await fixture("list_p1.html"));
const detailHtml = await fixture("detail.html");
// 固定の fixture (家賃 12.5万円 + 8000円) が必須条件を満たすよう上限だけ広げる
const criteria: Criteria = {
	...config.criteria,
	hard: { ...config.criteria.hard, rent_total_max: 150000, layouts: ["1LDK"] },
};

function seed(detailFor: string[], notes?: string): Database {
	const db = memoryDb();
	const at = MONDAY_10_JST.toISOString();
	for (const room of page.rooms) upsertListing(db, room, "test", at);
	const html = notes
		? detailHtml.replace(
				'<td>-</td><th class="data_02">取り扱い店舗',
				`<td>${notes}</td><th class="data_02">取り扱い店舗`,
			)
		: detailHtml;
	for (const id of detailFor)
		applyDetail(db, id, parseDetailPage(html), "", at);
	return db;
}

const claudeReplying = (
	results: unknown[],
): { run: ClaudeRunner; calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		run: async (_args, stdin) => {
			calls.push(stdin);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					is_error: false,
					structured_output: { results },
				}),
			};
		},
	};
};

function evaluate(
	db: Database,
	claude: ClaudeRunner | null,
	options: {
		dryRun?: boolean;
		clock?: FakeClock;
		criteria?: Criteria;
		jev?: Jev;
	} = {},
) {
	const notifications: Notification[] = [];
	const run = () =>
		runEvaluate({
			db,
			criteria: options.criteria ?? criteria,
			stations: {},
			notify: async (n) => {
				notifications.push(n);
			},
			clock: (options.clock ?? new FakeClock(MONDAY_10_JST)).read,
			dryRun: options.dryRun ?? false,
			log: () => {},
			systemPrompt: "sys",
			claude,
			jev: options.jev ?? null,
			webOrigin: "https://m1.example.ts.net",
		});
	return { run, notifications };
}

const unitOf = (db: Database, listingId: string) =>
	db
		.query<
			{
				status: string;
				base_score: number | null;
				adj_score: number | null;
				summary: string | null;
				flags: string;
				next_action: string | null;
			},
			[string]
		>(
			"SELECT u.status, u.base_score, u.adj_score, u.summary, u.flags, u.next_action FROM units u JOIN listings l ON l.unit_key = u.unit_key WHERE l.listing_id = ?",
		)
		.get(listingId);

describe("J2 評価", () => {
	test("必須条件を満たす部屋は候補にし、基礎点と Claude の補正・要約・注意点を記録する", async () => {
		const db = seed(["900000000002"]);
		const claude = claudeReplying([
			{
				id: "0",
				flags: ["北向き"],
				summary: "駅近の1LDK",
				adjust: 5,
				reason: "収納が多い",
			},
		]);
		const { run } = evaluate(db, claude.run);
		const summary = await run();
		expect(summary.candidates).toHaveLength(1);
		const unit = unitOf(db, "900000000001");
		expect(unit).toMatchObject({
			status: "候補",
			adj_score: 5,
			summary: "駅近の1LDK",
		});
		expect(unit?.base_score).toBeGreaterThan(0);
		expect(JSON.parse(unit?.flags ?? "[]")).toContain("北向き");
		expect(JSON.parse(claude.calls[0] ?? "{}").units[0]).toMatchObject({
			rent: 125000,
			layout: "1LDK",
		});
	});

	test("詳細を取得していない部屋は、一覧だけで外れるものは見送り、残りは評価を待つ", async () => {
		const db = seed([]);
		const claude = claudeReplying([]);
		const summary = await evaluate(db, claude.run).run();
		expect(summary).toEqual({ rejected: 1, candidates: [], llmFailed: 0 });
		expect(unitOf(db, "900000000001")?.status).toBe("新着");
		expect(unitOf(db, "900000000003")?.status).toBe("見送り");
		expect(claude.calls).toEqual([]);
	});

	test("必須条件を外れた部屋は Claude に渡さず自動で見送り、理由を残す", async () => {
		const db = seed(["900000000003"]);
		const claude = claudeReplying([]);
		const { run } = evaluate(db, claude.run);
		await run();
		const unit = unitOf(db, "900000000003");
		expect(unit?.status).toBe("見送り");
		expect(unit?.next_action).toContain("間取り");
		expect(claude.calls).toEqual([]);
	});

	test("定期借家の部屋は見送る", async () => {
		const db = seed(["900000000002"], "定期借家 2年");
		await evaluate(db, claudeReplying([]).run).run();
		expect(unitOf(db, "900000000001")?.status).toBe("見送り");
	});

	test("必須の設備が詳細に無い部屋は見送り、名前の一部が合う設備も当てる", async () => {
		const db = seed(["900000000002"]);
		const required = (features: string[]): Criteria => ({
			...criteria,
			hard: { ...criteria.hard, required_features: features },
		});
		await evaluate(db, claudeReplying([]).run, {
			criteria: required(["宅配", "床暖房"]),
		}).run();
		const unit = unitOf(db, "900000000001");
		expect(unit?.status).toBe("見送り");
		expect(unit?.next_action).toBe("必須条件外: 床暖房なし");
	});

	test("候補になったあとで必須条件を足すと次の評価で見送り、満たす候補は評価し直さない", async () => {
		const db = seed(["900000000002"]);
		const claude = claudeReplying([
			{ id: "0", flags: [], summary: "要約", adjust: 0, reason: "" },
		]);
		await evaluate(db, claude.run).run();
		expect(unitOf(db, "900000000001")?.status).toBe("候補");
		await evaluate(db, claude.run).run();
		expect(claude.calls).toHaveLength(1);
		await evaluate(db, claude.run, {
			criteria: {
				...criteria,
				hard: { ...criteria.hard, required_features: ["床暖房"] },
			},
		}).run();
		expect(unitOf(db, "900000000001")?.status).toBe("見送り");
		const event = db
			.query<{ from_status: string }, []>(
				"SELECT e.from_status FROM events e JOIN listings l ON l.unit_key = e.unit_key WHERE e.type = 'auto_rejected' AND l.listing_id = '900000000001'",
			)
			.get();
		expect(event?.from_status).toBe("候補");
	});

	test("Claude が失敗しても基礎点で候補にし、人の判断が要ると通知する", async () => {
		const db = seed(["900000000002"]);
		const { run, notifications } = evaluate(db, async () => ({
			exitCode: 1,
			stdout: "",
		}));
		const summary = await run();
		expect(summary.llmFailed).toBe(1);
		expect(unitOf(db, "900000000001")).toMatchObject({
			status: "候補",
			adj_score: null,
		});
		expect(notifications.map((n) => n.title)).toContain(
			"評価の補正ができなかった部屋がある",
		);
	});

	test("通知の最低点以上なら新着ダイジェストを送り、画面へのリンクを付け、1日3回までにする", async () => {
		const claude = claudeReplying([
			{ id: "0", flags: [], summary: "良い部屋", adjust: 10, reason: "" },
		]);
		const lowBar = { ...criteria, notify_min_score: 0 };
		const digests: Notification[] = [];
		for (let i = 0; i < 4; i++) {
			const db = seed(["900000000002"]);
			const { run, notifications } = evaluate(db, claude.run, {
				criteria: lowBar,
			});
			// 同じ日の送信回数を引き継ぐ
			for (let j = 0; j < i; j++)
				db.query(
					"INSERT OR REPLACE INTO state (key, value) VALUES ('evaluate.digest.2026-10-12', ?)",
				).run(String(i));
			await run();
			digests.push(
				...notifications.filter((n) => n.title.startsWith("新着の候補")),
			);
		}
		expect(digests).toHaveLength(3);
		expect(digests[0]?.message).toContain("https://m1.example.ts.net/units/");
		expect(digests[0]?.message).toContain("良い部屋");
	});

	test("通知の最低点に届かなければダイジェストを送らない", async () => {
		const db = seed(["900000000002"]);
		const claude = claudeReplying([
			{ id: "0", flags: [], summary: "", adjust: 0, reason: "" },
		]);
		const { run, notifications } = evaluate(db, claude.run, {
			criteria: { ...criteria, notify_min_score: 100 },
		});
		await run();
		expect(notifications).toEqual([]);
	});

	test("dry-run では状態を変えず Claude も呼ばない", async () => {
		const db = seed(["900000000002", "900000000003"]);
		const claude = claudeReplying([]);
		const summary = await evaluate(db, claude.run, { dryRun: true }).run();
		expect(summary.rejected).toBe(1);
		expect(unitOf(db, "900000000001")?.status).toBe("新着");
		expect(unitOf(db, "900000000003")?.status).toBe("新着");
		expect(claude.calls).toEqual([]);
	});

	test("Jev が判定した注意点を閾値で採り、Claude には要約と補正だけを頼む", async () => {
		const db = seed(["900000000002"]);
		const calls: string[][] = [];
		const claude: ClaudeRunner = async (args) => {
			calls.push(args);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					is_error: false,
					structured_output: {
						results: [{ id: "0", summary: "要約", adjust: 1, reason: "" }],
					},
				}),
			};
		};
		const jev: Jev = async () => ({
			北向き: { type: "noul", noul: 0.95 },
			"1階": { type: "noul", noul: 0.4 },
			定期借家: { type: "noul", noul: 0.69 },
		});
		await evaluate(db, claude, { jev }).run();
		expect(JSON.parse(unitOf(db, "900000000001")?.flags ?? "[]")).toEqual([
			"北向き",
		]);
		expect(unitOf(db, "900000000001")?.summary).toBe("要約");
		const schema = calls[0]?.[calls[0].indexOf("--json-schema") + 1] ?? "";
		expect(schema).not.toContain("flags");
	});

	test("Jev が失敗したら Claude に注意点も選ばせる", async () => {
		const db = seed(["900000000002"]);
		const claude = claudeReplying([
			{ id: "0", flags: ["1階"], summary: "", adjust: 0, reason: "" },
		]);
		const jev: Jev = async () => {
			throw new JevFailed("down");
		};
		await evaluate(db, claude.run, { jev }).run();
		expect(JSON.parse(unitOf(db, "900000000001")?.flags ?? "[]")).toEqual([
			"1階",
		]);
	});
});
