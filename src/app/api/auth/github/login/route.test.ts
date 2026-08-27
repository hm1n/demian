import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
});
afterEach(() => {
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.GITHUB_OAUTH_REDIRECT_URI;
});

describe("GitHub OAuth login", () => {
  it("sets state and redirects to GitHub", () => {
    const response = GET(new Request("https://app.test/api/auth/github/login"));
    const location = new URL(response.headers.get("location")!);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(cookie).toContain(`github_oauth_state=${location.searchParams.get("state")}`);
    expect(cookie).toContain("Max-Age=600");
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attribute);
  });

  it("redirects with config_missing when configuration is absent", () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const response = GET(new Request("https://app.test/api/auth/github/login"));
    expect(response.headers.get("location")).toBe("https://app.test/?auth_error=config_missing");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
