import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubOAuthConfigError,
  createGitHubAuthorizeUrl,
  createOAuthState,
  exchangeGitHubCode,
  getGitHubOAuthConfig,
  oauthStatesMatch,
  type GitHubOAuthConfig,
} from "./oauth";

const config: GitHubOAuthConfig = { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/api/auth/github/callback" };

afterEach(() => vi.unstubAllGlobals());

describe("exchangeGitHubCode", () => {
  it("rejects a GitHub error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 })));
    await expect(exchangeGitHubCode(config, "code")).rejects.toThrow("bad_verification_code");
  });

  it("rejects a non-object body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json("nope")));
    await expect(exchangeGitHubCode(config, "code")).rejects.toThrow("invalid body");
  });

  it("rejects a body without an access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ token_type: "bearer" })));
    await expect(exchangeGitHubCode(config, "code")).rejects.toThrow("no access token");
  });

  it("rejects an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
    await expect(exchangeGitHubCode(config, "code")).rejects.toThrow("status 502");
  });

  it("rejects invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    await expect(exchangeGitHubCode(config, "code")).rejects.toThrow("invalid JSON");
  });
});

describe("getGitHubOAuthConfig", () => {
  afterEach(() => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.GITHUB_OAUTH_REDIRECT_URI;
  });

  it("derives the redirect URI from the request origin", () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "client";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
    expect(getGitHubOAuthConfig("https://app.test/api/auth/github/login").redirectUri).toBe(
      "https://app.test/api/auth/github/callback"
    );
  });

  it("prefers the configured redirect URI", () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "client";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
    process.env.GITHUB_OAUTH_REDIRECT_URI = "https://deploy.test/api/auth/github/callback";
    expect(getGitHubOAuthConfig("https://app.test/api/auth/github/login").redirectUri).toBe(
      "https://deploy.test/api/auth/github/callback"
    );
  });

  it.each(["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"])(
    "throws a config error when %s is missing",
    (missing) => {
      process.env.GITHUB_OAUTH_CLIENT_ID = "client";
      process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
      delete process.env[missing];
      expect(() => getGitHubOAuthConfig("https://app.test/api/auth/github/login")).toThrow(GitHubOAuthConfigError);
    }
  );
});

describe("createGitHubAuthorizeUrl", () => {
  it("asks GitHub for the read:user scope only", () => {
    const url = new URL(createGitHubAuthorizeUrl(config, "state-value"));
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});

describe("oauthStatesMatch", () => {
  it("matches an identical state", () => {
    const state = createOAuthState();
    expect(oauthStatesMatch(state, state)).toBe(true);
  });

  it.each([
    ["a different state", "expected-state", "other-state"],
    ["a state of another length", "expected-state", "expected"],
    ["a missing cookie", undefined, "expected-state"],
    ["a missing query value", "expected-state", null],
  ])("rejects %s", (_label, expected, actual) => {
    expect(oauthStatesMatch(expected as string | undefined, actual as string | null)).toBe(false);
  });

  it("creates an unpredictable state", () => {
    expect(createOAuthState()).not.toBe(createOAuthState());
  });
});
