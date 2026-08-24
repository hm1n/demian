import {
  CandidateRequestError,
  fetchStageACandidatesFromApi,
  fetchStageBCandidatesFromApi,
  type CandidateStage,
} from "@/features/experience-candidates/candidate-client";
import type {
  StageACandidateOutput,
  StageBCandidateResult,
} from "@/features/experience-candidates/types";
import { buildCandidateData } from "@/lib/github/candidate-data";
import { filterCommitsForDetail } from "@/lib/github/commit-blacklist";
import type { AuthoredCommitsResult } from "@/lib/github/commits";
import { GitHubFetchError, type GitHubFetchErrorKind } from "@/lib/github/errors";
import { fetchAuthoredCommitsFromApi, fetchContributionsFromApi } from "@/lib/github/route-client";
import type {
  CandidateDataOutput,
  CommitSummary,
  ContributionFetchProgress,
  RepositoryRef,
  RepositoryContributionData,
} from "@/lib/github/types";

export type LoadingPhase =
  | { step: "commits" }
  | {
      step: "details";
      completed: number;
      total: number;
      phase: ContributionFetchProgress["phase"];
    }
  | { step: "deriving" }
  | { step: "stage_a" }
  // 서버가 diff·PR 수집(5단계)과 판단(6단계)을 한 요청으로 처리해 클라이언트는 경계를 관측할 수 없습니다.
  // 시간 같은 대리 지표로 가짜 전환을 만들지 않고 두 단계를 하나의 Loading으로 표현합니다.
  | { step: "stage_b" };

export type EmptyKind =
  | "no_commits"
  | "no_author_commits"
  | "no_analyzable_commits"
  | "no_stage_a_candidates";
export type RecoveryAction = "retry" | "reauthenticate" | "select_repository";

/** 이슈 #18이 구분하는 후보 생성 오류 4종과 요청 크기 초과입니다. */
export type CandidateGenerationErrorKind =
  | "llm_call_failure"
  | "llm_schema_violation"
  | "llm_hallucination_rejected"
  | "diff_refetch_failure"
  | "request_too_large";

export interface AnalysisError {
  kind: GitHubFetchErrorKind | CandidateGenerationErrorKind;
  causeKind?: Exclude<GitHubFetchErrorKind, "partial_failure">;
  title: string;
  message: string;
  recovery: RecoveryAction;
  completed?: number;
  total?: number;
}

/** 실패한 후보 생성 단계부터 다시 시작할 때 필요한 입력입니다. stageA가 있으면 Stage B부터 재시도합니다. */
export interface CandidateRetryPoint {
  readonly repository: RepositoryRef;
  readonly contributionItems: readonly string[];
  readonly data: CandidateDataOutput;
  readonly stageA?: StageACandidateOutput;
}

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading"; loading: LoadingPhase }
  | { status: "empty"; kind: EmptyKind }
  | { status: "empty"; kind: "no_final_candidates"; reason: string }
  | { status: "error"; error: AnalysisError; retryPoint?: CandidateRetryPoint }
  | { status: "success"; data: CandidateDataOutput; candidates: StageBCandidateResult };

interface AnalysisDependencies {
  fetchCommits(repository: RepositoryRef): Promise<AuthoredCommitsResult>;
  filterCommits(commits: readonly CommitSummary[]): CommitSummary[];
  fetchContributions(
    repository: RepositoryRef,
    commits: readonly CommitSummary[],
    onProgress: (progress: ContributionFetchProgress) => void
  ): Promise<RepositoryContributionData>;
  buildData: typeof buildCandidateData;
  yieldToBrowser(): Promise<void>;
  fetchStageACandidates: typeof fetchStageACandidatesFromApi;
  fetchStageBCandidates: typeof fetchStageBCandidatesFromApi;
}

const defaultDependencies: AnalysisDependencies = {
  fetchCommits: fetchAuthoredCommitsFromApi,
  filterCommits: filterCommitsForDetail,
  fetchContributions: fetchContributionsFromApi,
  buildData: buildCandidateData,
  yieldToBrowser: () => new Promise((resolve) => setTimeout(resolve, 0)),
  fetchStageACandidates: fetchStageACandidatesFromApi,
  fetchStageBCandidates: fetchStageBCandidatesFromApi,
};

