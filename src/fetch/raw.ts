import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type RawStore = {
	save: (jstDate: string, name: string, html: string) => Promise<string>;
	prune: (todayJst: string, keepDays: number) => void;
};

export function createRawStore(root: string): RawStore {
	return {
		async save(jstDate, name, html) {
			const dir = join(root, jstDate);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${name.replace(/[^\w.-]/g, "_")}.html`);
			await Bun.write(path, html);
			return path;
		},
		prune(todayJst, keepDays) {
			if (!existsSync(root)) return;
			const limit =
				new Date(`${todayJst}T00:00:00Z`).getTime() - keepDays * 86_400_000;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name))
					continue;
				if (new Date(`${entry.name}T00:00:00Z`).getTime() < limit) {
					rmSync(join(root, entry.name), { recursive: true, force: true });
				}
			}
		},
	};
}

export const noopRawStore: RawStore = {
	save: async () => "",
	prune: () => {},
};
