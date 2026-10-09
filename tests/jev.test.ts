import { expect, test } from "bun:test";
import { createJev, JEV_ENDPOINT, JevFailed } from "../src/jev.ts";

function server(responses: Response[]) {
	const requests: { url: string; init: RequestInit }[] = [];
	const fetchImpl = async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		return responses.shift() ?? new Response("", { status: 500 });
	};
	return {
		requests,
		jev: createJev({ apiKey: "ts-test", fetchImpl, sleep: async () => {} }),
	};
}

const ok = (answers: unknown) =>
	Response.json({
		model: "jev-latest",
		answers,
		usage: { input_tokens: 1, output_tokens: 1 },
	});

test("state と設問を System One の形で送り、答えを型で検証して返す", async () => {
	const { jev, requests } = server([
		ok({ north: { type: "noul", noul: 0.91 } }),
	]);
	const answers = await jev(
		{ orientation: "北" },
		{ north: { type: "noul", instructions: "北向きか" } },
	);
	expect(answers.north).toEqual({ type: "noul", noul: 0.91 });
	expect(requests[0]?.url).toBe(JEV_ENDPOINT);
	expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
		"Bearer ts-test",
	);
	expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
		state: { orientation: "北" },
		model: "jev-latest",
		questions: { north: { type: "noul", instructions: "北向きか" } },
	});
});

test("429 や 5xx は再試行する", async () => {
	const { jev, requests } = server([
		new Response("", { status: 503 }),
		ok({ q: { type: "noul", noul: 0.2 } }),
	]);
	expect((await jev("x", { q: { type: "noul" } })).q).toEqual({
		type: "noul",
		noul: 0.2,
	});
	expect(requests).toHaveLength(2);
});

test("認証エラーは再試行せず JevFailed にする", async () => {
	const { jev, requests } = server([
		new Response("invalid key", { status: 401 }),
	]);
	await expect(jev("x", { q: { type: "noul" } })).rejects.toBeInstanceOf(
		JevFailed,
	);
	expect(requests).toHaveLength(1);
});

test("想定と違う応答は JevFailed にする", async () => {
	const { jev } = server([ok({ q: { type: "noul" } })]);
	await expect(jev("x", { q: { type: "noul" } })).rejects.toBeInstanceOf(
		JevFailed,
	);
});
