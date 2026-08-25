import type { CommitFileChange } from "@/lib/github/types";
import type { WorkUnit } from "./work-unit";
import type { SummarizableCommit, WorkUnitSummary } from "./work-unit-summary";

/**
 * 묶음이 설명할 가치가 있는지 가늠하는 신호입니다.
 *
 * 이 점수가 무엇인지 정확히 적어 둡니다. 실측에서 발화율이 높은 신호는
 * `many_commits`, `many_files`, `long_span` 세 가지이고 전부 규모 지표입니다. 따라서 이
 * 점수는 대체로 규모 점수입니다. 일곱 가지 경험 유형을 탐지한다고 설명하면 과장입니다.
 *
 * `revert_or_hotfix`는 `demian`과 `andbread` 모두 0퍼센트, `infrastructure_added`는
 * 3퍼센트 이하로 사실상 발화하지 않았습니다. 두 저장소에 장애 대응과 인프라 구축 이력이 없기
 * 때문이며 규칙이 틀려서가 아닙니다. 다른 저장소에서 발화할 수 있으므로 남겨 둡니다.
 */
export type WorkUnitSignal =
  | "dependency_added"
  | "infrastructure_added"
  | "file_rewritten_repeatedly"
  | "revert_or_hotfix"
  | "large_refactor"
  | "performance_or_refactor_prefix"
  | "many_commits"
  | "long_span"
  | "many_files";

/** 묶음을 접을지 판단하는 화면과 정렬이 같은 값을 쓰도록 사유를 함께 남깁니다. */
export interface WorkUnitScore {
  readonly pullRequestNumber: number;
  /** 발화한 신호 수입니다. 신호마다 가중치를 두지 않습니다. */
  readonly score: number;
  /** `WorkUnitSignal` 선언 순서로 정렬해 반환합니다. */
  readonly signals: readonly WorkUnitSignal[];
}

/**
 * 신호를 사용자에게 보여 줄 문구입니다. 점수만 표시하면 왜 위로 올라왔는지 알 수 없습니다.
 * 신호가 늘면 `Record`가 누락을 컴파일 오류로 잡습니다.
 */
export const WORK_UNIT_SIGNAL_COPY: Record<WorkUnitSignal, string> = {
  dependency_added: "의존성을 새로 추가했습니다",
  infrastructure_added: "배포나 인프라 설정을 새로 만들었습니다",
  file_rewritten_repeatedly: "같은 파일을 여러 번 크게 고쳤습니다",
  revert_or_hotfix: "되돌리기나 긴급 수정이 있습니다",
  large_refactor: "지운 코드가 많습니다",
  performance_or_refactor_prefix: "성능 개선이나 구조 개선 커밋이 있습니다",
  many_commits: "커밋이 많습니다",
  long_span: "여러 날에 걸쳐 작업했습니다",
  many_files: "고친 파일이 많습니다",
};

export const MANY_COMMITS_THRESHOLD = 5;
export const LONG_SPAN_DAYS_THRESHOLD = 3;
export const MANY_FILES_THRESHOLD = 10;
/** 이 값을 넘는 변경이 같은 파일에 반복되면 시행착오로 봅니다. */
export const REPEATED_REWRITE_MIN_CHANGES = 20;
export const REPEATED_REWRITE_MIN_COUNT = 3;
export const LARGE_REFACTOR_MIN_DELETIONS = 200;
/** 삭제가 추가의 절반을 넘으면 새로 쓰기보다 걷어내는 작업으로 봅니다. */
export const LARGE_REFACTOR_MIN_DELETION_RATIO = 0.5;
/** 버전 한 줄만 바뀐 경우를 의존성 도입으로 세지 않기 위한 하한입니다. */
export const DEPENDENCY_MIN_ADDITIONS = 2;

