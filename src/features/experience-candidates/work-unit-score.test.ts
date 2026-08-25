import { describe, expect, it } from "vitest";
import {
  LARGE_REFACTOR_MIN_DELETIONS,
  LONG_SPAN_DAYS_THRESHOLD,
  MANY_COMMITS_THRESHOLD,
  MANY_FILES_THRESHOLD,
  REPEATED_REWRITE_MIN_CHANGES,
  WORK_UNIT_SIGNAL_COPY,
  scoreWorkUnit,
  sortByScoreDescending,
  type ScorableCommit,
  type WorkUnitSignal,
} from "./work-unit-score";
import { summarizeWorkUnit } from "./work-unit-summary";
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

function unit(commits: readonly ScorableCommit[], number = 7): WorkUnit<ScorableCommit> {
  return {
    pullRequestNumber: number,
    pullRequest: { number, title: "제목", state: "closed", baseBranch: "develop", headBranch: "f" },
    commits,
  };
}

function signalsOf(commits: readonly ScorableCommit[]): readonly WorkUnitSignal[] {
  const target = unit(commits);
  return scoreWorkUnit(target, summarizeWorkUnit(target)).signals;
}

function file(overrides: Partial<ScorableCommit["files"][number]>) {
  return { path: "src/index.ts", status: "modified", additions: 1, changes: 1, ...overrides };
}

