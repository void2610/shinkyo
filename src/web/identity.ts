import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

// リクエストから操作した人を返す。分からなければ null (入口で拒否する)
export type Identify = (request: Request) => Promise<string | null>;

export const LOCAL_PERSON = "local";

// Cloudflare Access が付ける署名付きトークンを検証し、確認済みのメールアドレスを人として使う。
// メールアドレスのヘッダーは偽装できるので、トークンの署名・発行元・AUD まで確かめる
export function accessIdentity(options: {
	teamDomain: string;
	aud: string;
	keys?: JWTVerifyGetKey;
}): Identify {
	const issuer = `https://${options.teamDomain}`;
	const keys =
		options.keys ??
		createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
	return async (request) => {
		const token = request.headers.get("cf-access-jwt-assertion");
		if (!token) return null;
		try {
			const { payload } = await jwtVerify(token, keys, {
				issuer,
				audience: options.aud,
			});
			return typeof payload.email === "string" ? payload.email : null;
		} catch {
			return null;
		}
	};
}

// Access を設定していない開発環境では、全員を同じ1人として扱う
export const localIdentity: Identify = async () => LOCAL_PERSON;
