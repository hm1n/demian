import { GITHUB_SESSION_COOKIE, encryptGitHubToken } from "@/lib/github/auth-session";
import { fetchAuthenticatedUserLogin } from "@/lib/github/commits";
import { GitHubFetchError } from "@/lib/github/errors";

export const runtime = "nodejs";

const COOKIE_OPTIONS = "Path=/; HttpOnly; Secure; SameSite=Lax";

export async function handleSession(
  request: Request,
  validateToken: (token: string) => Promise<string> = fetchAuthenticatedUserLogin
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "요청 본문은 JSON이어야 합니다." }, { status: 400 });
  }

  const token = typeof body === "object" && body !== null && "token" in body ? body.token : undefined;
  if (typeof token !== "string" || token.trim() === "") {
    return Response.json({ error: "GitHub token이 필요합니다." }, { status: 422 });
  }

  try {
    await validateToken(token);
  } catch (error) {
    if (error instanceof GitHubFetchError) {
      const status = error.kind === "auth_revoked" ? 401 : error.kind === "rate_limit" ? 429 : 502;
      return Response.json({ error: "GitHub token을 확인하지 못했습니다." }, { status });
    }
    return Response.json({ error: "GitHub token을 확인하지 못했습니다." }, { status: 502 });
  }

  try {
    const encryptedToken = encryptGitHubToken(token);
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": `${GITHUB_SESSION_COOKIE}=${encryptedToken}; ${COOKIE_OPTIONS}` },
    });
  } catch {
    return Response.json({ error: "인증 세션을 만들지 못했습니다." }, { status: 500 });
  }
}

export function POST(request: Request): Promise<Response> {
  return handleSession(request);
}

export function DELETE(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": `${GITHUB_SESSION_COOKIE}=; ${COOKIE_OPTIONS}; Max-Age=0` },
  });
}
