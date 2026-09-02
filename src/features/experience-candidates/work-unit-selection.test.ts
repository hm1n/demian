import { describe, expect, it } from "vitest";
import {
  MANY_COMMITS_THRESHOLD,
  MANY_FILES_THRESHOLD,
  type ScorableCommit,
} from "./work-unit-score";
import {
  STAGE_A_MAX_SELECTION_BYTES,
  WORK_UNIT_SELECTION_EXCLUSION_COPY,
  selectWorkUnitsForStageA,
} from "./work-unit-selection";
import { STAGE_A_MAX_PROMPT_BYTES } from "./stage-a";
import { renderWorkUnitSummary, summarizeWorkUnit } from "./work-unit-summary";
import type { WorkUnit } from "./work-unit";

function commit(overrides: Partial<ScorableCommit> = {}): ScorableCommit {
  return {
    sha: "sha",
    title: "feat: 기능 추가",
    message: "feat: 기능 추가",
    pullRequests: [],
    date: "2026-08-20T00:00:00Z",
    additions: 10,
    deletions: 5,
    files: [{ path: "src/index.ts", status: "modified", additions: 10, changes: 15 }],
    ...overrides,
  };
}

function unit(number: number, commits: readonly ScorableCommit[]): WorkUnit<ScorableCommit> {
  return {
    pullRequestNumber: number,
    pullRequest: { number, title: `제목 ${number}`, state: "closed", baseBranch: "develop", headBranch: "f" },
    commits,
  };
}

/** 커밋 수와 파일 수로 점수를 올립니다. 신호 두 개가 붙으면 2점입니다. */
function scoredUnit(number: number, score: 0 | 1 | 2): WorkUnit<ScorableCommit> {
  const files = Array.from({ length: score >= 2 ? MANY_FILES_THRESHOLD + 1 : 1 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    status: "modified" as const,
    additions: 1,
    changes: 2,
  }));
  const count = score >= 1 ? MANY_COMMITS_THRESHOLD + 1 : 1;
  return unit(number, Array.from({ length: count }, (_, index) =>
    commit({ sha: `sha-${number}-${index}`, files })));
}

/** 묶음 하나를 선별기와 같은 방식으로 렌더링해 정확한 바이트 크기를 구합니다. */
function unitBytes(target: WorkUnit<ScorableCommit>): number {
  return Buffer.byteLength(renderWorkUnitSummary(summarizeWorkUnit(target)), "utf8");
}

