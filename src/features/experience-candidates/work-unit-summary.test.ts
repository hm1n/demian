import { describe, expect, it } from "vitest";
import {
  WORK_UNIT_SUMMARY_TOP_FILE_PATHS,
  allocateCommitQuota,
  selectRepresentativeCommits,
  renderWorkUnitSummaries,
  renderWorkUnitSummary,
  summarizeWorkUnit,
  type SummarizableCommit,
} from "./work-unit-summary";
import type { WorkUnit } from "./work-unit";

function commit(overrides: Partial<SummarizableCommit> = {}): SummarizableCommit {
  return {
    sha: "sha",
    title: "feat: 기능 추가",
    pullRequests: [],
    date: "2026-08-20T00:00:00Z",
    additions: 10,
    deletions: 5,
    files: [{ path: "src/index.ts", changes: 15 }],
    ...overrides,
  };
}

function unit(
  commits: readonly SummarizableCommit[],
  number = 7,
  title = "알림 기능 구현"
): WorkUnit<SummarizableCommit> {
  return {
    pullRequestNumber: number,
    pullRequest: { number, title, state: "closed", baseBranch: "develop", headBranch: "feature" },
    commits,
  };
}

describe("summarizeWorkUnit", () => {
  it("커밋 수와 증감 라인 수를 합산한다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ additions: 10, deletions: 5 }),
        commit({ additions: 3, deletions: 20 }),
      ])
    );

    expect(summary.commitCount).toBe(2);
    expect(summary.additions).toBe(13);
    expect(summary.deletions).toBe(25);
  });

  it("서로 다른 파일 경로 수를 센다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ files: [{ path: "a.ts", changes: 1 }, { path: "b.ts", changes: 1 }] }),
        commit({ files: [{ path: "b.ts", changes: 1 }, { path: "c.ts", changes: 1 }] }),
      ])
    );

    expect(summary.changedFilePathCount).toBe(3);
  });

  it("변경량이 큰 순으로 파일 경로를 남긴다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({
          files: [
            { path: "small.ts", changes: 1 },
            { path: "big.ts", changes: 100 },
            { path: "medium.ts", changes: 50 },
          ],
        }),
      ])
    );

    expect(summary.topFilePaths).toEqual(["big.ts", "medium.ts", "small.ts"]);
  });

  it("여러 커밋에 걸친 같은 경로의 변경량을 합쳐서 순위를 매긴다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ files: [{ path: "spread.ts", changes: 30 }] }),
        commit({ files: [{ path: "spread.ts", changes: 30 }] }),
        commit({ files: [{ path: "once.ts", changes: 50 }] }),
      ])
    );

    expect(summary.topFilePaths).toEqual(["spread.ts", "once.ts"]);
  });

  it("변경량이 같으면 경로 오름차순으로 끊는다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({
          files: [
            { path: "b.ts", changes: 10 },
            { path: "a.ts", changes: 10 },
            { path: "c.ts", changes: 10 },
          ],
        }),
      ])
    );

    expect(summary.topFilePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("파일 경로를 상한 개수까지만 남긴다", () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `file-${String(index).padStart(2, "0")}.ts`,
      changes: 100 - index,
    }));

    const summary = summarizeWorkUnit(unit([commit({ files })]));

    expect(summary.topFilePaths).toHaveLength(WORK_UNIT_SUMMARY_TOP_FILE_PATHS);
    expect(summary.changedFilePathCount).toBe(20);
  });

  it("첫 커밋과 마지막 커밋 사이 일수를 센다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ date: "2026-08-20T00:00:00Z" }),
        commit({ date: "2026-08-23T00:00:00Z" }),
      ])
    );

    expect(summary.spanDays).toBe(3);
  });

  it("커밋 순서가 뒤집혀 있어도 같은 일수를 센다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ date: "2026-08-23T00:00:00Z" }),
        commit({ date: "2026-08-20T00:00:00Z" }),
      ])
    );

    expect(summary.spanDays).toBe(3);
  });

  it("하루 안에 끝난 작업도 1일로 둔다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ date: "2026-08-20T01:00:00Z" }),
        commit({ date: "2026-08-20T03:00:00Z" }),
      ])
    );

    expect(summary.spanDays).toBe(1);
  });

  it("날짜가 비어 있는 커밋을 기간 계산에서 뺀다", () => {
    const summary = summarizeWorkUnit(
      unit([
        commit({ date: "" }),
        commit({ date: "2026-08-20T00:00:00Z" }),
        commit({ date: "2026-08-22T00:00:00Z" }),
      ])
    );

    expect(summary.spanDays).toBe(2);
  });

  it("모든 날짜가 어긋나면 1일로 둔다", () => {
    const summary = summarizeWorkUnit(unit([commit({ date: "" }), commit({ date: "몰라" })]));

    expect(summary.spanDays).toBe(1);
  });

  it("커밋 제목을 입력 순서대로 남긴다", () => {
    const summary = summarizeWorkUnit(
      unit([commit({ title: "첫 번째" }), commit({ title: "두 번째" })])
    );

    expect(summary.commitTitles).toEqual(["첫 번째", "두 번째"]);
  });

  it("변경 파일이 없는 커밋만 있으면 경로가 비고 개수가 0이다", () => {
    const summary = summarizeWorkUnit(unit([commit({ files: [] })]));

    expect(summary.topFilePaths).toEqual([]);
    expect(summary.changedFilePathCount).toBe(0);
  });
});

