import { buildCandidateData } from "@/lib/github/candidate-data";
import { filterCommitsForDetail } from "@/lib/github/commit-blacklist";
import { fetchAllCommits } from "@/lib/github/commits";
import { fetchRepositoryContributionData } from "@/lib/github/contributions";
import { GitHubFetchError, type GitHubFetchErrorKind } from "@/lib/github/errors";
import type {
  CandidateDataOutput,
  CommitSummary,
  ContributionFetchProgress,
  GitHubAuth,
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
  | { step: "deriving" };

export type EmptyKind = "no_commits" | "no_analyzable_commits";
export type RecoveryAction = "retry" | "reauthenticate" | "select_repository";

export interface AnalysisError {
  kind: GitHubFetchErrorKind;
  causeKind?: Exclude<GitHubFetchErrorKind, "partial_failure">;
  title: string;
  message: string;
  recovery: RecoveryAction;
  completed?: number;
  total?: number;
}

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading"; loading: LoadingPhase }
  | { status: "empty"; kind: EmptyKind }
  | { status: "error"; error: AnalysisError }
  | { status: "success"; data: CandidateDataOutput };

interface AnalysisDependencies {
  fetchCommits(auth: GitHubAuth): Promise<CommitSummary[]>;
  filterCommits(commits: readonly CommitSummary[]): CommitSummary[];
  fetchContributions(
    auth: GitHubAuth,
    commits: readonly CommitSummary[],
    onProgress: (progress: ContributionFetchProgress) => void
  ): Promise<RepositoryContributionData>;
  buildData: typeof buildCandidateData;
  yieldToBrowser(): Promise<void>;
}

const defaultDependencies: AnalysisDependencies = {
  fetchCommits: fetchAllCommits,
  filterCommits: filterCommitsForDetail,
  fetchContributions: fetchRepositoryContributionData,
  buildData: buildCandidateData,
  yieldToBrowser: () => new Promise((resolve) => setTimeout(resolve, 0)),
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
    message: `${range}${causeGuidance} 중복이나 누락을 피하기 위해 부분 결과는 이어 쓰지 않고 전체 조회를 다시 시도합니다.`,
    recovery: causeKind ? errorCopy(causeKind).recovery : "retry",
    completed,
    ...(context.total === undefined ? {} : { total: context.total }),
  };
}

export async function analyzeRepository(
  auth: GitHubAuth,
  onStateChange: (state: AnalysisState) => void,
  dependencies: AnalysisDependencies = defaultDependencies
): Promise<void> {
  let failureContext: FailureContext = { step: "commits" };
  onStateChange({ status: "loading", loading: { step: "commits" } });

  try {
    const allCommits = await dependencies.fetchCommits(auth);
    if (allCommits.length === 0) {
      onStateChange({ status: "empty", kind: "no_commits" });
      return;
    }

    const includedCommits = dependencies.filterCommits(allCommits);
    if (includedCommits.length === 0) {
      onStateChange({ status: "empty", kind: "no_analyzable_commits" });
      return;
    }

    failureContext = { step: "details", total: includedCommits.length };
    const contributionData = await dependencies.fetchContributions(
      auth,
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
    onStateChange({ status: "success", data });
  } catch (error) {
    onStateChange({ status: "error", error: toAnalysisError(error, failureContext) });
  }
}
