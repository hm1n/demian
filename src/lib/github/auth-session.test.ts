import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GITHUB_SESSION_COOKIE,
  GITHUB_SESSION_KEY_ENV,
  GITHUB_SESSION_MAX_AGE_SECONDS,
  encryptGitHubToken,
  getGitHubTokenFromRequest,
} from "./auth-session";

const TOKEN = "github_pat_sensitive";

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  delete process.env[GITHUB_SESSION_KEY_ENV];
  vi.useRealTimers();
});

function requestWith(value: string) {
  return new NextRequest("https://example.com", { headers: { cookie: `${GITHUB_SESSION_COOKIE}=${value}` } });
}

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

  // 쿠키 값을 복사해 두면 `Max-Age`가 지나도 브라우저 밖에서 그대로 재생할 수 있습니다.
  // 수명은 서버가 판단해야 합니다.
  it("수명이 지난 값을 복사해 다시 보내면 auth_revoked 오류로 처리한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    const encrypted = encryptGitHubToken(TOKEN);
    expect(getGitHubTokenFromRequest(requestWith(encrypted))).toBe(TOKEN);

    vi.advanceTimersByTime(GITHUB_SESSION_MAX_AGE_SECONDS * 1000 - 1000);
    expect(getGitHubTokenFromRequest(requestWith(encrypted))).toBe(TOKEN);

    vi.advanceTimersByTime(2000);
    expect(() => getGitHubTokenFromRequest(requestWith(encrypted))).toThrow(expect.objectContaining({ kind: "auth_revoked" }));
  });

  it("발급 시각이 미래인 값은 auth_revoked 오류로 처리한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
    const encrypted = encryptGitHubToken(TOKEN);
    vi.setSystemTime(new Date("2026-08-27T11:00:00Z"));
    expect(() => getGitHubTokenFromRequest(requestWith(encrypted))).toThrow(expect.objectContaining({ kind: "auth_revoked" }));
  });
});
