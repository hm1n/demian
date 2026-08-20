import type { CommitSummary } from "./types";

export type CommitBlacklistCategory =
  | "merge"
  | "documentation"
  | "dependency"
  | "typo"
  | "formatting";

type CommitBlacklistInput = Pick<CommitSummary, "title" | "parentCount" | "author">;

const CONVENTIONAL_PATTERN = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.*)$/i;
const DOCUMENTATION_PATTERN = /^(?:(?:add|update|refresh|write)\s+)?(?:docs|documentation|readme|changelog)(?:\s+(?:in|to|for|of)\s+.*)?$/i;
const DEPENDENCY_PATTERN = /^(?:(?:update|upgrade)\s+)?(?:deps|dependency|dependencies)(?:\s+(?:in|to|for|of)\s+.*)?$/i;
const TYPO_PATTERN = /^(?:(?:fix|correct)\s+)?(?:typo|misspell|spelling)(?:\s+(?:in|to|for|of)\s+.*)?$/i;
const FORMATTING_PATTERN = /^(?:(?:run|apply|use)\s+)?(?:format|lint|eslint|prettier)(?:\s+(?:in|to|for|of)\s+.*)?$/i;
const KOREAN_ACTION = "(?:수정|추가|변경|정리|적용|반영|갱신)";
const KOREAN_DOCUMENTATION_PATTERN = new RegExp(`^(?:문서화|(?:문서|리드미)\\s*${KOREAN_ACTION}?)$`);
const KOREAN_DEPENDENCY_PATTERN = new RegExp(`^버전업(?:\\s*${KOREAN_ACTION})?$`);
const KOREAN_TYPO_PATTERN = new RegExp(`^(?:오타|오탈자|맞춤법)(?:\\s*${KOREAN_ACTION})?$`);
const KOREAN_FORMATTING_PATTERN = new RegExp(`^(?:포맷|린트)(?:\\s*${KOREAN_ACTION})?$`);
const BOT_PATTERN = /\[bot\]$/i;
const BOT_BUMP_PATTERN = /^bump .+ from .+ to .+$/i;

/**
 * 첫 번째 커밋 목록 조회에서 얻는 제목과 부모 수만 사용한다.
 * 여러 규칙에 해당하면 정의된 우선순위에서 가장 먼저 일치한 카테고리를 반환한다.
 */
export function classifyBlacklistedCommit({
  title,
  parentCount,
  author,
}: CommitBlacklistInput): CommitBlacklistCategory | null {
  if (parentCount >= 2) return "merge";

  const conventional = title.match(CONVENTIONAL_PATTERN);
  if (conventional) {
    const [, type, scope, subject] = conventional;
    if (type.toLowerCase() === "docs") return "documentation";
    const dependencyScope = /^(?:deps|dependencies|deps-dev)$/i.test(scope ?? "");
    if (
      dependencyScope &&
      (/^(?:chore|build|ci)$/i.test(type) ||
        (type.toLowerCase() === "fix" && /^(?:update|bump)\b/i.test(subject)))
    ) {
      return "dependency";
    }
    if (
      type.toLowerCase() === "style" &&
      (FORMATTING_PATTERN.test(subject) || KOREAN_FORMATTING_PATTERN.test(subject))
    ) {
      return "formatting";
    }
    if (/^(?:fix|chore)$/i.test(type) && (TYPO_PATTERN.test(subject) || KOREAN_TYPO_PATTERN.test(subject))) {
      return "typo";
    }
    return null;
  }

  if (DOCUMENTATION_PATTERN.test(title) || KOREAN_DOCUMENTATION_PATTERN.test(title)) return "documentation";
  if (
    DEPENDENCY_PATTERN.test(title) ||
    KOREAN_DEPENDENCY_PATTERN.test(title) ||
    (BOT_PATTERN.test(author) && BOT_BUMP_PATTERN.test(title))
  ) {
    return "dependency";
  }
  if (TYPO_PATTERN.test(title) || KOREAN_TYPO_PATTERN.test(title)) return "typo";
  if (FORMATTING_PATTERN.test(title) || KOREAN_FORMATTING_PATTERN.test(title)) return "formatting";
  return null;
}

/** 두 번째 단계의 상세 조회에 전달할 커밋만 남긴다. */
export function filterCommitsForDetail(commits: readonly CommitSummary[]): CommitSummary[] {
  return commits.filter((commit) => classifyBlacklistedCommit(commit) === null);
}
