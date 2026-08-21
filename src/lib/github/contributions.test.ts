import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCommitDetailBySha, fetchRepositoryContributionData } from "./contributions";
import { GitHubFetchError } from "./errors";

const AUTH = { owner: "octocat", repo: "hello-world", token: "test-token" };
const COMMITS = [
  { sha: "sha-1", title: "feat: first", author: "octocat", date: "2026-08-20", parentCount: 1 },
];

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function rawDetail() {
  return {
    sha: "sha-1",
    commit: {
      message: "feat: first\n\nimplementation detail",
      author: { name: "fallback", date: "2026-08-20T00:00:00Z" },
    },
    author: { login: "octocat" },
    stats: { additions: 12, deletions: 3, total: 15 },
    files: [
      {
        filename: "src/first.ts",
        status: "modified",
        additions: 12,
        deletions: 3,
        changes: 15,
        patch: "@@ -1 +1 @@",
      },
    ],
  };
}

function mockCompleteResponses(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(rawDetail()))
    .mockResolvedValueOnce(
      jsonResponse([
        {
          number: 7,
          title: "Add first feature",
          state: "closed",
          html_url: "https://github.com/octocat/hello-world/pull/7",
          base: { ref: "main" },
          head: { ref: "feature/first" },
        },
      ])
    )
    .mockResolvedValueOnce(jsonResponse({ TypeScript: 1000, CSS: 200 }))
    .mockResolvedValueOnce(
      jsonResponse({
        truncated: false,
        tree: [{ path: "src/first.ts", type: "blob", sha: "blob-1", size: 123 }],
      })
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRepositoryContributionData", () => {
  it("SHA만으로 조회하면 응답에서 title과 parentCount를 조립한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ...rawDetail(), parents: [{ sha: "parent" }] }))
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await fetchCommitDetailBySha(AUTH, "sha-1");

    expect(result.title).toBe("feat: first");
    expect(result.parentCount).toBe(1);
  });

  it("필터 통과 커밋의 diff, 파생 통계, PR, 파일 트리와 언어 통계를 수집한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockCompleteResponses(fetchMock);

    const result = await fetchRepositoryContributionData(AUTH, COMMITS);

    expect(result.commits[0]).toMatchObject({
      sha: "sha-1",
      message: "feat: first\n\nimplementation detail",
      additions: 12,
      deletions: 3,
      changedFiles: 1,
      files: [{ path: "src/first.ts", patch: "@@ -1 +1 @@" }],
      pullRequests: [
        {
          number: 7,
          url: "https://github.com/octocat/hello-world/pull/7",
          baseBranch: "main",
          headBranch: "feature/first",
        },
      ],
    });
    expect(result.tree).toEqual([
      { path: "src/first.ts", type: "blob", sha: "blob-1", size: 123 },
    ]);
    expect(result.languages).toEqual({ TypeScript: 1000, CSS: 200 });
    expect(result.treeTruncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/octocat/hello-world/commits/sha-1"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.github.com/repos/octocat/hello-world/languages"
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://api.github.com/repos/octocat/hello-world/git/trees/HEAD?recursive=1"
    );
  });

  it("상세 조회와 저장소 메타데이터 조회 진행 상태를 구분한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockCompleteResponses(fetchMock);
    const onProgress = vi.fn();

    await fetchRepositoryContributionData(AUTH, COMMITS, onProgress);

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { phase: "commit_details", completed: 0, total: 1 },
      { phase: "commit_details", completed: 1, total: 1 },
      { phase: "repository_metadata" },
    ]);
  });

  it("PR이 없는 커밋도 빈 소속 정보와 함께 상세 결과에 포함한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rawDetail()))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const result = await fetchRepositoryContributionData(AUTH, COMMITS);

    expect(result.commits[0].pullRequests).toEqual([]);
  });

  it("커밋 변경 파일 페이지를 끝까지 합친다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const first = rawDetail();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(first, {
          headers: {
            link: '<https://api.github.com/repos/octocat/hello-world/commits/sha-1?per_page=100&page=2>; rel="next"',
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...first,
          files: [
            {
              filename: "src/second.ts",
              status: "added",
              additions: 5,
              deletions: 0,
              changes: 5,
            },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const result = await fetchRepositoryContributionData(AUTH, COMMITS);

    expect(result.commits[0].changedFiles).toBe(2);
    expect(result.commits[0].files.map((file) => file.path)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
  });

  it("입력 커밋이 없어도 저장소 파일 트리와 언어 통계는 조회한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ TypeScript: 10 }))
      .mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const result = await fetchRepositoryContributionData(AUTH, []);

    expect(result.commits).toEqual([]);
    expect(result.languages).toEqual({ TypeScript: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("첫 상세 조회의 API 호출 한도 초과를 rate_limit으로 구분한다", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRepositoryContributionData(AUTH, COMMITS)).rejects.toMatchObject({
      kind: "rate_limit",
    });
  });

  it("일부 커밋을 수집한 뒤 실패하면 실패 범위와 수집 결과를 partial_failure로 전달한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rawDetail()))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ message: "server down" }, { status: 500 }));

    const error: GitHubFetchError = await fetchRepositoryContributionData(
      AUTH,
      [...COMMITS, { ...COMMITS[0], sha: "sha-2" }]
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(1);
    expect(error.message).toContain("sha-2");
  });

  it("일부 커밋을 수집한 뒤 호출 한도를 초과하면 원인 오류 종류를 보존한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rawDetail()))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } }
        )
      );

    const error: GitHubFetchError = await fetchRepositoryContributionData(
      AUTH,
      [...COMMITS, { ...COMMITS[0], sha: "sha-2" }]
    ).catch((caught) => caught);

    expect(error.kind).toBe("partial_failure");
    expect((error.cause as GitHubFetchError).kind).toBe("rate_limit");
  });

  it("파일 트리의 truncated 상태를 손실하지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ truncated: true, tree: [] }));

    const result = await fetchRepositoryContributionData(AUTH, []);

    expect(result.treeTruncated).toBe(true);
  });

  it("언어 통계 조회 후 트리 404가 나면 빈 저장소의 빈 트리로 처리한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { status: 404 }));

    const result = await fetchRepositoryContributionData(AUTH, []);

    expect(result.tree).toEqual([]);
    expect(result.treeTruncated).toBe(false);
  });

  it("언어 통계 조회 후 트리 409가 나도 빈 저장소의 빈 트리로 처리한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({ message: "Git Repository is empty." }, { status: 409 })
      );

    const result = await fetchRepositoryContributionData(AUTH, []);

    expect(result.tree).toEqual([]);
    expect(result.treeTruncated).toBe(false);
  });

  it("상세 조회한 커밋이 있는데 트리가 404면 빈 저장소로 보지 않고 실패로 전달한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rawDetail()))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ TypeScript: 10 }))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { status: 404 }));

    const error: GitHubFetchError = await fetchRepositoryContributionData(AUTH, COMMITS).catch(
      (caught) => caught
    );

    expect(error.kind).toBe("partial_failure");
    expect((error.cause as GitHubFetchError).kind).toBe("repo_not_found");
    expect(error.partialCommits).toHaveLength(1);
  });

  it("언어 통계 조회에서 404가 나면 존재하지 않는 Repository로 구분한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRepositoryContributionData(AUTH, [])).rejects.toMatchObject({
      kind: "repo_not_found",
    });
  });
});
