import { homedir } from "node:os";
import { join } from "node:path";

export type LaunchdOptions = {
	// デプロイの置き場所。各ジョブは root/current (今の版) で動く
	root: string;
	bunPath: string;
	port: number;
	fetchIntervalMin: number;
};

export type LaunchAgent = { label: string; xml: string };

const escapeXml = (s: string): string =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const strings = (values: string[]): string =>
	values.map((v) => `\t\t<string>${escapeXml(v)}</string>`).join("\n");

function plist(
	label: string,
	o: LaunchdOptions,
	args: string[],
	extra: string,
): LaunchAgent {
	const log = join(logDir(o.root), `${label.split(".").at(-1)}.log`);
	return {
		label,
		xml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
${strings([o.bunPath, "src/cli.ts", ...args])}
	</array>
	<key>WorkingDirectory</key>
	<string>${escapeXml(join(o.root, "current"))}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/run/current-system/sw/bin:/usr/bin:/bin</string>
	</dict>
	<key>StandardOutPath</key>
	<string>${escapeXml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(log)}</string>
${extra}
</dict>
</plist>
`,
	};
}

// 取得時間帯の判定は HttpClient が行うので、launchd は一定間隔で起動するだけにする
export function launchAgents(o: LaunchdOptions): LaunchAgent[] {
	return [
		plist(
			"com.shinkyo.fetch",
			o,
			["fetch"],
			`	<key>StartInterval</key>
	<integer>${o.fetchIntervalMin * 60}</integer>
	<key>RunAtLoad</key>
	<true/>`,
		),
		plist(
			"com.shinkyo.serve",
			o,
			["serve", "--port", String(o.port), "--skip-build"],
			`	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>`,
		),
		// push から反映まで最大 2 分。CI の確認は新しいコミットがあるときだけ API を呼ぶ
		plist(
			"com.shinkyo.deploy",
			o,
			["deploy", "--root", o.root, "--port", String(o.port)],
			`	<key>StartInterval</key>
	<integer>120</integer>
	<key>RunAtLoad</key>
	<true/>`,
		),
	];
}

export const logDir = (root: string): string =>
	join(root, "shared", "data", "logs");

// macOS のバックグラウンド実行は Desktop・Documents・Downloads を読めない (仕様 2章)
export function protectedLocation(root: string): string | null {
	const home = homedir();
	return (
		["Desktop", "Documents", "Downloads"]
			.map((d) => join(home, d))
			.find((d) => root.startsWith(`${d}/`)) ?? null
	);
}

export const launchAgentPath = (label: string): string =>
	join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
