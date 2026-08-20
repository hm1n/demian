import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllCommits } from "./commits";
import { GitHubFetchError } from "./errors";

const AUTH = { owner: "octocat", repo: "hello-world", token: "test-token" };
const COMMITS_URL = "https://api.github.com/repos/octocat/hello-world/commits";

function rawCommit(i: number) {
  return {
    sha: `sha-${i}`,
    commit: {
      message: `commit message ${i}\n\nbody`,
      author: { name: `author-${i}`, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` },
    },
    author: { login: `login-${i}` },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllCommits", () => {
  it("커밋 수 상한 없이 여러 페이지를 끝까지 조회한다", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawCommit(i));
    const page2 = Array.from({ length: 100 }, (_, i) => rawCommit(100 + i));
    const page3 = Array.from({ length: 50 }, (_, i) => rawCommit(200 + i));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
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
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("커밋이 하나도 없으면 빈 배열을 반환한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse([]));

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
  });

  it("커밋이 없는 Repository가 409를 반환해도 빈 배열을 반환한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse({ message: "Git Repository is empty." }, { status: 409 })
      );

    const commits = await fetchAllCommits(AUTH);
    expect(commits).toEqual([]);
  });

  it("429 응답도 rate_limit 오류로 분류한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Too Many Requests" }, { status: 429 }));

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("2차(secondary) rate limit도 rate_limit 오류로 분류한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "You have exceeded a secondary rate limit" },
          { status: 403, headers: { "x-ratelimit-remaining": "42", "retry-after": "60" } }
        )
      );

    await expect(fetchAllCommits(AUTH)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("API 호출 한도를 초과하면 rate_limit 오류를 던진다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
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

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, { status: 401 }));

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

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ default_branch: "main" }))
      .mockResolvedValueOnce(
        jsonResponse(page1, { headers: { link: `<${COMMITS_URL}?page=2>; rel="next"` } })
      )
      .mockRejectedValueOnce(new Error("network down"));

    const error: GitHubFetchError = await fetchAllCommits(AUTH).catch((e) => e);

    expect(error).toBeInstanceOf(GitHubFetchError);
    expect(error.kind).toBe("partial_failure");
    expect(error.partialCommits).toHaveLength(100);
  });
});