interface FailureContext {
  step: "commits" | "details";
  total?: number;
}

function underlyingKind(error: GitHubFetchError): AnalysisError["causeKind"] {
  let cause: unknown = error.cause;
  while (cause instanceof GitHubFetchError) {
    if (cause.kind !== "partial_failure") return cause.kind;
    cause = cause.cause;
  }
  return undefined;
}

function errorCopy(kind: Exclude<GitHubFetchErrorKind, "partial_failure">) {
  switch (kind) {
    case "rate_limit":
      return {
        title: "GitHub API 호출 한도에 도달했습니다",
        message: "호출 한도가 회복된 뒤 전체 조회를 다시 시도해 주세요.",
        recovery: "retry" as const,
      };
    case "auth_revoked":
      return {
        title: "GitHub 인증을 다시 확인해 주세요",
        message: "인증이 만료되었거나 접근 권한이 취소되었습니다. 인증을 다시 진행한 뒤 조회를 재개할 수 있습니다.",
        recovery: "reauthenticate" as const,
      };
    case "repo_not_found":
      return {
        title: "Repository를 찾을 수 없습니다",
        message: "Repository가 삭제되었거나 이름이 변경되었는지, 현재 인증으로 접근할 수 있는지 확인해 주세요.",
        recovery: "select_repository" as const,
      };
    case "network":
      return {
        title: "GitHub에 연결하지 못했습니다",
        message: "네트워크 연결을 확인한 뒤 전체 조회를 다시 시도해 주세요.",
        recovery: "retry" as const,
      };
    case "server_error":
      return {
        title: "GitHub 데이터를 불러오지 못했습니다",
        message: "GitHub 서버 문제일 수 있습니다. 잠시 후 전체 조회를 다시 시도해 주세요.",
        recovery: "retry" as const,
      };
  }
}

export function toAnalysisError(error: unknown, context: FailureContext): AnalysisError {
  if (!(error instanceof GitHubFetchError)) {
    return { kind: "server_error", ...errorCopy("server_error") };
  }

  if (error.kind !== "partial_failure") {
    return { kind: error.kind, ...errorCopy(error.kind) };
  }

  const completed = error.partialCommits?.length ?? 0;
  const causeKind = underlyingKind(error);
  const range =
    context.step === "details" && context.total !== undefined
      ? `상세 조회 대상 ${context.total}개 중 ${completed}개를 수집한 뒤 실패했습니다.`
      : `전체 커밋 중 ${completed}개를 수집한 뒤 실패했습니다.`;
  const causeGuidance = causeKind ? ` 원래 실패 원인: ${errorCopy(causeKind).title}.` : "";

  return {
    kind: "partial_failure",
    ...(causeKind === undefined ? {} : { causeKind }),
    title: "일부 Repository 데이터만 수집했습니다",
    message: `${range}${causeGuidance} 중복이나 누락을 피하기 위해 부분 결과는 이어 쓰지 않습니다. 복구를 마치면 처음부터 다시 조회합니다.`,
    recovery: causeKind ? errorCopy(causeKind).recovery : "retry",
    completed,
    ...(context.total === undefined ? {} : { total: context.total }),
  };
}

