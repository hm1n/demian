import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptGitHubToken, GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { POST as commits } from "./commits/route";
import { POST as details } from "./commit-details/route";
import { POST as metadata } from "./repository-meta/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/github/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticatedRequest(body: unknown) {
  const cookie = `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("secret")}`;
  return new NextRequest("http://localhost/api/github/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, authenticated = false) {
  const cookie = authenticated ? `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("secret")}` : "";
  return new NextRequest("http://localhost/api/github/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
}

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 9).toString("base64");
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub route token 경계", () => {
  it.each([
    ["commits", commits, { owner: "octocat", repo: "hello-world" }],
    ["commit-details", details, { owner: "octocat", repo: "hello-world", commits: [] }],
    ["repository-meta", metadata, { owner: "octocat", repo: "hello-world" }],
  ] as const)("%s는 쿠키가 없으면 auth_revoked를 반환한다", async (_name, handler, body) => {
    const response = await handler(request(body));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { kind: "auth_revoked" } });
  });
});

describe("GitHub route 요청 검증", () => {
  it("JSON이 아닌 본문을 invalid_json 400 봉투로 반환한다", async () => {
    const response = await commits(rawRequest("broken"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { kind: "invalid_json" } });
  });

  it.each([
    ["객체가 아닌 본문", commits, "[]"],
    ["owner 누락", commits, JSON.stringify({ repo: "hello-world" })],
    ["손상 커서", commits, JSON.stringify({ owner: "octocat", repo: "hello-world", cursor: "broken" })],
    ["commits 형식 위반", details, JSON.stringify({ owner: "octocat", repo: "hello-world", commits: {} })],
    ["commits 상한 초과", details, JSON.stringify({ owner: "octocat", repo: "hello-world", commits: Array.from({ length: 21 }, () => ({ sha: "a", title: "t", author: "a", date: "d", parentCount: 1 })) })],
  ] as const)("%s를 invalid_request 422 봉투로 반환한다", async (_name, handler, body) => {
    const response = await handler(rawRequest(body, true));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { kind: "invalid_request" } });
  });
});

describe("GitHub detail/meta route 응답", () => {
  it("commit-details 정상 응답에서 patch를 제거한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        sha: "a".repeat(40), commit: { message: "feat", author: null }, author: null,
        stats: { additions: 1, deletions: 0 },
        files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "diff" }],
      }))
      .mockResolvedValueOnce(Response.json([])));
    const summary = { sha: "a".repeat(40), title: "feat", author: "octocat", date: "2026-08-21", parentCount: 1 };
    const response = await details(authenticatedRequest({ owner: "octocat", repo: "hello-world", commits: [summary] }));
    expect(response.status).toBe(200);
    expect((await response.json()).commits[0].files[0]).not.toHaveProperty("patch");
  });

  it("commit-details 부분 실패 응답에서도 patch를 제거하고 진행 수치를 보존한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        sha: "a".repeat(40), commit: { message: "feat", author: null }, author: null,
        stats: { additions: 1, deletions: 0 },
        files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "diff" }],
      }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({}, { status: 429 })));
    const summaries = ["a", "b"].map((value) => ({ sha: value.repeat(40), title: "feat", author: "octocat", date: "2026-08-21", parentCount: 1 }));
    const response = await details(authenticatedRequest({ owner: "octocat", repo: "hello-world", commits: summaries }));
    const body = await response.json();
    expect(body).toMatchObject({ error: { kind: "partial_failure", causeKind: "rate_limit", completed: 1, total: 2 } });
    expect(body.error.partialCommits[0].files[0]).not.toHaveProperty("patch");
  });

  it("repository-meta 정상 응답에서 type, truncated, languages를 보존한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ TypeScript: 10 }))
      .mockResolvedValueOnce(Response.json({ truncated: true, tree: [{ path: "src", type: "tree", sha: "a".repeat(40) }] })));
    const response = await metadata(authenticatedRequest({ owner: "octocat", repo: "hello-world" }));
    expect(await response.json()).toEqual({ tree: [{ path: "src", type: "tree", sha: "a".repeat(40) }], treeTruncated: true, languages: { TypeScript: 10 } });
  });
});
