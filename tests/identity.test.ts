import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessIdentity } from "../src/web/identity.ts";

const TEAM = "example.cloudflareaccess.com";
const AUD = "test-aud";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
	keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }],
});
const identify = accessIdentity({ teamDomain: TEAM, aud: AUD, keys });

const token = (claims: { iss?: string; aud?: string; email?: string }) =>
	new SignJWT({ email: claims.email ?? "a@example.com" })
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(claims.iss ?? `https://${TEAM}`)
		.setAudience(claims.aud ?? AUD)
		.setExpirationTime("5m")
		.sign(privateKey);

const request = (headers: Record<string, string>) =>
	new Request("http://127.0.0.1/", { headers });

test("Access のトークンを検証し、確認済みのメールアドレスを人として返す", async () => {
	expect(
		await identify(request({ "cf-access-jwt-assertion": await token({}) })),
	).toBe("a@example.com");
});

test("AUD や発行元が違うトークン、トークンの無いリクエストは受け付けない", async () => {
	expect(
		await identify(
			request({ "cf-access-jwt-assertion": await token({ aud: "other" }) }),
		),
	).toBeNull();
	expect(
		await identify(
			request({
				"cf-access-jwt-assertion": await token({ iss: "https://evil.example" }),
			}),
		),
	).toBeNull();
	expect(await identify(request({}))).toBeNull();
});

test("メールアドレスのヘッダーだけを偽装しても通らない", async () => {
	expect(
		await identify(
			request({ "cf-access-authenticated-user-email": "a@example.com" }),
		),
	).toBeNull();
});
