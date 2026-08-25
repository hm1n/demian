import { describe, expect, it } from "vitest";
import {
  WORK_UNIT_EXCLUSION_COPY,
  groupCommitsIntoWorkUnits,
  type GroupableCommit,
  type WorkUnitPullRequest,
} from "./work-unit";

function pullRequest(number: number, title = `PR ${number}`): WorkUnitPullRequest {
  return { number, title, state: "closed", baseBranch: "develop", headBranch: `feature/${number}` };
}

function commit(sha: string, numbers: readonly number[], title = `${sha} 제목`): GroupableCommit {
  return { sha, title, pullRequests: numbers.map((number) => pullRequest(number)) };
}

describe("groupCommitsIntoWorkUnits", () => {
  it("빈 입력에 빈 묶음과 빈 제외 목록을 반환한다", () => {
    expect(groupCommitsIntoWorkUnits([])).toEqual({ units: [], excludedCommits: [] });
  });

  it("같은 Pull Request 커밋을 한 묶음으로 모은다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("a", [7]),
      commit("b", [7]),
      commit("c", [7]),
    ]);

    expect(result.units).toHaveLength(1);
    expect(result.units[0].pullRequestNumber).toBe(7);
    expect(result.units[0].commits.map(({ sha }) => sha)).toEqual(["a", "b", "c"]);
  });

  it("커밋이 입력에서 떨어져 있어도 같은 Pull Request면 한 묶음으로 모은다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("a", [7]),
      commit("b", [9]),
      commit("c", [7]),
    ]);

    expect(result.units).toHaveLength(2);
    expect(result.units[0].commits.map(({ sha }) => sha)).toEqual(["a", "c"]);
    expect(result.units[1].commits.map(({ sha }) => sha)).toEqual(["b"]);
  });

  it("묶음을 Pull Request 번호가 처음 나타난 순서로 반환한다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("a", [30]),
      commit("b", [4]),
      commit("c", [12]),
    ]);

    expect(result.units.map(({ pullRequestNumber }) => pullRequestNumber)).toEqual([30, 4, 12]);
  });

  it("묶음 안에서 입력 순서를 유지한다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("c", [1]),
      commit("a", [1]),
      commit("b", [1]),
    ]);

    expect(result.units[0].commits.map(({ sha }) => sha)).toEqual(["c", "a", "b"]);
  });

  it("커밋이 여러 Pull Request에 속하면 가장 작은 번호로 묶는다", () => {
    const result = groupCommitsIntoWorkUnits([commit("a", [42, 7, 19])]);

    expect(result.units).toHaveLength(1);
    expect(result.units[0].pullRequestNumber).toBe(7);
  });

  it("릴리스 Pull Request 번호가 함께 붙어도 기능 Pull Request로 나눈다", () => {
    // 기능 PR을 develop에 병합한 뒤 develop을 main으로 병합하면 모든 커밋에 릴리스 PR 번호가
    // 함께 붙습니다. 번호를 공유한다고 합치면 저장소 전체가 한 묶음이 됩니다.
    const result = groupCommitsIntoWorkUnits([
      commit("a", [10, 99]),
      commit("b", [10, 99]),
      commit("c", [20, 99]),
    ]);

    expect(result.units.map(({ pullRequestNumber }) => pullRequestNumber)).toEqual([10, 20]);
    expect(result.units[0].commits.map(({ sha }) => sha)).toEqual(["a", "b"]);
    expect(result.units[1].commits.map(({ sha }) => sha)).toEqual(["c"]);
  });

  it("가장 작은 번호의 Pull Request 메타데이터를 대표로 남긴다", () => {
    const result = groupCommitsIntoWorkUnits([
      { sha: "a", title: "제목", pullRequests: [pullRequest(9, "릴리스"), pullRequest(3, "기능")] },
    ]);

    expect(result.units[0].pullRequest).toEqual({
      number: 3,
      title: "기능",
      state: "closed",
      baseBranch: "develop",
      headBranch: "feature/3",
    });
  });

  it("Pull Request에 속하지 않은 커밋을 제외하고 사유를 남긴다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("a", [5]),
      commit("b", [], "직접 푸시한 커밋"),
    ]);

    expect(result.units).toHaveLength(1);
    expect(result.excludedCommits).toEqual([
      { sha: "b", title: "직접 푸시한 커밋", reason: "no_pull_request" },
    ]);
  });

  it("모든 커밋이 Pull Request에 속하지 않으면 묶음이 비고 전부 제외된다", () => {
    const result = groupCommitsIntoWorkUnits([commit("a", []), commit("b", [])]);

    expect(result.units).toEqual([]);
    expect(result.excludedCommits.map(({ sha }) => sha)).toEqual(["a", "b"]);
  });

  it("제외 목록이 입력 순서를 유지한다", () => {
    const result = groupCommitsIntoWorkUnits([
      commit("a", []),
      commit("b", [1]),
      commit("c", []),
    ]);

    expect(result.excludedCommits.map(({ sha }) => sha)).toEqual(["a", "c"]);
  });

  it("입력 배열을 변경하지 않는다", () => {
    const commits = [commit("a", [1]), commit("b", [])];
    const snapshot = structuredClone(commits);

    groupCommitsIntoWorkUnits(commits);

    expect(commits).toEqual(snapshot);
  });

  it("상세 조회 결과의 추가 필드를 묶음 안에서 유지한다", () => {
    const detailed = { ...commit("a", [1]), additions: 10, files: [{ path: "src/index.ts" }] };

    const result = groupCommitsIntoWorkUnits([detailed]);

    expect(result.units[0].commits[0].additions).toBe(10);
    expect(result.units[0].commits[0].files).toEqual([{ path: "src/index.ts" }]);
  });
});

describe("WORK_UNIT_EXCLUSION_COPY", () => {
  it("모든 제외 사유에 사용자 문구가 있다", () => {
    expect(WORK_UNIT_EXCLUSION_COPY.no_pull_request).not.toBe("");
  });
});