describe("scoreWorkUnit", () => {
  it("아무 신호도 없으면 0점이다", () => {
    expect(signalsOf([commit()])).toEqual([]);
  });

  it("점수는 발화한 신호 수와 같다", () => {
    const target = unit([commit(), commit(), commit(), commit(), commit()]);
    const result = scoreWorkUnit(target, summarizeWorkUnit(target));

    expect(result.score).toBe(result.signals.length);
    expect(result.signals).toEqual(["many_commits"]);
  });

  it("PR 번호를 그대로 남긴다", () => {
    const target = unit([commit()], 113);

    expect(scoreWorkUnit(target, summarizeWorkUnit(target)).pullRequestNumber).toBe(113);
  });

  it.each([
    ["package.json", "package.json"],
    ["중첩 경로", "apps/web/package.json"],
    ["requirements.txt", "requirements.txt"],
    ["go.mod", "go.mod"],
    ["Cargo.toml", "Cargo.toml"],
  ])("의존성 매니페스트 추가를 판별한다: %s", (_label, path) => {
    expect(signalsOf([commit({ files: [file({ path, additions: 5 })] })])).toContain(
      "dependency_added"
    );
  });

  it("버전 한 줄만 바뀐 매니페스트는 의존성 추가로 세지 않는다", () => {
    expect(
      signalsOf([commit({ files: [file({ path: "package.json", additions: 1 })] })])
    ).not.toContain("dependency_added");
  });

  it.each([
    [".github/workflows/deploy.yml"],
    ["Dockerfile"],
    ["vercel.json"],
    ["supabase/config.toml"],
  ])("인프라 파일 신규 생성을 판별한다: %s", (path) => {
    expect(signalsOf([commit({ files: [file({ path, status: "added" })] })])).toContain(
      "infrastructure_added"
    );
  });

  it("기존 인프라 파일 수정은 신규 생성으로 세지 않는다", () => {
    expect(
      signalsOf([commit({ files: [file({ path: "Dockerfile", status: "modified" })] })])
    ).not.toContain("infrastructure_added");
  });

  it("같은 파일을 크게 세 번 고치면 반복 재작성으로 본다", () => {
    const large = { path: "src/a.ts", changes: REPEATED_REWRITE_MIN_CHANGES + 1 };

    expect(
      signalsOf([
        commit({ files: [file(large)] }),
        commit({ files: [file(large)] }),
        commit({ files: [file(large)] }),
      ])
    ).toContain("file_rewritten_repeatedly");
  });

  it("두 번만 고치면 반복 재작성이 아니다", () => {
    const large = { path: "src/a.ts", changes: REPEATED_REWRITE_MIN_CHANGES + 1 };

    expect(
      signalsOf([commit({ files: [file(large)] }), commit({ files: [file(large)] })])
    ).not.toContain("file_rewritten_repeatedly");
  });

  it("작은 수정이 반복된 경우는 반복 재작성으로 세지 않는다", () => {
    const small = { path: "src/a.ts", changes: REPEATED_REWRITE_MIN_CHANGES };

    expect(
      signalsOf([
        commit({ files: [file(small)] }),
        commit({ files: [file(small)] }),
        commit({ files: [file(small)] }),
      ])
    ).not.toContain("file_rewritten_repeatedly");
  });

  it("서로 다른 파일을 한 번씩 고친 경우는 반복 재작성이 아니다", () => {
    const changes = REPEATED_REWRITE_MIN_CHANGES + 1;

    expect(
      signalsOf([
        commit({ files: [file({ path: "a.ts", changes })] }),
        commit({ files: [file({ path: "b.ts", changes })] }),
        commit({ files: [file({ path: "c.ts", changes })] }),
      ])
    ).not.toContain("file_rewritten_repeatedly");
  });

  it.each(["revert: 잘못된 배포 되돌림", "hotfix: 결제 오류", "긴급 배포 롤백"])(
    "되돌리기와 긴급 수정을 판별한다: %s",
    (message) => {
      expect(signalsOf([commit({ message })])).toContain("revert_or_hotfix");
    }
  );

  it("지운 코드가 많고 추가보다 크면 대형 리팩토링으로 본다", () => {
    expect(
      signalsOf([commit({ additions: 100, deletions: LARGE_REFACTOR_MIN_DELETIONS + 1 })])
    ).toContain("large_refactor");
  });

  it("추가가 삭제보다 훨씬 많으면 대형 리팩토링이 아니다", () => {
    expect(
      signalsOf([commit({ additions: 5000, deletions: LARGE_REFACTOR_MIN_DELETIONS + 1 })])
    ).not.toContain("large_refactor");
  });

  it.each(["perf: 렌더링 최적화", "refactor: 구조 정리", "refactor(chat): 분리"])(
    "성능·구조 개선 프리픽스를 판별한다: %s",
    (title) => {
      expect(signalsOf([commit({ title })])).toContain("performance_or_refactor_prefix");
    }
  );

  it("프리픽스가 아닌 본문의 refactor는 세지 않는다", () => {
    expect(signalsOf([commit({ title: "feat: refactor 준비" })])).not.toContain(
      "performance_or_refactor_prefix"
    );
  });

  it("커밋 수 기준을 채우면 규모 신호가 발화한다", () => {
    const commits = Array.from({ length: MANY_COMMITS_THRESHOLD }, () => commit());

    expect(signalsOf(commits)).toContain("many_commits");
    expect(signalsOf(commits.slice(1))).not.toContain("many_commits");
  });

  it("기간 기준을 채우면 규모 신호가 발화한다", () => {
    expect(
      signalsOf([
        commit({ date: "2026-08-20T00:00:00Z" }),
        commit({ date: `2026-08-2${3}T00:00:00Z` }),
      ])
    ).toContain("long_span");
    expect(LONG_SPAN_DAYS_THRESHOLD).toBe(3);
  });

  it("파일 수 기준을 채우면 규모 신호가 발화한다", () => {
    const files = Array.from({ length: MANY_FILES_THRESHOLD }, (_, index) =>
      file({ path: `src/f${index}.ts` })
    );

    expect(signalsOf([commit({ files })])).toContain("many_files");
    expect(signalsOf([commit({ files: files.slice(1) })])).not.toContain("many_files");
  });

  it("신호를 선언 순서로 반환한다", () => {
    const commits = Array.from({ length: MANY_COMMITS_THRESHOLD }, () =>
      commit({ title: "refactor: 정리", files: [file({ path: "package.json", additions: 9 })] })
    );

    expect(signalsOf(commits)).toEqual([
      "dependency_added",
      "performance_or_refactor_prefix",
      "many_commits",
    ]);
  });
});

describe("sortByScoreDescending", () => {
  it("점수 내림차순으로 정렬한다", () => {
    const sorted = sortByScoreDescending([{ s: 1 }, { s: 5 }, { s: 3 }], ({ s }) => s);

    expect(sorted.map(({ s }) => s)).toEqual([5, 3, 1]);
  });

  it("점수가 같으면 입력 순서를 유지한다", () => {
    const sorted = sortByScoreDescending(
      [
        { id: "a", s: 2 },
        { id: "b", s: 2 },
        { id: "c", s: 2 },
      ],
      ({ s }) => s
    );

    expect(sorted.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const items = [{ s: 1 }, { s: 5 }];

    sortByScoreDescending(items, ({ s }) => s);

    expect(items.map(({ s }) => s)).toEqual([1, 5]);
  });
});

describe("WORK_UNIT_SIGNAL_COPY", () => {
  it("모든 신호에 사용자 문구가 있다", () => {
    for (const copy of Object.values(WORK_UNIT_SIGNAL_COPY)) {
      expect(copy).not.toBe("");
    }
  });
});
