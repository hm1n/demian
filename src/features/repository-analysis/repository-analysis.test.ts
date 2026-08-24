import { describe, expect, it, vi } from "vitest";
import { CandidateRequestError } from "@/features/experience-candidates/candidate-client";
import type { StageACandidateOutput, StageBCandidateResult } from "@/features/experience-candidates/types";
import { GitHubFetchError, RepositoryContributionFetchError } from "@/lib/github/errors";
import type { CommitSummary, RepositoryContributionData } from "@/lib/github/types";
import {
  analyzeRepository,
  generateCandidates,
  toAnalysisError,
  toCandidateGenerationError,
  type AnalysisState,
  type CandidateRetryPoint,
} from "./repository-analysis";

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

const STAGE_A_OUTPUT: StageACandidateOutput = {
  candidates: [{ sha: "sha-1", source: "automatic_recommendation", contributionItem: null }],
  unclassifiedShas: [],
};
const STAGE_B_RESULT: StageBCandidateResult = {
  candidates: [
    { sha: "sha-1", relatedShas: [], evidence: "분석 상태 머신을 구현했습니다.", citedFilePaths: [], source: "automatic_recommendation" },
  ],
  insufficientCandidatesReason: "후보로 판단할 수 있는 커밋이 1개뿐입니다.",
  diffs: [],
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetchCommits: vi.fn().mockResolvedValue({ commits: [COMMIT], repositoryHasCommits: true }),
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
    fetchStageACandidates: vi.fn().mockResolvedValue(STAGE_A_OUTPUT),
    fetchStageBCandidates: vi.fn().mockResolvedValue(STAGE_B_RESULT),
    ...overrides,
  };
}

const DATA = {
  allCommits: [COMMIT],
  includedCommits: CONTRIBUTIONS.commits,
  repository: { fileTree: [], treeTruncated: false, languages: CONTRIBUTIONS.languages },
};

