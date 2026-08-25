import type { PullRequestReference } from "@/lib/github/types";

/**
 * 작업 단위를 대표하는 Pull Request입니다. `url`을 뺀 이유는 Stage A 입력에 링크가 필요하지
 * 않고, 화면 표시는 `ReadonlyCommitDetail`의 원본 `pullRequests`를 그대로 쓰기 때문입니다.
 */
export type WorkUnitPullRequest = Pick<
  PullRequestReference,
  "number" | "title" | "state" | "baseBranch" | "headBranch"
>;

/** 묶기에 필요한 최소 필드입니다. 이 계약만 만족하면 상세 조회 결과가 아니어도 묶을 수 있습니다. */
export interface GroupableCommit {
  readonly sha: string;
  readonly title: string;
  readonly pullRequests: readonly WorkUnitPullRequest[];
}

/**
 * 경험 판단의 단위입니다. Stage A는 커밋이 아니라 이 단위를 판단합니다.
 *
 * 커밋 단위 판단이 성립하지 않는 이유는 실측으로 확인했습니다. 어떤 Pull Request는 커밋 18개
 * 중 8개가 파일명 대소문자 변경이어서 개별 커밋은 전부 잡무로 보이지만, 묶으면 배포 실패를
 * 하루 만에 해결한 경험이 됩니다. 근거는
 * `llm-wiki/wiki/2026-08-24-경험-판단단위-PR-묶음-전환-검토.md`에 있습니다.
 */
export interface WorkUnit<TCommit extends GroupableCommit = GroupableCommit> {
  readonly pullRequestNumber: number;
  readonly pullRequest: WorkUnitPullRequest;
  /** 입력 순서를 유지합니다. 최소 1개입니다. */
  readonly commits: readonly TCommit[];
}

/**
 * 판단 대상에서 빠진 이유입니다. 지금은 한 가지뿐이지만 union 타입으로 둡니다. 나중에 사유가
 * 늘어날 때 `Record`로 강제되는 문구 대응을 빠뜨리지 않기 위해서입니다.
 */
export type WorkUnitExclusionReason = "no_pull_request";

export interface ExcludedCommit {
  readonly sha: string;
  readonly title: string;
  readonly reason: WorkUnitExclusionReason;
}

export interface WorkUnitGrouping<TCommit extends GroupableCommit = GroupableCommit> {
  readonly units: readonly WorkUnit<TCommit>[];
  /** 조용히 버리지 않기 위해 남깁니다. 화면이 건수와 사유를 표시합니다. */
  readonly excludedCommits: readonly ExcludedCommit[];
}

/** 제외 사유를 사용자에게 보여 줄 문구입니다. 사유가 늘면 `Record`가 누락을 컴파일 오류로 잡습니다. */
export const WORK_UNIT_EXCLUSION_COPY: Record<WorkUnitExclusionReason, string> = {
  no_pull_request:
    "Pull Request에 속하지 않아 어떤 작업의 일부인지 복원할 수 없습니다. 커밋 하나만으로는 설명할 경험을 판단하기 어려워 대상에서 제외했습니다.",
};

/**
 * 커밋이 여러 Pull Request에 속할 때 가장 작은 번호를 고릅니다.
 *
 * 번호를 공유하는 Pull Request를 전부 하나로 합치는 방식(union-find)은 쓰지 않습니다. 기능
 * Pull Request를 develop에 병합한 뒤 develop을 main으로 병합하는 저장소에서는 모든 커밋에
 * 릴리스 Pull Request 번호가 함께 붙습니다. 합치면 저장소 전체가 한 묶음이 됩니다. 파일 경로
 * 겹침으로 묶었을 때 319개 커밋 중 282개가 한 묶음이 된 것과 같은 붕괴입니다.
 *
 * 가장 작은 번호는 그 커밋을 처음 포함한 Pull Request입니다. 릴리스 Pull Request는 나중에
 * 생기므로 번호가 더 큽니다. 따라서 최소 번호를 고르면 기능 Pull Request가 선택됩니다.
 *
 * 확인 필요: `demian` 83커밋과 `andbread` 319커밋 모두 Pull Request가 2개 이상 붙은 커밋이
 * 0건이어서 이 규칙은 실데이터로 검증되지 않았습니다. 최소·최대·union-find 세 방식이 같은
 * 결과를 냅니다.
 */
function resolvePullRequest(commit: GroupableCommit): WorkUnitPullRequest | null {
  return commit.pullRequests.reduce<WorkUnitPullRequest | null>(
    (selected, pullRequest) =>
      selected === null || pullRequest.number < selected.number ? pullRequest : selected,
    null
  );
}

/**
 * 커밋을 Pull Request 단위 작업 묶음으로 바꿉니다. LLM과 네트워크를 쓰지 않는 순수 함수입니다.
 *
 * 묶음 순서는 각 Pull Request 번호가 입력에서 처음 나타난 순서입니다. 번호 순으로 정렬하지
 * 않는 이유는 호출자가 넘긴 커밋 순서(현재는 최신 순)를 묶음 수준에서도 유지하기 위해서입니다.
 * 점수 정렬은 별도 단계가 맡습니다.
 *
 * Pull Request에 속하지 않은 커밋은 대체 묶음 규칙을 적용하지 않고 제외합니다. 실측에서
 * `andbread`는 319개 전부가, `demian`은 83개 중 81개가 Pull Request에 묶여 있어 제외되는
 * 비중이 작습니다. 대체 규칙은 커밋 가중 순도가 최대 77퍼센트에 그쳤습니다.
 */
export function groupCommitsIntoWorkUnits<TCommit extends GroupableCommit>(
  commits: readonly TCommit[]
): WorkUnitGrouping<TCommit> {
  const unitsByNumber = new Map<number, { pullRequest: WorkUnitPullRequest; commits: TCommit[] }>();
  const order: number[] = [];
  const excludedCommits: ExcludedCommit[] = [];

  for (const commit of commits) {
    const pullRequest = resolvePullRequest(commit);
    if (pullRequest === null) {
      excludedCommits.push({ sha: commit.sha, title: commit.title, reason: "no_pull_request" });
      continue;
    }
    const existing = unitsByNumber.get(pullRequest.number);
    if (existing === undefined) {
      unitsByNumber.set(pullRequest.number, { pullRequest, commits: [commit] });
      order.push(pullRequest.number);
      continue;
    }
    existing.commits.push(commit);
  }

  return {
    units: order.map((number) => {
      const unit = unitsByNumber.get(number)!;
      return {
        pullRequestNumber: number,
        pullRequest: unit.pullRequest,
        commits: unit.commits,
      };
    }),
    excludedCommits,
  };
}