export async function analyzeRepository(
  repository: RepositoryRef,
  contributionItems: readonly string[],
  onStateChange: (state: AnalysisState) => void,
  dependencies: AnalysisDependencies = defaultDependencies
): Promise<void> {
  let failureContext: FailureContext = { step: "commits" };
  onStateChange({ status: "loading", loading: { step: "commits" } });

  try {
    const { commits: allCommits, repositoryHasCommits } = await dependencies.fetchCommits(repository);
    if (allCommits.length === 0) {
      onStateChange({
        status: "empty",
        kind: repositoryHasCommits ? "no_author_commits" : "no_commits",
      });
      return;
    }

    const includedCommits = dependencies.filterCommits(allCommits);
    if (includedCommits.length === 0) {
      onStateChange({ status: "empty", kind: "no_analyzable_commits" });
      return;
    }

    failureContext = { step: "details", total: includedCommits.length };
    const contributionData = await dependencies.fetchContributions(
      repository,
      includedCommits,
      (progress) => {
        onStateChange({
          status: "loading",
          loading:
            progress.phase === "commit_details"
              ? {
                  step: "details",
                  completed: progress.completed,
                  total: progress.total,
                  phase: progress.phase,
                }
              : {
                  step: "details",
                  completed: includedCommits.length,
                  total: includedCommits.length,
                  phase: progress.phase,
                },
        });
      }
    );

    onStateChange({ status: "loading", loading: { step: "deriving" } });
    await dependencies.yieldToBrowser();
    const data = dependencies.buildData({ allCommits, contributionData });
    await generateCandidates({ repository, contributionItems, data }, onStateChange, dependencies);
  } catch (error) {
    onStateChange({ status: "error", error: toAnalysisError(error, failureContext) });
  }
}

/**
 * 4~6단계: Stage A 1차 선별, diff·PR 입력 수집, Stage B 최종 판단을 진행합니다.
 * retryPoint에 stageA가 있으면 4단계를 건너뛰고 Stage B부터 재시도합니다.
 */
export async function generateCandidates(
  retryPoint: CandidateRetryPoint,
  onStateChange: (state: AnalysisState) => void,
  dependencies: AnalysisDependencies = defaultDependencies
): Promise<void> {
  const { repository, contributionItems, data } = retryPoint;
  let stageA = retryPoint.stageA;
  try {
    if (!stageA) {
      onStateChange({ status: "loading", loading: { step: "stage_a" } });
      stageA = await dependencies.fetchStageACandidates(data.includedCommits, contributionItems);
    }
    if (stageA.candidates.length === 0) {
      onStateChange({ status: "empty", kind: "no_stage_a_candidates" });
      return;
    }
    onStateChange({ status: "loading", loading: { step: "stage_b" } });
    const candidates = await dependencies.fetchStageBCandidates(repository, stageA.candidates);
    if (candidates.candidates.length === 0) {
      onStateChange({
        status: "empty",
        kind: "no_final_candidates",
        // 출력 계약이 후보 3개 미만이면 부족 사유를 보장하므로 0개에서 사유는 항상 존재합니다.
        reason: candidates.insufficientCandidatesReason!,
      });
      return;
    }
    onStateChange({ status: "success", data, candidates });
  } catch (error) {
    onStateChange({
      status: "error",
      error: toCandidateGenerationError(error, stageA ? "stage_b" : "stage_a"),
      retryPoint: { repository, contributionItems, data, ...(stageA ? { stageA } : {}) },
    });
  }
}

const DIFF_REFETCH_GUIDANCE: Record<Exclude<GitHubFetchErrorKind, "partial_failure">, string> = {
  rate_limit: "GitHub API 호출 한도가 회복된 뒤 후보 생성을 다시 시도해 주세요.",
  auth_revoked: "인증이 만료되었거나 접근 권한이 취소되었습니다. 인증을 다시 진행해 주세요.",
  repo_not_found: "Repository가 삭제되었거나 이름이 변경되었는지 확인하고 다시 선택해 주세요.",
  network: "네트워크 연결을 확인한 뒤 후보 생성을 다시 시도해 주세요.",
  server_error: "GitHub 서버 문제일 수 있습니다. 잠시 후 후보 생성을 다시 시도해 주세요.",
};

