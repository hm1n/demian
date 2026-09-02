import { createGitHubSessionCookie, encryptGitHubToken } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  GitHubOAuthConfigError,
  deleteOAuthStateCookie,
  exchangeGitHubCode,
  getGitHubOAuthConfig,
  oauthStatesMatch,
} from "@/lib/github/oauth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * state가 일치하지 않으면 쿠키를 지우지 않습니다. 그 값은 우리가 시작한 로그인의 것이 아닙니다.
 * 지우면 아무나 이 엔드포인트를 크로스사이트로 호출해 진행 중인 남의 로그인을 끊을 수 있습니다.
 */
function redirect(request: Request, code?: string, clearState = true): Response {
  const headers = new Headers({ Location: new URL(code ? `/?auth_error=${code}` : "/", request.url).toString() });
  if (clearState) headers.append("Set-Cookie", deleteOAuthStateCookie());
  return new Response(null, { status: 302, headers });
}

export async function GET(request: NextRequest): Promise<Response> {
  const query = request.nextUrl.searchParams;
  // GitHub은 거부 콜백에도 state를 실어 보내므로 취소 흐름보다 먼저 검증할 수 있습니다.
  if (!oauthStatesMatch(request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value, query.get("state"))) {
    return redirect(request, "state_mismatch", false);
  }
  if (query.has("error")) return redirect(request, "access_denied");
  let token: string;
  try {
    const config = getGitHubOAuthConfig(request.url);
    const code = query.get("code");
    if (!code) throw new Error("GitHub OAuth code is missing");
    token = await exchangeGitHubCode(config, code);
  } catch (error) {
    if (error instanceof GitHubOAuthConfigError) return redirect(request, "config_missing");
    return redirect(request, "exchange_failed");
  }
  try {
    const headers = new Headers({ Location: new URL("/", request.url).toString() });
    headers.append("Set-Cookie", createGitHubSessionCookie(encryptGitHubToken(token)));
    headers.append("Set-Cookie", deleteOAuthStateCookie());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return redirect(request, error instanceof GitHubFetchError && error.kind === "server_error" ? "config_missing" : "exchange_failed");
  }
}
