import { createGitHubAuthorizeUrl, createOAuthState, createOAuthStateCookie, getGitHubOAuthConfig } from "@/lib/github/oauth";

export const runtime = "nodejs";

export function GET(request: Request): Response {
  const state = createOAuthState();
  let location: string;
  try { location = createGitHubAuthorizeUrl(getGitHubOAuthConfig(request.url), state); }
  catch { return Response.redirect(new URL("/?auth_error=config_missing", request.url), 302); }
  return new Response(null, { status: 302, headers: {
    Location: location,
    "Set-Cookie": createOAuthStateCookie(state),
  } });
}
