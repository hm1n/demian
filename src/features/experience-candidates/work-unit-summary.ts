import type { CommitFileChange, CommitSummary } from "@/lib/github/types";
import type { GroupableCommit, WorkUnit } from "./work-unit";

/**
 * 요약에 남길 파일 경로 수입니다.
 *
 * 실측에서 묶음 하나의 서로 다른 파일 경로는 최대 56개였습니다. 전부 실으면 경로가 페이로드의
 * 대부분을 차지합니다. 커밋 단위 페이로드에서 파일 경로가 24.9퍼센트, 파일별 숫자가
 * 23.6퍼센트로 합쳐서 절반에 가까웠습니다. 변경량 상위 6개만 남기고 나머지는 개수로 접습니다.
 */
export const WORK_UNIT_SUMMARY_TOP_FILE_PATHS = 6;

const MILLISECONDS_PER_DAY = 86_400_000;

/** 요약에 필요한 최소 필드입니다. `ReadonlyCommitDetail`이 이 계약을 만족합니다. */
export interface SummarizableCommit extends GroupableCommit {
  readonly date: CommitSummary["date"];
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly Pick<CommitFileChange, "path" | "changes">[];
}

/**
 * 묶음 하나의 구조화 요약입니다. 화면 표시와 Stage A 입력이 같은 값을 쓰도록 텍스트와 분리해
 * 둡니다. 텍스트만 두면 화면이 숫자를 다시 계산하게 되고 두 곳이 어긋납니다.
 */
