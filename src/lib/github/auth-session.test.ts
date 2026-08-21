import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV, encryptGitHubToken, getGitHubTokenFromRequest } from "./auth-session";

const TOKEN = "github_pat_sensitive";

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  delete process.env[GITHUB_SESSION_KEY_ENV];
});

describe("GitHub 인증 세션", () => {
  it("요청 쿠키의 암호화된 값에서만 토큰을 읽는다", () => {
    const encrypted = encryptGitHubToken(TOKEN);
    const request = new NextRequest("https://example.com", { headers: { cookie: `${GITHUB_SESSION_COOKIE}=${encrypted}` } });
    expect(encrypted).not.toContain(TOKEN);
    expect(getGitHubTokenFromRequest(request)).toBe(TOKEN);
  });

  it("쿠키가 없으면 기존 auth_revoked 오류를 던진다", () => {
    const request = new NextRequest("https://example.com", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(() => getGitHubTokenFromRequest(request)).toThrow(expect.objectContaining({ kind: "auth_revoked" }));
  });

  it("변조된 쿠키는 auth_revoked 오류로 처리한다", () => {
    const request = new NextRequest("https://example.com", { headers: { cookie: `${GITHUB_SESSION_COOKIE}=tampered` } });
    expect(() => getGitHubTokenFromRequest(request)).toThrow(expect.objectContaining({ kind: "auth_revoked" }));
  });
});
