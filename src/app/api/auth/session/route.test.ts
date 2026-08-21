import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { DELETE, POST } from "./route";

const TOKEN = "github_pat_must_not_leak";

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 3).toString("base64");
});

afterEach(() => {
  delete process.env[GITHUB_SESSION_KEY_ENV];
  vi.restoreAllMocks();
});

describe("/api/auth/session", () => {
  it("토큰을 암호화된 보안 쿠키로 저장하고 응답 본문과 로그에 노출하지 않는다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new Request("https://example.com/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }));
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(cookie).toContain(`${GITHUB_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain(TOKEN);
    expect(log).not.toHaveBeenCalled();
  });

  it("JSON 파싱 실패와 유효하지 않은 토큰을 구분한다", async () => {
    const malformed = await POST(new Request("https://example.com", { method: "POST", body: "{" }));
    const invalid = await POST(new Request("https://example.com", { method: "POST", body: JSON.stringify({ token: "" }) }));
    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(422);
    expect(await malformed.text()).not.toContain(TOKEN);
    expect(await invalid.text()).not.toContain(TOKEN);
  });

  it("쿠키를 같은 보안 속성으로 만료시킨다", () => {
    const cookie = DELETE().headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GITHUB_SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });
});