const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pubspec\.yaml|build\.gradle(\.kts)?)$/;
const INFRASTRUCTURE_PATH =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|Dockerfile|docker-compose\.[^/]+$|Jenkinsfile$|eas\.json$|vercel\.json$|netlify\.toml$|fly\.toml$|Procfile$|supabase\/config\.toml$)/;
const REVERT_OR_HOTFIX = /revert|hotfix|긴급/i;
const PERFORMANCE_OR_REFACTOR_PREFIX = /^(perf|refactor)[(:]/i;

/** 점수 계산에 필요한 최소 필드입니다. `ReadonlyCommitDetail`이 이 계약을 만족합니다. */
export interface ScorableCommit extends SummarizableCommit {
  readonly message: string;
  readonly files: readonly Pick<
    CommitFileChange,
    "path" | "status" | "additions" | "changes"
  >[];
}

function hasDependencyManifest(commits: readonly ScorableCommit[]): boolean {
  return commits.some((commit) =>
    commit.files.some(
      (file) =>
        DEPENDENCY_MANIFEST.test(file.path) && file.additions > DEPENDENCY_MIN_ADDITIONS
    )
  );
}

function hasInfrastructureAdded(commits: readonly ScorableCommit[]): boolean {
  return commits.some((commit) =>
    commit.files.some((file) => file.status === "added" && INFRASTRUCTURE_PATH.test(file.path))
  );
}

/**
 * 같은 파일을 크게 여러 번 고쳤는지 봅니다. 작은 수정이 반복된 경우는 세지 않습니다. 오타를
 * 세 번 고친 것과 구현을 세 번 뒤집은 것을 구분해야 하기 때문입니다.
 */
function hasRepeatedRewrite(commits: readonly ScorableCommit[]): boolean {
  const rewriteCounts = new Map<string, number>();
  for (const commit of commits) {
    for (const file of commit.files) {
      if (file.changes <= REPEATED_REWRITE_MIN_CHANGES) continue;
      const next = (rewriteCounts.get(file.path) ?? 0) + 1;
      if (next >= REPEATED_REWRITE_MIN_COUNT) return true;
      rewriteCounts.set(file.path, next);
    }
  }
  return false;
}

function isLargeRefactor(summary: WorkUnitSummary): boolean {
  return (
    summary.deletions > LARGE_REFACTOR_MIN_DELETIONS &&
    summary.deletions / Math.max(summary.additions, 1) > LARGE_REFACTOR_MIN_DELETION_RATIO
  );
}

/**
 * 묶음 하나를 채점합니다. LLM과 네트워크를 쓰지 않는 순수 함수입니다.
 *
 * 요약을 인자로 받습니다. 안에서 다시 계산하면 화면이 보는 커밋 수와 점수가 보는 커밋 수가
 * 어긋날 수 있습니다.
 */
export function scoreWorkUnit(
  unit: WorkUnit<ScorableCommit>,
  summary: WorkUnitSummary
): WorkUnitScore {
  const fired: WorkUnitSignal[] = [];
  if (hasDependencyManifest(unit.commits)) fired.push("dependency_added");
  if (hasInfrastructureAdded(unit.commits)) fired.push("infrastructure_added");
  if (hasRepeatedRewrite(unit.commits)) fired.push("file_rewritten_repeatedly");
  if (unit.commits.some(({ message }) => REVERT_OR_HOTFIX.test(message))) {
    fired.push("revert_or_hotfix");
  }
  if (isLargeRefactor(summary)) fired.push("large_refactor");
  if (unit.commits.some(({ title }) => PERFORMANCE_OR_REFACTOR_PREFIX.test(title))) {
    fired.push("performance_or_refactor_prefix");
  }
  if (summary.commitCount >= MANY_COMMITS_THRESHOLD) fired.push("many_commits");
  if (summary.spanDays >= LONG_SPAN_DAYS_THRESHOLD) fired.push("long_span");
  if (summary.changedFilePathCount >= MANY_FILES_THRESHOLD) fired.push("many_files");

  return { pullRequestNumber: unit.pullRequestNumber, score: fired.length, signals: fired };
}

/**
 * 점수 내림차순으로 정렬합니다. 점수가 같으면 입력 순서를 유지합니다.
 *
 * 입력 배열을 바꾸지 않습니다. 호출자가 넘긴 묶음 순서를 다른 곳에서도 쓰기 때문입니다.
 */
export function sortByScoreDescending<TItem>(
  items: readonly TItem[],
  scoreOf: (item: TItem) => number
): TItem[] {
  return [...items].sort((left, right) => scoreOf(right) - scoreOf(left));
}