export function toCandidateGenerationError(error: unknown, stage: CandidateStage): AnalysisError {
  const fallback: AnalysisError = {
    kind: "server_error",
    title: "경험 후보 생성에 실패했습니다",
    message: "예상하지 못한 오류가 발생했습니다. 후보 생성을 다시 시도해 주세요.",
    recovery: "retry",
  };
  if (!(error instanceof CandidateRequestError)) return fallback;

  switch (error.kind) {
    case "unauthorized":
      return { kind: "auth_revoked", ...errorCopy("auth_revoked") };
    case "auth_revoked":
    case "rate_limit":
    case "repo_not_found":
    case "network":
    case "server_error":
    case "partial_failure": {
      // GitHub 조회 오류가 Stage B에서 오면 diff·PR 재조회(5단계) 실패입니다.
      if (stage !== "stage_b") return fallback;
      const causeKind = error.kind === "partial_failure" ? "server_error" : error.kind;
      return {
        kind: "diff_refetch_failure",
        causeKind,
        title: "후보의 diff·PR 근거를 다시 조회하지 못했습니다",
        message: `최종 판단에 사용할 diff와 PR 정보를 GitHub에서 수집하는 단계에서 실패했습니다. ${DIFF_REFETCH_GUIDANCE[causeKind]}`,
        recovery: errorCopy(causeKind).recovery,
      };
    }
    case "schema_validation":
    case "json_parse":
      return {
        kind: "llm_schema_violation",
        title: "LLM 응답이 출력 계약을 지키지 않았습니다",
        message: `${error.message} 계약을 지키지 않은 결과는 사용하지 않습니다. 후보 생성을 다시 시도해 주세요.`,
        recovery: "retry",
      };
    case "unknown_sha":
    case "unrelated_sha":
    case "unknown_file_path":
      return {
        kind: "llm_hallucination_rejected",
        title: "실제 Repository 근거와 맞지 않는 판단을 거부했습니다",
        message: `${error.message} 입력에 없는 커밋이나 파일을 인용한 결과는 사용하지 않습니다. 후보 생성을 다시 시도해 주세요.`,
        recovery: "retry",
      };
    case "llm_timeout":
      // Stage B의 llm_timeout은 LLM 자체가 아니라 GitHub 조회를 포함한 라우트 전체 예산 소진을 뜻합니다.
      return stage === "stage_b"
        ? {
            kind: "llm_call_failure",
            title: "Stage B 실행 시간 예산을 초과했습니다",
            message:
              "diff·PR 수집과 최종 판단을 합친 전체 시간 예산을 초과했습니다. 잠시 후 후보 생성을 다시 시도해 주세요.",
            recovery: "retry",
          }
        : {
            kind: "llm_call_failure",
            title: "LLM 분석 시간이 초과되었습니다",
            message: "분석이 제한 시간 안에 끝나지 않았습니다. 잠시 후 후보 생성을 다시 시도해 주세요.",
            recovery: "retry",
          };
    case "llm_rate_limit":
      return {
        kind: "llm_call_failure",
        title: "LLM 호출 한도에 도달했습니다",
        message: "호출 한도가 회복된 뒤 후보 생성을 다시 시도해 주세요.",
        recovery: "retry",
      };
    case "llm_auth":
    case "llm_configuration":
      return {
        kind: "llm_call_failure",
        title: "LLM 연결 설정에 문제가 있습니다",
        message: "서비스의 LLM 인증 또는 설정 문제입니다. 잠시 후 후보 생성을 다시 시도해 주세요.",
        recovery: "retry",
      };
    case "llm_network":
    case "llm_request":
    case "llm_failure":
      return {
        kind: "llm_call_failure",
        title: "LLM 호출에 실패했습니다",
        message: `${error.message} 잠시 후 후보 생성을 다시 시도해 주세요.`,
        recovery: "retry",
      };
    case "body_too_large":
      return {
        kind: "request_too_large",
        title: "분석 데이터가 요청 한도를 초과했습니다",
        message:
          "수집한 커밋 근거가 한 번에 보낼 수 있는 크기를 초과했습니다. 커밋 수가 더 적은 Repository를 선택해 주세요.",
        recovery: "select_repository",
      };
    case "fetch_network":
      return {
        kind: "network",
        title: "후보 생성 서버에 연결하지 못했습니다",
        message: "네트워크 연결을 확인한 뒤 후보 생성을 다시 시도해 주세요.",
        recovery: "retry",
      };
    default:
      // invalid_response, invalid_json, invalid_request 등 사용자가 복구 방법을 고를 수 없는 오류입니다.
      return { ...fallback, message: `${error.message} 후보 생성을 다시 시도해 주세요.` };
  }
}