describe("selectWorkUnitsForStageA", () => {
  it("점수가 높은 묶음부터 고르고 나머지는 사유와 함께 남긴다", () => {
    const units = [scoredUnit(1, 0), scoredUnit(2, 2), scoredUnit(3, 1)];
    const selection = selectWorkUnitsForStageA(units, 400);

    expect(selection.selected.map(({ unit: item }) => item.pullRequestNumber)).toEqual([2]);
    expect(selection.excluded.map(({ unit: item }) => item.pullRequestNumber)).toEqual([3, 1]);
    expect(selection.excluded.every(({ reason }) => reason === "over_input_budget")).toBe(true);
    expect(selection.thresholdScore).toBe(2);
  });

  it("어떤 묶음도 조용히 사라지지 않는다", () => {
    const units = [scoredUnit(1, 0), scoredUnit(2, 2), scoredUnit(3, 1), scoredUnit(4, 1)];
    const selection = selectWorkUnitsForStageA(units, 500);

    expect(selection.selected.length + selection.excluded.length).toBe(units.length);
    const seen = [...selection.selected, ...selection.excluded]
      .map(({ unit: item }) => item.pullRequestNumber)
      .sort();
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("같은 점수 무리는 예산에 다 들어갈 때만 넣는다", () => {
    // 1점 두 개가 함께 들어가지 못하면 둘 다 빠집니다. 상위 N으로 자르면 하나만 남습니다.
    const units = [scoredUnit(1, 2), scoredUnit(2, 1), scoredUnit(3, 1)];
    const full = selectWorkUnitsForStageA(units, STAGE_A_MAX_SELECTION_BYTES);
    const tight = selectWorkUnitsForStageA(units, full.bytes - 1);

    expect(full.selected).toHaveLength(3);
    expect(tight.selected.map(({ unit: item }) => item.pullRequestNumber)).toEqual([1]);
    expect(tight.excluded).toHaveLength(2);
  });

  it("가장 높은 점수 무리 하나가 예산을 넘으면 그 무리만 쪼갠다", () => {
    const units = [scoredUnit(1, 2), scoredUnit(2, 2), scoredUnit(3, 2)];
    const singleBytes = unitBytes(units[0]);
    const selection = selectWorkUnitsForStageA(units, singleBytes * 2 + 1);

    expect(selection.selected).toHaveLength(2);
    expect(selection.excluded).toHaveLength(1);
    // 이 묶음은 혼자서는 예산에 들어갑니다. 자리가 없어 밀린 것이므로 입력 상한 사유입니다.
    expect(selection.excluded[0].reason).toBe("over_input_budget");
  });

  /**
   * 두 상한이 어긋나면 선별 결과가 청크 둘로 갈리고, `candidate-client`의 청크 사이 대기가
   * 살아납니다. 그 61초는 Groq의 분당 토큰 창에서 나온 값이라 Gemini에서는 근거가 없고 사용자가
   * 이유 없이 1분을 기다립니다. 숫자를 두 파일에 적어 두었으므로 이 테스트가 어긋남을 잡습니다.
   */
  it("선별 예산이 청크 바이트 상한과 같다", () => {
    expect(STAGE_A_MAX_SELECTION_BYTES).toBe(STAGE_A_MAX_PROMPT_BYTES);
  });

  it("모든 묶음이 개별적으로 예산을 넘으면 억지로 남기지 않고 전부 제외한다", () => {
    // Codex 리뷰 P2-2 회귀 테스트입니다. 이전에는 selected가 비면 최고 점수 묶음을 무조건
    // 되살려 excluded에서 지웠고, 예산을 넘은 요청이 서버에 가서 422로 거부됐습니다.
    const units = [scoredUnit(1, 2), scoredUnit(2, 0)];
    const selection = selectWorkUnitsForStageA(units, 1);

    expect(selection.selected).toEqual([]);
    expect(selection.excluded).toHaveLength(2);
    expect(selection.excluded.every(({ reason }) => reason === "over_byte_budget")).toBe(true);
    // 되살리며 excluded에서 지우던 회귀가 있었으므로 둘 다 그대로 남아 있는지 확인합니다.
    expect(selection.excluded.map(({ unit: item }) => item.pullRequestNumber).sort()).toEqual([1, 2]);
    expect(selection.thresholdScore).toBe(0);
    expect(selection.bytes).toBe(0);
  });

  it("최고 점수 묶음이 예산을 넘고 다음 묶음은 넘지 않으면 다음 묶음을 선택한다", () => {
    const [highScore, lowScore] = [scoredUnit(1, 2), scoredUnit(2, 0)];
    // 낮은 점수 묶음 혼자는 들어가지만 높은 점수 묶음은 혼자서도 못 들어가는 예산을 고릅니다.
    const budget = unitBytes(lowScore);
    const selection = selectWorkUnitsForStageA([highScore, lowScore], budget);

    expect(selection.selected.map(({ unit: item }) => item.pullRequestNumber)).toEqual([2]);
    expect(selection.excluded.map(({ unit: item }) => item.pullRequestNumber)).toEqual([1]);
    expect(selection.excluded[0].reason).toBe("over_byte_budget");
  });

  it("빈 입력에서 빈 결과를 낸다", () => {
    const selection = selectWorkUnitsForStageA([], STAGE_A_MAX_SELECTION_BYTES);

    expect(selection.selected).toEqual([]);
    expect(selection.excluded).toEqual([]);
    expect(selection.bytes).toBe(0);
  });

  it("제외 사유마다 표시 문구가 있다", () => {
    expect(Object.values(WORK_UNIT_SELECTION_EXCLUSION_COPY).every((copy) => copy.length > 0)).toBe(true);
  });

  it("제외된 묶음은 발화한 신호를 함께 돌려준다", () => {
    // scoredUnit(3, 1)은 커밋 6개로만 1점을 얻어 many_commits 신호 하나만 발화시킵니다.
    const units = [scoredUnit(1, 0), scoredUnit(2, 2), scoredUnit(3, 1)];
    const selection = selectWorkUnitsForStageA(units, 400);

    const excludedThree = selection.excluded.find(({ unit: item }) => item.pullRequestNumber === 3);
    expect(excludedThree?.signals).toEqual(["many_commits"]);
  });
});
