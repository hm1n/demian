import { describe, expect, it, vi } from "vitest";
import { GitHubFetchError, RepositoryContributionFetchError } from "@/lib/github/errors";
import type { CommitSummary, RepositoryContributionData } from "@/lib/github/types";
import { analyzeRepository, toAnalysisError, type AnalysisState } from "./repository-analysis";

const AUTH = { owner: "octocat", repo: "hello-world", token: "token" };
const COMMIT: CommitSummary = {
  sha: "sha-1",
  title: "feat: add analysis",
  author: "octocat",
  date: "2026-08-20T00:00:00Z",
  parentCount: 1,
};
const CONTRIBUTIONS: RepositoryContributionData = {
  commits: [{ ...COMMIT, message: COMMIT.title, additions: 10, deletions: 2, changedFiles: 1, files: [], pullRequests: [] }],
  tree: [],
  treeTruncated: false,
  languages: { TypeScript: 100 },
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetchCommits: vi.fn().mockResolvedValue([COMMIT]),
    filterCommits: vi.fn().mockReturnValue([COMMIT]),
    fetchContributions: vi.fn().mockImplementation(async (_auth, _commits, onProgress) => {
      onProgress({ phase: "commit_details", completed: 0, total: 1 });
      onProgress({ phase: "commit_details", completed: 1, total: 1 });
      onProgress({ phase: "repository_metadata" });
      return CONTRIBUTIONS;
    }),
    buildData: vi.fn().mockReturnValue({
      allCommits: [COMMIT],
      includedCommits: CONTRIBUTIONS.commits,
      repository: { fileTree: [], treeTruncated: false, languages: CONTRIBUTIONS.languages },
    }),
    yieldToBrowser: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("analyzeRepository", () => {
  it("전체 커밋 조회, 상세 조회 진행률, 파생 계산을 서로 다른 Loading 상태로 전달한다", async () => {
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, (state) => states.push(state), dependencies());

    expect(states.map((state) => state.status === "loading" ? state.loading.step : state.status)).toEqual([
      "commits",
      "details",
      "details",
      "details",
      "deriving",
      "success",
    ]);
    expect(states[2]).toMatchObject({ status: "loading", loading: { completed: 1, total: 1 } });
  });

  it("전체 커밋이 0개이면 상세 조회 없이 no_commits로 끝낸다", async () => {
    const deps = dependencies({ fetchCommits: vi.fn().mockResolvedValue([]) });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_commits" });
    expect(deps.fetchContributions).not.toHaveBeenCalled();
  });

  it("필터 통과 커밋이 0개이면 대체 분석 없이 no_analyzable_commits로 끝낸다", async () => {
    const deps = dependencies({ filterCommits: vi.fn().mockReturnValue([]) });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_analyzable_commits" });
    expect(deps.fetchContributions).not.toHaveBeenCalled();
  });

  it("커밋이 1개라도 분석 가능하면 별도 경계값 없이 상세 조회한다", async () => {
    const deps = dependencies();
    await analyzeRepository(AUTH, vi.fn(), deps);
    expect(deps.fetchContributions).toHaveBeenCalledWith(AUTH, [COMMIT], expect.any(Function));
  });

  it("상세 조회 오류에 대상 개수를 보존한다", async () => {
    const deps = dependencies({
      fetchContributions: vi.fn().mockRejectedValue(new GitHubFetchError("network", "offline")),
    });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, (state) => states.push(state), deps);
    expect(states.at(-1)).toMatchObject({ status: "error", error: { kind: "network" } });
  });
});

describe("toAnalysisError", () => {
  it.each([
    ["rate_limit", "GitHub API 호출 한도에 도달했습니다", "retry"],
    ["auth_revoked", "GitHub 인증을 다시 확인해 주세요", "reauthenticate"],
    ["repo_not_found", "Repository를 찾을 수 없습니다", "select_repository"],
    ["network", "GitHub에 연결하지 못했습니다", "retry"],
    ["server_error", "GitHub 데이터를 불러오지 못했습니다", "retry"],
  ] as const)("%s 오류를 고유 안내와 복구 동작으로 변환한다", (kind, title, recovery) => {
    expect(toAnalysisError(new GitHubFetchError(kind, "failed"), { step: "commits" })).toMatchObject({
      kind,
      title,
      recovery,
    });
  });

  it("partial_failure의 실패 범위와 중첩된 원래 오류를 표시한다", () => {
    const cause = new GitHubFetchError("rate_limit", "limited");
    const inner = new RepositoryContributionFetchError("partial_failure", "partial", [CONTRIBUTIONS.commits[0]], { cause });
    const error = new GitHubFetchError("partial_failure", "partial", [CONTRIBUTIONS.commits[0]], { cause: inner });

    expect(toAnalysisError(error, { step: "details", total: 3 })).toMatchObject({
      kind: "partial_failure",
      causeKind: "rate_limit",
      completed: 1,
      total: 3,
      recovery: "retry",
    });
    expect(toAnalysisError(error, { step: "details", total: 3 }).message).toContain("3개 중 1개");
  });

  it("인증 취소가 원인인 partial_failure는 인증 재진행으로 복구한다", () => {
    const cause = new GitHubFetchError("auth_revoked", "revoked");
    const error = new GitHubFetchError("partial_failure", "partial", [COMMIT], { cause });
    expect(toAnalysisError(error, { step: "commits" })).toMatchObject({
      kind: "partial_failure",
      causeKind: "auth_revoked",
      recovery: "reauthenticate",
    });
  });

  it("Repository 미존재가 원인인 partial_failure는 Repository 재선택으로 복구한다", () => {
    const cause = new GitHubFetchError("repo_not_found", "not found");
    const error = new GitHubFetchError("partial_failure", "partial", [COMMIT], { cause });
    const result = toAnalysisError(error, { step: "commits" });
    expect(result).toMatchObject({
      kind: "partial_failure",
      causeKind: "repo_not_found",
      recovery: "select_repository",
    });
    expect(result.message).not.toContain("전체 조회를 다시 시도합니다");
    expect(result.message).toContain("복구를 마치면 처음부터 다시 조회합니다");
  });
});
