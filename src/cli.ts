#!/usr/bin/env bun
import { parseArgs } from "node:util";

export type JobOptions = { dryRun: boolean };
type Job = (options: JobOptions) => Promise<void>;

const notImplemented =
	(name: string): Job =>
	async () => {
		throw new Error(`${name} は未実装です`);
	};

export const jobs = {
	fetch: notImplemented("fetch"),
	evaluate: notImplemented("evaluate"),
	inquire: notImplemented("inquire"),
	inbox: notImplemented("inbox"),
	plan: notImplemented("plan"),
	status: notImplemented("status"),
	serve: notImplemented("serve"),
} satisfies Record<string, Job>;

const isJobName = (name: string): name is keyof typeof jobs =>
	Object.hasOwn(jobs, name);

const usage = `使い方: shinkyo <${Object.keys(jobs).join("|")}> [--dry-run]`;

export async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { "dry-run": { type: "boolean", default: false } },
	});
	const [name] = positionals;
	if (name === undefined || !isJobName(name)) {
		console.error(usage);
		return 2;
	}
	await jobs[name]({ dryRun: values["dry-run"] });
	return 0;
}

if (import.meta.main) {
	process.exit(await main(Bun.argv.slice(2)));
}
