import { z } from "zod";

// TypeSafe AI の Jev (System One)。文字列は生成せず、型付きの設問に確率で答える
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

type Content = string | Record<string, unknown> | unknown[];

export type JevQuestion =
	| {
			type: "noul";
			instructions?: Content;
			criteria?: { true?: Content; false?: Content };
	  }
	| {
			type: "choice";
			instructions?: Content;
			criteria: Record<string, Content | null>;
	  }
	| { type: "score"; instructions?: Content; criteria: Content[] };

const answerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("noul"), noul: z.number() }),
	z.object({
		type: z.literal("choice"),
		choice: z.string(),
		confidence: z.number(),
		probabilities: z.record(z.string(), z.number()),
	}),
	z.object({
		type: z.literal("score"),
		score: z.number(),
		confidence: z.number(),
		probabilities: z.record(z.string(), z.number()),
	}),
]);
export type JevAnswer = z.infer<typeof answerSchema>;

const responseSchema = z.object({
	answers: z.record(z.string(), answerSchema),
});

export class JevFailed extends Error {}

export type Jev = (
	state: Content,
	questions: Record<string, JevQuestion>,
) => Promise<Record<string, JevAnswer>>;

const RETRIES = 3;
const TIMEOUT_MS = 10_000;

export function createJev(options: {
	apiKey: string;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
}): Jev {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? Bun.sleep;
	return async (state, questions) => {
		const body = JSON.stringify({ state, model: JEV_MODEL, questions });
		let last = "";
		for (let attempt = 0; attempt < RETRIES; attempt++) {
			if (attempt > 0) await sleep(500 * 2 ** attempt);
			let res: Response;
			try {
				res = await fetchImpl(JEV_ENDPOINT, {
					method: "POST",
					headers: {
						authorization: `Bearer ${options.apiKey}`,
						"content-type": "application/json",
					},
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			} catch (error) {
				last = String(error);
				continue;
			}
			// 認証や設問の誤りは再試行しても直らない
			if (res.status === 429 || res.status >= 500) {
				last = `HTTP ${res.status}`;
				continue;
			}
			if (!res.ok)
				throw new JevFailed(
					`Jev が HTTP ${res.status} を返した: ${(await res.text()).slice(0, 200)}`,
				);
			const parsed = responseSchema.safeParse(await res.json());
			if (!parsed.success)
				throw new JevFailed(
					`Jev の応答が想定と違う: ${z.prettifyError(parsed.error)}`,
				);
			return parsed.data.answers;
		}
		throw new JevFailed(`Jev への問い合わせが ${RETRIES} 回失敗した: ${last}`);
	};
}

// API キーが無ければ Jev を使わず、呼び出し側で Claude に任せる
export const jevFromEnv = (): Jev | null => {
	const apiKey = process.env.TYPESAFE_API_KEY;
	return apiKey ? createJev({ apiKey }) : null;
};
