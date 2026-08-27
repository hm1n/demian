import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { GET } from "./route";

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 4).toString("base64");
});
afterEach(() => {
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env[GITHUB_SESSION_KEY_ENV];
  vi.unstubAllGlobals();
});

function request(query: string, stateCookie = "state") {
  return new NextRequest(`https://app.test/api/auth/github/callback?${query}`, { headers: { cookie: `github_oauth_state=${stateCookie}` } });
}

describe("GitHub OAuth callback", () => {
  it("sets the session, deletes state, and redirects home", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "token" })));
    const response = await GET(request("code=code&state=state"));
    const cookies = response.headers.getSetCookie();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/");
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("github_session=");
    expect(cookies[0]).toContain("Max-Age=28800");
    expect(cookies[1]).toContain("github_oauth_state=");
    expect(cookies[1]).toContain("Max-Age=0");
  });

  it("maps a denied authorization to access_denied and deletes state", async () => {
    const response = await GET(request("error=access_denied&state=state"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=access_denied");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining("github_oauth_state=; ")]);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  // state가 우리 것이 아니면 쿠키를 지우지 않습니다. 지우면 크로스사이트 호출로 남의 로그인을 끊을 수 있습니다.
  it.each([
    ["a mismatched state", "code=code&state=wrong"],
    ["a missing state", "code=code"],
    ["an error without a state", "error=access_denied"],
  ])("keeps the state cookie on %s", async (_label, query) => {
    const response = await GET(request(query));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=state_mismatch");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("maps missing OAuth configuration to config_missing", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    const response = await GET(request("code=code&state=state"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=config_missing");
  });

  it("maps a missing code to exchange_failed", async () => {
    const response = await GET(request("state=state"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=exchange_failed");
  });

  it("maps a missing session encryption key to config_missing", async () => {
    delete process.env[GITHUB_SESSION_KEY_ENV];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "token" })));
    const response = await GET(request("code=code&state=state"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=config_missing");
    expect(response.headers.get("set-cookie")).not.toContain("github_session=");
  });

  it("sends the exchange request to GitHub with the client secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: "token" }));
    vi.stubGlobal("fetch", fetchMock);
    await GET(request("code=the-code&state=state"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Accept: "application/json" }) })
    );
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("client_secret=client-secret");
    expect(body).toContain("code=the-code");
  });

  it("maps exchange failures to exchange_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const response = await GET(request("code=code&state=state"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=exchange_failed");
    expect(response.headers.get("set-cookie")).toContain("github_oauth_state=; ");
  });
});
