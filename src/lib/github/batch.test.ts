import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutPatch } from "@/app/api/github/commit-details/route";
import { fetchAuthoredCommitsBatch } from "./commits";
import { fetchRepositoryMetadata } from "./contributions";
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
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchAuthoredCommitsBatch(AUTH, null, 1);
    await fetchAuthoredCommitsBatch(AUTH, first.cursor, 1);

    expect(first.cursor).toEqual({ headSha: SHA, login: "octocat", page: 2 });
    expect(fetchMock.mock.calls[4][0]).toContain(`sha=${SHA}`);
    expect(fetchMock.mock.calls[4][0]).toContain("page=2");
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
    await expect(fetchRepositoryMetadata(AUTH, true)).resolves.toEqual({
      tree: [{ path: "src", type: "tree", sha: SHA }],
      treeTruncated: true,
      languages: { TypeScript: 10 },
    });
  });
});
