import { deleteGitHubSessionCookie } from "@/lib/github/auth-session";

export const runtime = "nodejs";

export function DELETE(): Response {
  return new Response(null, { status: 204, headers: { "Set-Cookie": deleteGitHubSessionCookie() } });
}
