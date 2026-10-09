import { expect, test } from "bun:test";
import { z } from "zod";
import { type ClaudeRunner, callClaude, LlmFailed } from "../src/llm.ts";

const schema = z.object({ ok: z.boolean() });
const reply = (structured: unknown, exitCode = 0) => ({
	exitCode,
	stdout: JSON.stringify({ is_error: false, structured_output: structured }),
});

function runner(replies: ReturnType<typeof reply>[]) {
	const calls: { args: string[]; stdin: string; cwd: string }[] = [];
	const run: ClaudeRunner = async (args, stdin, cwd) => {
		calls.push({ args, stdin, cwd });
		return replies.shift() ?? reply(null, 1);
	};
	return { run, calls };
}

const call = (run: ClaudeRunner) =>
	callClaude({
		schema,
		systemPrompt: "sys",
		instruction: "評価して",
		input: { a: 1 },
		runner: run,
	});

test("構造化出力をスキーマで検証して返し、入力は標準入力で渡す", async () => {
	const { run, calls } = runner([reply({ ok: true })]);
	expect(await call(run)).toEqual({ ok: true });
	expect(calls[0]?.stdin).toBe('{"a":1}');
	expect(calls[0]?.args).toContain("--json-schema");
	expect(calls[0]?.args).not.toContain("--bare");
	expect(calls[0]?.cwd).not.toContain(process.cwd());
});

test("スキーマ不一致は1回だけ再試行する", async () => {
	const { run, calls } = runner([reply({ ok: "yes" }), reply({ ok: false })]);
	expect(await call(run)).toEqual({ ok: false });
	expect(calls).toHaveLength(2);
});

test("2回失敗したら LlmFailed を投げる", async () => {
	const { run, calls } = runner([reply({ ok: "yes" }), reply(null, 1)]);
	await expect(call(run)).rejects.toBeInstanceOf(LlmFailed);
	expect(calls).toHaveLength(2);
});
