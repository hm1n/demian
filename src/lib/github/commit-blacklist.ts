import type { CommitSummary } from "./types";

export type CommitBlacklistCategory =
  | "merge"
  | "documentation"
  | "dependency"
  | "typo"
  | "formatting";

type CommitBlacklistInput = Pick<CommitSummary, "title" | "parentCount">;

const DOCUMENTATION_PATTERN = /\b(?:docs|documentation|readme|changelog)\b|(?<![가-힣])(?:문서|리드미)/i;
// bump는 "bump upload limit to 10 MB"처럼 일반 동사로도 쓰여서 단독으로는 오탐이 난다.
// Dependabot/Renovate가 남기는 "Bump X from A to B" 형태로만 의존성 신호로 인정한다.
const DEPENDENCY_PATTERN =
  /\b(?:deps|dependency|dependencies)\b|(?<![가-힣])버전업|^bump .+ from .+ to .+$/i;
const TYPO_PATTERN = /\b(?:typo|misspell|spelling)\b|(?<![가-힣])(?:오타|오탈자|맞춤법)/i;
const FORMATTING_PATTERN = /\b(?:format|lint|eslint|prettier)\b|(?<![가-힣])(?:포맷|린트)/i;

/**
 * 첫 번째 커밋 목록 조회에서 얻는 제목과 부모 수만 사용한다.
 * 여러 규칙에 해당하면 정의된 우선순위에서 가장 먼저 일치한 카테고리를 반환한다.
 */
export function classifyBlacklistedCommit({
  title,
  parentCount,
}: CommitBlacklistInput): CommitBlacklistCategory | null {
  if (parentCount >= 2) return "merge";
  if (DOCUMENTATION_PATTERN.test(title)) return "documentation";
  if (DEPENDENCY_PATTERN.test(title)) return "dependency";
  if (TYPO_PATTERN.test(title)) return "typo";
  if (FORMATTING_PATTERN.test(title)) return "formatting";
  return null;
}

/** 두 번째 단계의 상세 조회에 전달할 커밋만 남긴다. */
export function filterCommitsForDetail(commits: readonly CommitSummary[]): CommitSummary[] {
  return commits.filter((commit) => classifyBlacklistedCommit(commit) === null);
}
