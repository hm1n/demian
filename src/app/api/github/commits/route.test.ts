import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptGitHubToken, GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { POST } from "./route";

const SHA = "a".repeat(40);

function request() {
  const cookie = `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("secret")}`;
  return new NextRequest("http://localhost/api/github/commits", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ owner: "octocat", repo: "hello-world" }),
  });
}

function setupUntilCommit(response: Response) {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ login: "octocat" }))
    .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
    .mockResolvedValueOnce(Response.json({ commit: { sha: SHA } }))
    .mockResolvedValueOnce(response));
}

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/github/commits", () => {
  it("정상 응답에 커밋과 저장소 커밋 존재 근거를 반환한다", async () => {
    setupUntilCommit(Response.json([{ sha: SHA, commit: { message: "feat", author: { name: "Octo", date: "2026-08-21" } }, author: { login: "octocat" }, parents: [{ sha: "b".repeat(40) }] }]));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repositoryHasCommits: true, cursor: null, commits: [{ sha: SHA, title: "feat" }] });
  });

  it.each([
    [404, {}, "repo_not_found", 404, undefined],
    [403, { message: "forbidden" }, "rate_limit", 429, { "x-ratelimit-remaining": "0" }],
    [403, { message: "You have exceeded a secondary rate limit" }, "rate_limit", 429, undefined],
    [429, {}, "rate_limit", 429, undefined],
    [422, {}, "server_error", 500, undefined],
  ] as const)("GitHub %s를 %s로 직렬화한다", async (upstreamStatus, body, kind, status, headers) => {
    setupUntilCommit(Response.json(body, { status: upstreamStatus, headers }));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ kind });
  });

  it("GitHub 409를 빈 저장소의 직접 근거로 처리한다", async () => {
    setupUntilCommit(Response.json({}, { status: 409 }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commits: [], repositoryHasCommits: false, cursor: null });
  });

  it("성공 응답 JSON 파싱 실패를 network로 직렬화한다", async () => {
    setupUntilCommit(new Response("broken", { status: 200 }));
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ kind: "network" });
  });

  it("후속 페이지 실패에서 이미 받은 커밋과 근본 원인을 보존한다", async () => {
    const first = Response.json([{ sha: SHA, commit: { message: "feat", author: null }, author: null, parents: [] }], { headers: { link: `<next>; rel="next"` } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ login: "octocat" }))
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({ commit: { sha: SHA } }))
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(Response.json({}, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ kind: "partial_failure", causeKind: "rate_limit", completed: 1, partialCommits: [{ sha: SHA }] });
  });
});