describe("renderWorkUnitSummary", () => {
  it("머리글, 커밋 제목, 파일 경로를 세 줄로 만든다", () => {
    const text = renderWorkUnitSummary(
      summarizeWorkUnit(
        unit(
          [
            commit({
              title: "feat: 알림 저장",
              additions: 100,
              deletions: 20,
              date: "2026-08-20T00:00:00Z",
              files: [{ path: "src/a.ts", changes: 80 }],
            }),
            commit({
              title: "fix: 아이콘 경로",
              additions: 5,
              deletions: 3,
              date: "2026-08-22T00:00:00Z",
              files: [{ path: "src/b.ts", changes: 8 }],
            }),
          ],
          113,
          "PWA 알림 구현"
        )
      )
    );

    expect(text).toBe(
      [
        "PR#113 PWA 알림 구현 [2커밋 2일 +105-23 2파일]",
        "  feat: 알림 저장 / fix: 아이콘 경로",
        "  src/{a.ts,b.ts}",
      ].join("\n")
    );
  });

  it("같은 디렉터리의 파일을 한 번만 적는다", () => {
    const text = renderWorkUnitSummary(
      summarizeWorkUnit(
        unit([
          commit({
            files: [
              { path: "src/features/chat/list.tsx", changes: 30 },
              { path: "src/features/chat/item.tsx", changes: 20 },
              { path: "src/features/chat/list.module.css", changes: 10 },
            ],
          }),
        ])
      )
    );

    expect(text.split("\n")[2]).toBe(
      "  src/features/chat/{list.tsx,item.tsx,list.module.css}"
    );
  });

  it("디렉터리가 여러 개면 각각 접는다", () => {
    const text = renderWorkUnitSummary(
      summarizeWorkUnit(
        unit([
          commit({
            files: [
              { path: "src/a/one.ts", changes: 30 },
              { path: "src/b/two.ts", changes: 20 },
              { path: "src/a/three.ts", changes: 10 },
            ],
          }),
        ])
      )
    );

    expect(text.split("\n")[2]).toBe("  src/a/{one.ts,three.ts} src/b/{two.ts}");
  });

  it("최상위 파일은 접지 않고 그대로 둔다", () => {
    const text = renderWorkUnitSummary(
      summarizeWorkUnit(
        unit([
          commit({
            files: [
              { path: "eslint.config.mjs", changes: 30 },
              { path: "src/a/one.ts", changes: 20 },
              { path: "package.json", changes: 10 },
            ],
          }),
        ])
      )
    );

    expect(text.split("\n")[2]).toBe("  eslint.config.mjs package.json src/a/{one.ts}");
  });

  it("남은 파일 경로 수를 뒤에 접어서 붙인다", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `f${index}.ts`,
      changes: 100 - index,
    }));

    const text = renderWorkUnitSummary(summarizeWorkUnit(unit([commit({ files })])));

    expect(text).toContain("10파일]");
    expect(text.split("\n")[2]).toBe("  f0.ts f1.ts f2.ts f3.ts f4.ts f5.ts +4");
  });

  it("파일 경로가 상한 이하이면 접음 표시를 붙이지 않는다", () => {
    const text = renderWorkUnitSummary(
      summarizeWorkUnit(unit([commit({ files: [{ path: "only.ts", changes: 1 }] })]))
    );

    expect(text.split("\n")[2]).toBe("  only.ts");
  });
});

