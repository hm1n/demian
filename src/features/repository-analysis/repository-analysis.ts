import {
  CandidateRequestError,
  fetchStageACandidatesFromApi,
  fetchStageBCandidatesFromApi,
  toStageAUnits,
  type CandidateStage,
  type StageACandidateResult,
  type StageASelectionSummary,
} from "@/features/experience-candidates/candidate-client";
import type {
  StageACheckpoint,
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
  | { step: "stage_a"; completed: number; total: number; waitingForRateLimit: boolean }
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
  readonly stageA?: StageACandidateResult;
  readonly stageACheckpoint?: StageACheckpoint;
}

/**
 * 성공 상태가 화면에 실어 보내는 Stage A 선별 정보입니다. `unjudgedShas`는 `StageACandidateOutput`에
 * 이미 있지만 성공 경로에서는 그동안 어디에도 실리지 않았습니다. 화면이 "판단 불가" 건수를
 * 보여주려면(Task 9-2) 이 값이 성공 상태까지 와야 합니다.
 */
export interface StageASelectionState extends StageASelectionSummary {
  readonly unjudgedShas: readonly string[];
}

/**
 * Stage A 진행 단위는 커밋이 아니라 Pull Request 묶음입니다.
 *
 * `fetchStageACandidates`가 보내는 진행률과 체크포인트의 `processedShas`가 모두 묶음 기준입니다.
 * 커밋 수와 섞으면 커밋 여러 개짜리 PR이 있는 저장소에서 진행 바 전체 수가 첫 응답 직후 줄어들고,
 * 실패 문구가 실제보다 훨씬 많이 남은 것처럼 보고합니다.
 *
 * `toStageAUnits`는 네트워크를 쓰지 않는 순수 함수라 클라이언트가 쓰는 값을 여기서 다시 구할 수
 * 있습니다. 기여 항목이 선별 예산을 먹으므로 함께 넘겨야 같은 수가 나옵니다.
 */
function stageAUnitTotal(
  data: CandidateDataOutput,
  contributionItems: readonly string[]
): number {
  return toStageAUnits(data.includedCommits, contributionItems).units.length;
}

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading"; loading: LoadingPhase }
  // stageASelection은 선택 필드입니다. Stage A를 부르기 전에 나는 no_commits·no_author_commits·
  // no_analyzable_commits 세 갈래는 선별 정보가 존재하지 않아 값을 채우지 않습니다. no_stage_a_candidates는
  // Stage A 직후 갈래라 항상 값을 싣습니다(이슈 #58 Codex 리뷰 P1-2).
  | { status: "empty"; kind: EmptyKind; stageASelection?: StageASelectionState }
  | { status: "empty"; kind: "no_final_candidates"; reason: string; stageASelection?: StageASelectionState }
  | { status: "error"; error: AnalysisError; retryPoint?: CandidateRetryPoint }
  | {
      status: "success";
      data: CandidateDataOutput;
      candidates: StageBCandidateResult;
      stageASelection: StageASelectionState;
    };

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
  let stageACheckpoint = retryPoint.stageACheckpoint;
  try {
    if (!stageA) {
      onStateChange({ status: "loading", loading: {
        step: "stage_a", completed: stageACheckpoint?.processedShas.length ?? 0,
        total: stageAUnitTotal(data, contributionItems), waitingForRateLimit: false,
      } });
      stageA = await dependencies.fetchStageACandidates(
        data.includedCommits,
        contributionItems,
        (progress) => onStateChange({ status: "loading", loading: { step: "stage_a", ...progress } }),
        stageACheckpoint
      );
    }
    // 세 상태(빈 둘·성공)가 같은 선별 값을 싣도록 여기서 한 번만 만듭니다. 후보가 0개일 때가 제외
    // 사유를 가장 알아야 할 순간이라 두 빈 갈래에도 성공 경로와 동일한 객체를 실어 보냅니다(이슈 #58 P1-2).
    const stageASelection: StageASelectionState = {
      excludedCommits: stageA.excludedCommits,
      excludedUnits: stageA.excludedUnits,
      thresholdScore: stageA.thresholdScore,
      unjudgedShas: stageA.unjudgedShas,
    };
    if (stageA.candidates.length === 0) {
      onStateChange({ status: "empty", kind: "no_stage_a_candidates", stageASelection });
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
        stageASelection,
      });
      return;
    }
    onStateChange({
      status: "success",
      data,
      candidates,
      stageASelection,
    });
  } catch (error) {
    if (error instanceof CandidateRequestError && error.checkpoint) {
      stageACheckpoint = error.checkpoint;
    }
    // 계약 위반(422)은 보존한 입력을 그대로 다시 보내면 반드시 같은 결과라 retryPoint를 남기지 않습니다.
    // retryPoint가 없으면 재시도가 전체 재분석이 되어 입력을 처음부터 다시 구성합니다.
    const samePayloadAlwaysFails =
      error instanceof CandidateRequestError &&
      (error.kind === "invalid_request" || error.retryable === false);
    // 체크포인트의 `processedShas`는 묶음의 대표 커밋 SHA이므로 묶음 수와 견줍니다. 분모는
    // 체크포인트가 실어 온 `totalUnits`를 씁니다. 커밋 수로 다시 유도하면 단위가 섞이고, 유도
    // 시점의 입력이 판단 시점과 달라지면 두 숫자가 어긋납니다.
    const judgedUnits = stageACheckpoint?.processedShas.length ?? 0;
    const totalUnits = stageACheckpoint?.totalUnits ?? 0;
    const visibleError =
      error instanceof CandidateRequestError && !stageA && stageACheckpoint
        ? new CandidateRequestError(
            error.stage,
            error.kind,
            `${error.message} 전체 ${totalUnits}묶음 중 ${judgedUnits}묶음을 판단했고 ${totalUnits - judgedUnits}묶음은 아직 판단하지 못했습니다.`,
            { cause: error, checkpoint: stageACheckpoint }
          )
        : error;
    onStateChange({
      status: "error",
      error: toCandidateGenerationError(visibleError, stageA ? "stage_b" : "stage_a"),
      ...(samePayloadAlwaysFails
        ? {}
        : { retryPoint: {
            repository, contributionItems, data,
            ...(stageA ? { stageA } : {}),
            ...(!stageA && stageACheckpoint ? { stageACheckpoint } : {}),
          } }),
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
              "GitHub diff·PR 조회를 포함한 라우트 전체 시간 예산을 초과했습니다. LLM 자체의 실패가 아닐 수 있습니다. 잠시 후 후보 생성을 다시 시도해 주세요.",
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
    case "invalid_request":
      return {
        kind: "server_error",
        title: "후보 생성 요청이 서버 계약과 맞지 않았습니다",
        message: `${error.message} 같은 입력을 그대로 다시 보내지 않고 Repository 조회부터 다시 구성해 재시도합니다. 문제가 반복되면 사용자 조작으로 해결할 수 없는 결함일 수 있습니다.`,
        recovery: "retry",
      };
    default:
      // invalid_response, invalid_json 등 사용자가 복구 방법을 고를 수 없는 오류입니다.
      return { ...fallback, message: `${error.message} 후보 생성을 다시 시도해 주세요.` };
  }
}
