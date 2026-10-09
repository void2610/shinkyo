import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export class JobLocked extends Error {}

// launchd から二重に起動されても、同じジョブは1つしか動かさない
export async function withLock<T>(
	dir: string,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.lock`);
	try {
		writeFileSync(path, String(process.pid), { flag: "wx" });
	} catch {
		const holder = Number(readFileSync(path, "utf8"));
		if (isAlive(holder))
			throw new JobLocked(`${name} は実行中 (pid ${holder})`);
		writeFileSync(path, String(process.pid));
	}
	try {
		return await fn();
	} finally {
		rmSync(path, { force: true });
	}
}
