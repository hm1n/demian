import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllCommits } from "./commits";
import { GitHubFetchError } from "./errors";

const AUTH = { owner: "octocat", repo: "hello-world", token: "test-token" };
const COMMITS_URL = "https://api.github.com/repos/octocat/hello-world/commits";
const HEAD_SHA = "abc123headsha";

function rawCommit(i: number) {
  return {
    sha: `sha-${i}`,
    commit: {
      message: `commit message ${i}\n\nbody`,
      author: { name: `author-${i}`, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` },
    },
    author: { login: `login-${i}` },
    parents: [{ sha: `parent-${i}` }],
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function mockRepoAndBranch(fetchMock: ReturnType<typeof vi.fn>, headSha = HEAD_SHA) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
    .mockResolvedValueOnce(jsonResponse({ commit: { sha: headSha } }));
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllCommits", () => {
  it("커밋 수 상한 없이 여러 페이지를 끝까지 조회하고, 고정된 브랜치 head SHA로 페이지네이션한다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const page2 = Array.from({ length: 100 }, (_, i) => rawCommit(100 + i));
    const page3 = Array.from({ length: 50 }, (_, i) => rawCommit(200 + i));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockResolvedValueOnce(
        jsonResponse(page2, { headers: { link: `<${COMMITS_URL}?page=3>; rel="next"` } })
      )
      .mockResolvedValueOnce(jsonResponse(page3));

    const commits = await fetchAllCommits(AUTH);

    expect(commits).toHaveLength(250);
    expect(commits[0]).toEqual({
      sha: "sha-0",
      title: "commit message 0",
      author: "login-0",
      date: "2026-01-01",
      parentCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const firstPageUrl = fetchMock.mock.calls[2][0] as string;
    expect(firstPageUrl).toContain(`sha=${HEAD_SHA}`);
  });

  it("커밋이 하나도 없으면 빈 배열을 반환한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(jsonResponse([]));

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
  });

  it("재확인해도 기본 브랜치명이 그대로인데 404면 실제로 빈 저장소로 본다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Branch not found" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }));

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("조회 사이에 기본 브랜치가 바뀌어 404가 나면 저장소 정보를 다시 확인해 새 브랜치로 재시도한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Branch not found" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ default_branch: "trunk" }))
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: HEAD_SHA } }))
      .mockResolvedValueOnce(jsonResponse([]));

    const commits = await fetchAllCommits(AUTH);

    expect(commits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const branchLookupUrl = fetchMock.mock.calls[3][0] as string;
    expect(branchLookupUrl).toContain("/branches/trunk");
  });

  it("재시도한 새 브랜치명도 404면 재시도를 더 하지 않고 빈 배열로 본다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Branch not found" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ default_branch: "trunk" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Branch not found" }, { status: 404 }));

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("브랜치 head는 있지만 커밋 목록 조회가 409를 반환해도 빈 배열을 반환한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse({ message: "Git Repository is empty." }, { status: 409 })
    );

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
  });

  it("첫 페이지 이후 409를 받으면 partial_failure로 처리하고 빈 배열을 성공으로 반환하지 않는다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: "Git Repository is empty." }, { status: 409 })
      );

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((e) => e);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
    expect(error.cause).toMatchObject({ kind: "server_error" });
  });

  it("일부 페이지 수집 뒤 호출 한도를 초과하면 원래 rate_limit 분류를 보존한다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } }
        )
      );

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((caught) => caught);

    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
    expect(error.cause).toMatchObject({ kind: "rate_limit" });
  });

  it("429 응답도 rate_limit 오류로 분류한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse({ message: "Too Many Requests" }, { status: 429 })
    );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("Retry-After 헤더가 있는 2차(secondary) rate limit도 rate_limit 오류로 분류한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse(
        { message: "You have exceeded a secondary rate limit" },
        { status: 403, headers: { "x-ratelimit-remaining": "42", "retry-after": "60" } }
      )
    );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("Retry-After 헤더 없이 본문 메시지로만 알 수 있는 2차 rate limit도 rate_limit 오류로 분류한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse(
        { message: "You have exceeded a secondary rate limit. Please wait before retrying." },
        { status: 403, headers: { "x-ratelimit-remaining": "42" } }
      )
    );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("API 호출 한도를 초과하면 rate_limit 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } }
      )
    );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("인증 권한이 취소되면 auth_revoked 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(
      jsonResponse({ message: "Bad credentials" }, { status: 401 })
    );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "auth_revoked" });
  });

  it("Repository를 찾을 수 없으면 repo_not_found 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, { status: 404 }));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "repo_not_found" });
  });

  it("페이지 조회 도중 오류가 나면 이미 조회한 커밋과 함께 partial_failure를 던진다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockRejectedValueOnce(new Error("network down"));

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((e) => e);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
    expect(error.cause).toMatchObject({ kind: "network" });
  });

  it("Repository 정보 응답을 해석할 수 없으면 network 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "network" });
  });

  it("기본 브랜치 응답을 해석할 수 없으면 network 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "network" });
  });

  it("첫 페이지 응답 본문을 해석할 수 없으면 network 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "network" });
  });

  it("페이지 응답 본문을 해석할 수 없으면 이미 조회한 커밋과 함께 partial_failure를 던진다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((e) => e);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
    expect(error.cause).toMatchObject({ kind: "network" });
  });

  it("첫 페이지 커밋 형태가 잘못되면 타입이 있는 network 오류를 던진다", async () => {
    const malformed = { ...rawCommit(0), parents: undefined };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock).mockResolvedValueOnce(jsonResponse([malformed]));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "network" });
  });

  it("후속 페이지 커밋 형태가 잘못되면 이미 조회한 커밋과 함께 partial_failure를 던진다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const malformed = { ...rawCommit(100), commit: undefined };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mockRepoAndBranch(fetchMock)
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockResolvedValueOnce(jsonResponse([malformed]));

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((e) => e);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
  });
});