export interface WorkUnitSummary {
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly commitCount: number;
  /** 첫 커밋과 마지막 커밋 사이 일수입니다. 하루 안에 끝난 작업도 1로 둡니다. */
  readonly spanDays: number;
  readonly additions: number;
  readonly deletions: number;
  readonly commitTitles: readonly string[];
  /** 묶음 안에서 서로 다른 파일 경로 수입니다. */
  readonly changedFilePathCount: number;
  /** 변경량 상위 경로입니다. 최대 `WORK_UNIT_SUMMARY_TOP_FILE_PATHS`개입니다. */
  readonly topFilePaths: readonly string[];
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * 커밋 날짜가 비어 있거나 형식이 어긋나면 그 커밋을 기간 계산에서 뺍니다. 전부 어긋나면 1일로
 * 둡니다. GitHub 응답에서 `commit.author.date`가 없으면 빈 문자열이 들어오기 때문입니다
 * (`contributions.ts`의 `fetchCommitDetail`).
 */
function calculateSpanDays(commits: readonly SummarizableCommit[]): number {
  const timestamps = commits
    .map(({ date }) => parseTimestamp(date))
    .filter((timestamp): timestamp is number => timestamp !== null);
  if (timestamps.length === 0) return 1;
  const span = Math.max(...timestamps) - Math.min(...timestamps);
  return Math.max(1, Math.round(span / MILLISECONDS_PER_DAY));
}

/**
 * 변경량이 같으면 경로 오름차순으로 끊습니다. 정렬이 흔들리면 같은 입력이 매번 다른 페이로드를
 * 만들어 측정과 캐시가 어긋납니다.
 */
function selectTopFilePaths(totals: ReadonlyMap<string, number>): string[] {
  return [...totals.entries()]
    .sort(([leftPath, leftChanges], [rightPath, rightChanges]) =>
      leftChanges === rightChanges ? leftPath.localeCompare(rightPath) : rightChanges - leftChanges
    )
    .slice(0, WORK_UNIT_SUMMARY_TOP_FILE_PATHS)
    .map(([path]) => path);
}

/** 묶음 하나를 구조화 요약으로 접습니다. LLM과 네트워크를 쓰지 않는 순수 함수입니다. */
export function summarizeWorkUnit(unit: WorkUnit<SummarizableCommit>): WorkUnitSummary {
  const changesByPath = new Map<string, number>();
  for (const commit of unit.commits) {
    for (const file of commit.files) {
      changesByPath.set(file.path, (changesByPath.get(file.path) ?? 0) + file.changes);
    }
  }

  return {
    pullRequestNumber: unit.pullRequestNumber,
    pullRequestTitle: unit.pullRequest.title,
    commitCount: unit.commits.length,
    spanDays: calculateSpanDays(unit.commits),
    additions: unit.commits.reduce((sum, { additions }) => sum + additions, 0),
    deletions: unit.commits.reduce((sum, { deletions }) => sum + deletions, 0),
    commitTitles: unit.commits.map(({ title }) => title),
    changedFilePathCount: changesByPath.size,
    topFilePaths: selectTopFilePaths(changesByPath),
  };
}

/**
 * 같은 디렉터리의 파일을 `디렉터리/{파일,파일}`로 접습니다.
 *
 * 한 묶음의 파일은 대체로 같은 디렉터리에 몰려 있어 경로 앞부분이 그대로 반복됩니다. 접으면
 * 파일 경로 몫이 `demian` 5,131바이트에서 3,622바이트로, `andbread` 10,941바이트에서
 * 10,219바이트로 줄어듭니다. 정보를 버리지 않는 압축이라 판단 품질에 영향이 없습니다.
 *
 * 공백으로만 접으면 94바이트에서 454바이트를 더 아끼지만, 디렉터리와 파일 이름의 경계가
 * 공백 하나뿐이라 모호합니다. 중괄호를 쓰는 쪽을 택했습니다.
 *
 * 최상위 파일은 디렉터리가 없으므로 접지 않고 그대로 둡니다.
 */
function foldFilePaths(paths: readonly string[]): string {
  const basesByDirectory = new Map<string, string[]>();
  for (const path of paths) {
    const separator = path.lastIndexOf("/");
    const directory = separator < 0 ? "" : path.slice(0, separator + 1);
    const bases = basesByDirectory.get(directory);
    if (bases === undefined) basesByDirectory.set(directory, [path.slice(separator + 1)]);
    else bases.push(path.slice(separator + 1));
  }
  return [...basesByDirectory.entries()]
    .map(([directory, bases]) =>
      directory === "" ? bases.join(" ") : `${directory}{${bases.join(",")}}`
    )
    .join(" ");
}

/**
 * 요약을 Stage A 입력 문자열로 만듭니다.
 *
 * JSON이 아니라 줄 형식인 이유는 실측 때문입니다. 커밋 단위 JSON 페이로드에서 중괄호와 따옴표
 * 같은 구분자가 5.9퍼센트를 차지했고, 필드 이름이 묶음마다 반복됩니다. 줄 형식으로 바꾸면서
 * 묶음 단위로 접었을 때 `andbread` 319커밋 기준 페이로드가 188,334바이트에서 36,292바이트로
 * 줄었습니다. 근거는 `llm-wiki/wiki/2026-08-24-경험-판단단위-PR-묶음-전환-검토.md`에 있습니다.
 *
 * 커밋 제목에는 상한을 두지 않습니다. 8개로 자르면 `andbread` 기준 9.9퍼센트를 더 줄일 수
 * 있지만, 상한을 넘는 묶음 12개가 곧 점수 상위 묶음입니다. 가장 중요한 묶음만 잘라내는 셈이라
 * 택하지 않았습니다. 커밋이 최신순이라 앞에서 자르면 작업 후반이 아니라 초반이 사라지는 문제도
 * 있습니다.
 *
 * Pull Request 제목의 대괄호 라벨도 그대로 둡니다. `demian`은 19개 중 4종뿐이라 중복이지만
 * `andbread`는 64개 중 57종이어서 저장소마다 다른 정보를 담습니다.
 */
export function renderWorkUnitSummary(summary: WorkUnitSummary): string {
  const remaining = summary.changedFilePathCount - summary.topFilePaths.length;
  const paths = foldFilePaths(summary.topFilePaths) + (remaining > 0 ? ` +${remaining}` : "");
  return [
    `PR#${summary.pullRequestNumber} ${summary.pullRequestTitle} [${summary.commitCount}커밋 ${summary.spanDays}일 +${summary.additions}-${summary.deletions} ${summary.changedFilePathCount}파일]`,
    `  ${summary.commitTitles.join(" / ")}`,
    `  ${paths}`,
  ].join("\n");
}

/** 묶음 여러 개를 Stage A 한 청크의 입력 본문으로 만듭니다. 묶음 순서를 그대로 유지합니다. */
export function renderWorkUnitSummaries(
  units: readonly WorkUnit<SummarizableCommit>[]
): string {
  return units.map((unit) => renderWorkUnitSummary(summarizeWorkUnit(unit))).join("\n");
}
