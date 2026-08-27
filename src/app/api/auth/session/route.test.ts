import { describe, expect, it } from "vitest";
import { GITHUB_SESSION_COOKIE } from "@/lib/github/auth-session";
import * as route from "./route";

describe("/api/auth/session", () => {
  it("deletes the session cookie", () => {
    const cookie = route.DELETE().headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GITHUB_SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  it("does not expose POST", () => {
    expect("POST" in route).toBe(false);
  });
});
