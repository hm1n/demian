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

describe("selectWorkUnitsForStageA", () => {
  it("점수가 높은 묶음부터 고르고 나머지는 사유와 함께 남긴다", () => {
    const units = [scoredUnit(1, 0), scoredUnit(2, 2), scoredUnit(3, 1)];
    const selection = selectWorkUnitsForStageA(units, 400);

    expect(selection.selected.map(({ unit: item }) => item.pullRequestNumber)).toEqual([2]);
    expect(selection.excluded.map(({ unit: item }) => item.pullRequestNumber)).toEqual([3, 1]);
    expect(selection.excluded.every(({ reason }) => reason === "below_score_threshold")).toBe(true);
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
    const one = selectWorkUnitsForStageA(units, 1);
    const selection = selectWorkUnitsForStageA(units, one.bytes * 2 + 1);

    expect(selection.selected).toHaveLength(2);
    expect(selection.excluded).toHaveLength(1);
    expect(selection.excluded[0].reason).toBe("over_byte_budget");
  });

  it("예산이 아무리 작아도 최소 한 묶음은 남긴다", () => {
    const selection = selectWorkUnitsForStageA([scoredUnit(1, 2), scoredUnit(2, 0)], 1);

    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0].unit.pullRequestNumber).toBe(1);
    expect(selection.excluded).toHaveLength(1);
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
});
