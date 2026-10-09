import type { Profile } from "./config.ts";

export type Notification = {
	title: string;
	message: string;
	priority?: 1 | 2 | 3 | 4 | 5;
	tags?: string[];
};
export type Notifier = (n: Notification) => Promise<void>;

export const logNotifier: Notifier = async (n) => {
	console.log(`[通知] ${n.title}\n${n.message}`);
};

export function createNotifier(
	profile: Profile,
	options: { dryRun: boolean },
): Notifier {
	const topic = profile.ntfy_topic;
	if (options.dryRun || !topic) return logNotifier;
	return async (n) => {
		// ヘッダーは ASCII しか通らないので、日本語の件名は JSON で送る
		const res = await fetch(profile.ntfy_server, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic,
				title: n.title,
				message: n.message,
				priority: n.priority ?? 3,
				tags: n.tags ?? [],
			}),
		});
		if (!res.ok) console.error(`ntfy への通知に失敗した: HTTP ${res.status}`);
	};
}