describe("renderWorkUnitSummaries", () => {
  it("묶음 순서를 유지하며 줄바꿈으로 잇는다", () => {
    const text = renderWorkUnitSummaries([
      unit([commit({ title: "첫 묶음" })], 30, "A"),
      unit([commit({ title: "두 묶음" })], 4, "B"),
    ]);

    expect(text.split("\n")).toHaveLength(6);
    expect(text.startsWith("PR#30 A ")).toBe(true);
    expect(text).toContain("\nPR#4 B ");
  });

  it("묶음이 없으면 빈 문자열을 만든다", () => {
    expect(renderWorkUnitSummaries([])).toBe("");
  });
});

describe("allocateCommitQuota", () => {
  it("빈 입력에 빈 배분을 반환한다", () => {
    expect(allocateCommitQuota([], 30)).toEqual([]);
  });

  it("합이 상한 이하면 전부 준다", () => {
    expect(allocateCommitQuota([9, 5, 5, 5], 30)).toEqual([9, 5, 5, 5]);
  });

  it("묶음마다 대표 커밋 하나는 보장한다", () => {
    const quota = allocateCommitQuota([21, 18, 18, 10, 9, 8, 7, 7, 6, 6, 4, 4], 30);

    expect(quota.every((value) => value >= 1)).toBe(true);
  });

  it("상한을 넘지 않는다", () => {
    const sizes = [21, 18, 18, 10, 9, 8, 7, 7, 6, 6, 4, 4];

    const quota = allocateCommitQuota(sizes, 30);

    expect(quota.reduce((sum, value) => sum + value, 0)).toBe(30);
  });

  it("묶음 크기에 비례해 남은 몫을 나눈다", () => {
    const quota = allocateCommitQuota([20, 2], 12);

    expect(quota[0]).toBeGreaterThan(quota[1]);
    expect(quota.reduce((sum, value) => sum + value, 0)).toBe(12);
  });

  it("어떤 묶음에도 커밋 수보다 많이 주지 않는다", () => {
    const sizes = [1, 1, 20];

    const quota = allocateCommitQuota(sizes, 30);

    expect(quota).toEqual([1, 1, 20]);
  });

  it("묶음 수가 상한 이상이면 앞에서부터 하나씩만 준다", () => {
    const quota = allocateCommitQuota(Array.from({ length: 5 }, () => 10), 3);

    expect(quota).toEqual([1, 1, 1, 0, 0]);
  });

  it("같은 입력에 같은 배분을 반환한다", () => {
    const sizes = [7, 7, 7, 7];

    expect(allocateCommitQuota(sizes, 10)).toEqual(allocateCommitQuota(sizes, 10));
  });
});

describe("selectRepresentativeCommits", () => {
  function scored(sha: string, changes: number): SummarizableCommit {
    return {
      sha,
      title: sha,
      pullRequests: [],
      date: "2026-08-20T00:00:00Z",
      additions: 0,
      deletions: 0,
      files: [{ path: `${sha}.ts`, changes }],
    };
  }

  it("변경량이 큰 순으로 고른다", () => {
    const target = unit([scored("a", 10), scored("b", 100), scored("c", 50)]);

    expect(selectRepresentativeCommits(target, 2).map(({ sha }) => sha)).toEqual(["b", "c"]);
  });

  it("변경량이 같으면 SHA 오름차순으로 끊는다", () => {
    const target = unit([scored("c", 10), scored("a", 10), scored("b", 10)]);

    expect(selectRepresentativeCommits(target, 3).map(({ sha }) => sha)).toEqual(["a", "b", "c"]);
  });

  it("요청 수가 커밋 수보다 많으면 있는 만큼만 준다", () => {
    const target = unit([scored("a", 10)]);

    expect(selectRepresentativeCommits(target, 5)).toHaveLength(1);
  });

  it("0을 요청하면 빈 배열을 준다", () => {
    expect(selectRepresentativeCommits(unit([scored("a", 10)]), 0)).toEqual([]);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const commits = [scored("a", 10), scored("b", 100)];
    const target = unit(commits);

    selectRepresentativeCommits(target, 2);

    expect(commits.map(({ sha }) => sha)).toEqual(["a", "b"]);
  });
});
