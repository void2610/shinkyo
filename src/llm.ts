import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type ClaudeRunner = (
	args: string[],
	stdin: string,
	cwd: string,
) => Promise<{ exitCode: number; stdout: string }>;

export const spawnClaude: ClaudeRunner = async (args, stdin, cwd) => {
	const proc = Bun.spawn(["claude", ...args], {
		cwd,
		stdin: new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { exitCode, stdout };
};

export class LlmFailed extends Error {}

const envelope = z.object({
	is_error: z.boolean().optional(),
	structured_output: z.unknown(),
});

// claude -p の呼び出しはここに集める。判断の材料を返すだけで、送信や状態の変更はしない (仕様 1章)
export async function callClaude<T>(options: {
	schema: z.ZodType<T>;
	systemPrompt: string;
	instruction: string;
	input: unknown;
	runner?: ClaudeRunner;
}): Promise<T> {
	const runner = options.runner ?? spawnClaude;
	const jsonSchema = JSON.stringify(
		z.toJSONSchema(options.schema, { target: "draft-7" }),
	);
	const args = [
		"-p",
		"--output-format",
		"json",
		"--json-schema",
		jsonSchema,
		"--append-system-prompt",
		options.systemPrompt,
		"--permission-mode",
		"dontAsk",
		"--tools",
		"",
		"--strict-mcp-config",
		"--no-session-persistence",
		options.instruction,
	];
	// リポジトリの CLAUDE.md などを読ませないよう、空の一時ディレクトリで動かす
	const cwd = mkdtempSync(join(tmpdir(), "shinkyo-llm-"));
	const errors: string[] = [];
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await runner(args, JSON.stringify(options.input), cwd);
			if (res.exitCode !== 0) {
				errors.push(`exit ${res.exitCode}`);
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(res.stdout);
			} catch {
				errors.push("JSON でない出力");
				continue;
			}
			const env = envelope.safeParse(parsed);
			if (!env.success || env.data.is_error) {
				errors.push("エラー応答");
				continue;
			}
			const result = options.schema.safeParse(env.data.structured_output);
			if (result.success) return result.data;
			errors.push(`スキーマ不一致: ${z.prettifyError(result.error)}`);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
	throw new LlmFailed(`claude -p が2回失敗した: ${errors.join(" / ")}`);
}
