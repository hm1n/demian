import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * 심볼릭 링크로 추적하는 경로가 일반 파일로 커밋되는 것을 막습니다.
 *
 * 이 저장소는 지침 파일과 스킬 디렉터리를 저장소 밖 원본을 가리키는 심볼릭 링크로 추적합니다.
 * Windows 워크트리는 그 링크를 **일반 파일로 실체화**해 두는 경우가 있고, 그 상태에서 부모
 * 디렉터리를 `git add`하면 mode가 조용히 120000에서 100644으로 바뀝니다. blob은 그대로라
 * `git diff`가 내용 변화를 보여주지 않아 눈으로 알아채기 어렵습니다.
 *
 * 실제로 `llm-wiki/CLAUDE.md`가 그렇게 세 번 뒤집혔습니다. 커밋 `76d29bb`에서 처음 바뀌었고,
 * 복원하려고 `git commit <경로>`를 쓰자 pathspec이 워크트리를 다시 읽어 되돌아갔고, 그 뒤
 * `git add llm-wiki`가 다시 뒤집었습니다. 손으로 고치는 것만으로는 재발을 막지 못합니다.
 *
 * Linux와 CI 체크아웃에서 이 파일은 심볼릭 링크가 아니라 쓸 수 없는 절대 경로가 적힌 텍스트
 * 파일이 됩니다. 그러면 그 디렉터리에 걸어 둔 지침이 로드되지 않습니다.
 */
const SYMLINK_PATHS = [
  "CLAUDE.md",
  "llm-wiki/CLAUDE.md",
  ".claude/skills/feature-issue",
  ".claude/skills/gh-commit",
  ".claude/skills/ponytail",
  ".claude/skills/pull-request",
] as const;

function committedMode(path: string): string {
  // 워크트리 상태가 아니라 커밋된 mode를 봅니다. 워크트리는 OS에 따라 다르지만 커밋된 값은
  // 모든 체크아웃이 같이 받습니다.
  const line = execFileSync("git", ["ls-files", "-s", "--", path], { encoding: "utf8" }).trim();
  expect(line, `${path}가 추적되지 않습니다`).not.toBe("");
  return line.split(/\s+/)[0];
}

describe("심볼릭 링크로 추적하는 경로", () => {
  it.each(SYMLINK_PATHS)("%s는 mode 120000으로 커밋된다", (path) => {
    expect(committedMode(path)).toBe("120000");
  });
});
