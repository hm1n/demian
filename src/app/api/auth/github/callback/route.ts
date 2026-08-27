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

function redirect(request: Request, code?: string): Response {
  const headers = new Headers({ Location: new URL(code ? `/?auth_error=${code}` : "/", request.url).toString() });
  headers.append("Set-Cookie", deleteOAuthStateCookie());
  return new Response(null, { status: 302, headers });
}

export async function GET(request: NextRequest): Promise<Response> {
  const query = request.nextUrl.searchParams;
  if (query.has("error")) return redirect(request, "access_denied");
  if (!oauthStatesMatch(request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value, query.get("state"))) return redirect(request, "state_mismatch");
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