describe("analyzeRepository", () => {
  it("1~6단계 Loading 상태를 순서대로 전달하고 성공으로 끝낸다", async () => {
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, [], (state) => states.push(state), dependencies());

    expect(states.map((state) => state.status === "loading" ? state.loading.step : state.status)).toEqual([
      "commits",
      "details",
      "details",
      "details",
      "deriving",
      "stage_a",
      "stage_b",
      "success",
    ]);
    expect(states[2]).toMatchObject({ status: "loading", loading: { completed: 1, total: 1 } });
    expect(states.at(-1)).toMatchObject({ status: "success", candidates: STAGE_B_RESULT });
  });

  it("기여 항목과 상세 조회 커밋을 Stage A 선별에 전달한다", async () => {
    const deps = dependencies();
    await analyzeRepository(AUTH, ["푸시 알림 구현"], vi.fn(), deps);
    expect(deps.fetchStageACandidates).toHaveBeenCalledWith(CONTRIBUTIONS.commits, ["푸시 알림 구현"]);
    expect(deps.fetchStageBCandidates).toHaveBeenCalledWith(AUTH, STAGE_A_OUTPUT.candidates);
  });

  it("전체 커밋이 0개이면 상세 조회 없이 no_commits로 끝낸다", async () => {
    const deps = dependencies({ fetchCommits: vi.fn().mockResolvedValue({ commits: [], repositoryHasCommits: false }) });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, [], (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_commits" });
    expect(deps.fetchContributions).not.toHaveBeenCalled();
  });

  it("저장소에는 커밋이 있지만 본인 커밋이 0개이면 no_author_commits로 끝낸다", async () => {
    const deps = dependencies({
      fetchCommits: vi.fn().mockResolvedValue({ commits: [], repositoryHasCommits: true }),
    });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, [], (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_author_commits" });
    expect(deps.fetchContributions).not.toHaveBeenCalled();
  });

  it("필터 통과 커밋이 0개이면 대체 분석 없이 no_analyzable_commits로 끝낸다", async () => {
    const deps = dependencies({ filterCommits: vi.fn().mockReturnValue([]) });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, [], (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_analyzable_commits" });
    expect(deps.fetchContributions).not.toHaveBeenCalled();
  });

  it("커밋이 1개라도 분석 가능하면 별도 경계값 없이 상세 조회한다", async () => {
    const deps = dependencies();
    await analyzeRepository(AUTH, [], vi.fn(), deps);
    expect(deps.fetchContributions).toHaveBeenCalledWith(AUTH, [COMMIT], expect.any(Function));
  });

  it("상세 조회 오류에 대상 개수를 보존한다", async () => {
    const deps = dependencies({
      fetchContributions: vi.fn().mockRejectedValue(new GitHubFetchError("network", "offline")),
    });
    const states: AnalysisState[] = [];
    await analyzeRepository(AUTH, [], (state) => states.push(state), deps);
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

describe("generateCandidates", () => {
  const retryPoint: CandidateRetryPoint = { repository: AUTH, contributionItems: [], data: DATA };

  it("Stage A 후보가 0개이면 Stage B 호출 없이 no_stage_a_candidates로 끝낸다", async () => {
    const deps = dependencies({
      fetchStageACandidates: vi.fn().mockResolvedValue({ candidates: [], unclassifiedShas: ["sha-1"] }),
    });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({ status: "empty", kind: "no_stage_a_candidates" });
    expect(deps.fetchStageBCandidates).not.toHaveBeenCalled();
  });

  it("최종 후보가 0개이면 서버가 보낸 부족 사유와 함께 no_final_candidates로 끝낸다", async () => {
    const deps = dependencies({
      fetchStageBCandidates: vi.fn().mockResolvedValue({
        candidates: [],
        insufficientCandidatesReason: "실제 diff 근거로 설명할 수 있는 커밋이 없습니다.",
        diffs: [],
      }),
    });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    expect(states.at(-1)).toEqual({
      status: "empty",
      kind: "no_final_candidates",
      reason: "실제 diff 근거로 설명할 수 있는 커밋이 없습니다.",
    });
  });

  it("후보가 3개 미만이면 기준을 완화하지 않고 부족 사유를 성공 상태에 보존한다", async () => {
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), dependencies());

    const last = states.at(-1);
    expect(last).toMatchObject({ status: "success" });
    if (last?.status !== "success") throw new Error("unreachable");
    expect(last.candidates.candidates).toHaveLength(1);
    expect(last.candidates.insufficientCandidatesReason).toBe("후보로 판단할 수 있는 커밋이 1개뿐입니다.");
  });

  it("후보가 3개이면 부족 사유 없이 성공 상태로 끝낸다", async () => {
    const candidate = { relatedShas: [], evidence: "근거입니다.", citedFilePaths: [], source: "automatic_recommendation" } as const;
    const deps = dependencies({
      fetchStageBCandidates: vi.fn().mockResolvedValue({
        candidates: [
          { ...candidate, sha: "sha-1" },
          { ...candidate, sha: "sha-2" },
          { ...candidate, sha: "sha-3" },
        ],
        insufficientCandidatesReason: null,
        diffs: [],
      }),
    });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    const last = states.at(-1);
    if (last?.status !== "success") throw new Error("unreachable");
    expect(last.candidates.candidates).toHaveLength(3);
    expect(last.candidates.insufficientCandidatesReason).toBeNull();
  });

  it.each([
    ["stage_a", "fetchStageACandidates"],
    ["stage_b", "fetchStageBCandidates"],
  ] as const)("%s의 invalid_request에는 같은 페이로드 재전송을 막기 위해 retryPoint를 남기지 않는다", async (stage, dependency) => {
    const deps = dependencies({
      [dependency]: vi.fn().mockRejectedValue(
        new CandidateRequestError(stage, "invalid_request", "입력 형식이 올바르지 않습니다.")
      ),
    });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    const last = states.at(-1);
    if (last?.status !== "error") throw new Error("unreachable");
    expect(last.retryPoint).toBeUndefined();
    expect(last.error).toMatchObject({ kind: "server_error", recovery: "retry" });
    expect(last.error.title).toContain("서버 계약과 맞지 않았습니다");
  });

  it("Stage A 실패는 Stage A부터 재시도할 수 있는 retryPoint를 남긴다", async () => {
    const deps = dependencies({
      fetchStageACandidates: vi.fn().mockRejectedValue(new CandidateRequestError("stage_a", "llm_failure", "실패")),
    });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    const last = states.at(-1);
    expect(last).toMatchObject({ status: "error", error: { kind: "llm_call_failure", recovery: "retry" } });
    if (last?.status !== "error") throw new Error("unreachable");
    expect(last.retryPoint).toEqual(retryPoint);
    expect(last.retryPoint?.stageA).toBeUndefined();
  });

  it("Stage B 실패의 retryPoint로 재시도하면 Stage A를 건너뛰고 Stage B부터 다시 실행한다", async () => {
    const failingStageB = vi.fn().mockRejectedValue(new CandidateRequestError("stage_b", "llm_timeout", "예산 초과"));
    const deps = dependencies({ fetchStageBCandidates: failingStageB });
    const states: AnalysisState[] = [];
    await generateCandidates(retryPoint, (state) => states.push(state), deps);

    const failed = states.at(-1);
    if (failed?.status !== "error") throw new Error("unreachable");
    expect(failed.retryPoint?.stageA).toEqual(STAGE_A_OUTPUT);

    const retryDeps = dependencies();
    const retryStates: AnalysisState[] = [];
    await generateCandidates(failed.retryPoint!, (state) => retryStates.push(state), retryDeps);

    expect(retryDeps.fetchStageACandidates).not.toHaveBeenCalled();
    expect(retryDeps.fetchStageBCandidates).toHaveBeenCalledWith(AUTH, STAGE_A_OUTPUT.candidates);
    expect(retryStates.map((state) => state.status === "loading" ? state.loading.step : state.status)).toEqual([
      "stage_b",
      "success",
    ]);
  });
});

describe("toCandidateGenerationError", () => {
  it.each([
    ["llm_network", "llm_call_failure", "retry"],
    ["llm_request", "llm_call_failure", "retry"],
    ["llm_failure", "llm_call_failure", "retry"],
    ["llm_rate_limit", "llm_call_failure", "retry"],
    ["llm_auth", "llm_call_failure", "retry"],
    ["llm_configuration", "llm_call_failure", "retry"],
    ["schema_validation", "llm_schema_violation", "retry"],
    ["json_parse", "llm_schema_violation", "retry"],
    ["unknown_sha", "llm_hallucination_rejected", "retry"],
    ["unrelated_sha", "llm_hallucination_rejected", "retry"],
    ["unknown_file_path", "llm_hallucination_rejected", "retry"],
    ["body_too_large", "request_too_large", "select_repository"],
    ["fetch_network", "network", "retry"],
  ] as const)("%s를 %s 오류와 %s 복구로 변환한다", (serverKind, kind, recovery) => {
    const error = new CandidateRequestError("stage_a", serverKind, "서버 메시지입니다.");
    expect(toCandidateGenerationError(error, "stage_a")).toMatchObject({ kind, recovery });
  });

  it.each([
    ["rate_limit", "retry"],
    ["auth_revoked", "reauthenticate"],
    ["repo_not_found", "select_repository"],
    ["network", "retry"],
    ["server_error", "retry"],
  ] as const)("Stage B의 GitHub %s 오류를 diff 재조회 실패와 %s 복구로 구분한다", (causeKind, recovery) => {
    const error = new CandidateRequestError("stage_b", causeKind, "GitHub 실패");
    expect(toCandidateGenerationError(error, "stage_b")).toMatchObject({
      kind: "diff_refetch_failure",
      causeKind,
      recovery,
    });
  });

  it("세션 만료(unauthorized)는 기존 인증 재진행 안내로 복구한다", () => {
    const error = new CandidateRequestError("stage_a", "unauthorized", "세션 없음");
    expect(toCandidateGenerationError(error, "stage_a")).toMatchObject({
      kind: "auth_revoked",
      recovery: "reauthenticate",
    });
  });

  it("Stage B llm_timeout은 라우트 전체 예산 소진으로, Stage A의 LLM 시간 초과와 구분해 안내한다", () => {
    const stageB = toCandidateGenerationError(
      new CandidateRequestError("stage_b", "llm_timeout", "예산 초과"),
      "stage_b"
    );
    const stageA = toCandidateGenerationError(
      new CandidateRequestError("stage_a", "llm_timeout", "시간 초과"),
      "stage_a"
    );
    expect(stageB.title).toContain("실행 시간 예산");
    expect(stageB.message).toContain("GitHub diff·PR 조회를 포함한");
    expect(stageA.title).toContain("LLM 분석 시간이 초과");
    expect(stageA.title).not.toContain("예산");
  });

  it("CandidateRequestError가 아닌 오류는 일반 실패와 재시도로 변환한다", () => {
    expect(toCandidateGenerationError(new Error("boom"), "stage_a")).toMatchObject({
      kind: "server_error",
      recovery: "retry",
    });
  });
});
