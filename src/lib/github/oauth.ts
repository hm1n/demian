import { randomBytes, timingSafeEqual } from "node:crypto";

export const GITHUB_OAUTH_STATE_COOKIE = "github_oauth_state";

const STATE_COOKIE_OPTIONS = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function createOAuthStateCookie(state: string): string {
  return `${GITHUB_OAUTH_STATE_COOKIE}=${state}; ${STATE_COOKIE_OPTIONS}; Max-Age=600`;
}

/** state는 일회용이므로 콜백이 어떻게 끝나든 지웁니다. */
export function deleteOAuthStateCookie(): string {
  return `${GITHUB_OAUTH_STATE_COOKIE}=; ${STATE_COOKIE_OPTIONS}; Max-Age=0`;
}

/**
 * 사용자가 조치할 수 없는 서버 문제를 교환 실패와 구분합니다. 앞은 다시 시도해도 같은 결과이고
 * 뒤는 다시 시도할 값이 있습니다.
 */
export class GitHubOAuthConfigError extends Error {}

/** GitHub이 HTTP 200 본문으로 돌려주는 오류 중 서버 설정이 원인인 것입니다. */
const CONFIG_ERROR_CODES = new Set(["incorrect_client_credentials", "redirect_uri_mismatch"]);

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export type GitHubOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function getGitHubOAuthConfig(requestUrl: string): GitHubOAuthConfig {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GitHubOAuthConfigError("GitHub OAuth configuration is missing");
  return { clientId, clientSecret, redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI ?? new URL("/api/auth/github/callback", new URL(requestUrl).origin).toString() };
}

export function createGitHubAuthorizeUrl(config: GitHubOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: "read:user", state }).toString();
  return url.toString();
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthStatesMatch(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function exchangeGitHubCode(config: GitHubOAuthConfig, code: string): Promise<string> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri }),
  });
  if (!response.ok) throw new Error(`GitHub token exchange failed with status ${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error("GitHub token exchange returned invalid JSON"); }
  if (typeof body !== "object" || body === null) throw new Error("GitHub token exchange returned an invalid body");
  if ("error" in body) {
    const errorCode = String(body.error);
    const message = `GitHub token exchange returned an error: ${errorCode}`;
    throw CONFIG_ERROR_CODES.has(errorCode) ? new GitHubOAuthConfigError(message) : new Error(message);
  }
  const token = "access_token" in body ? body.access_token : undefined;
  if (typeof token !== "string" || !token) throw new Error("GitHub token exchange returned no access token");
  return token;
}
