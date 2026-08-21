import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAuthoredCommitsBatch } from "./commits";
import { fetchRepositoryMetadata, withoutPatch } from "./contributions";
import type { CommitDetail } from "./types";

const AUTH = { owner: "octocat", repo: "hello-world", token: "secret" };
const SHA = "a".repeat(40);

afterEach(() => vi.unstubAllGlobals());

describe("GitHub route 배치 원시 조회", () => {
  it("다음 배치에서도 첫 요청에서 고정한 head SHA를 사용한다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ login: "octocat" }))
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({ commit: { sha: SHA } }))
      .mockResolvedValueOnce(Response.json([], { headers: { link: `<https://api.github.com/next>; rel="next"` } }))
      .mockResolvedValueOnce(Response.json({ login: "octocat" }))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchAuthoredCommitsBatch(AUTH, null, 1);
    await fetchAuthoredCommitsBatch(AUTH, first.cursor, 1);

    expect(first.cursor).toEqual({ headSha: SHA, page: 2 });
    expect(fetchMock.mock.calls[5][0]).toContain(`sha=${SHA}`);
    expect(fetchMock.mock.calls[5][0]).toContain("author=octocat");
    expect(fetchMock.mock.calls[5][0]).toContain("page=2");
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://api.github.com/user")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("형태가 유효한 커서의 login 필드를 무시하고 PAT 소유자를 다시 조회한다", async () => {
    const cursor = { headSha: SHA, page: 2, login: "attacker" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ login: "octocat" }))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAuthoredCommitsBatch(AUTH, cursor, 1);

    expect(fetchMock.mock.calls[1][0]).toContain("author=octocat");
    expect(fetchMock.mock.calls[1][0]).not.toContain("attacker");
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://api.github.com/user")).toHaveLength(1);
  });

  it("상세 route 응답 타입과 값에서 patch를 제거한다", () => {
    const detail: CommitDetail = {
      sha: SHA, title: "feat", author: "octocat", date: "2026-08-21", parentCount: 1,
      message: "feat", additions: 1, deletions: 0, changedFiles: 1,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "secret diff" }],
      pullRequests: [],
    };
    expect(withoutPatch(detail).files[0]).toEqual({ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 });
  });

  it("repository-meta가 tree entry type과 truncated, languages를 보존한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ TypeScript: 10 }))
      .mockResolvedValueOnce(Response.json({ truncated: true, tree: [{ path: "src", type: "tree", sha: SHA }] })));
    await expect(fetchRepositoryMetadata(AUTH)).resolves.toEqual({
      tree: [{ path: "src", type: "tree", sha: SHA }],
      treeTruncated: true,
      languages: { TypeScript: 10 },
    });
  });

  it("트리 404 뒤 기본 브랜치 head도 없으면 빈 트리로 확인한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ default_branch: "main" })));
    await expect(fetchRepositoryMetadata(AUTH)).resolves.toEqual({ tree: [], treeTruncated: false, languages: {} });
  });

  it("트리 404 뒤 기본 브랜치 head가 있으면 repo_not_found 오류를 유지한다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({ commit: { sha: SHA } })));
    await expect(fetchRepositoryMetadata(AUTH)).rejects.toMatchObject({ kind: "repo_not_found" });
  });

  it("트리 403 rate limit을 빈 트리로 삼키지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } })));
    await expect(fetchRepositoryMetadata(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });
});
