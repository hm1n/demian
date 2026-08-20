import { describe, expect, it } from "vitest";
import {
  classifyBlacklistedCommit,
  filterCommitsForDetail,
} from "./commit-blacklist";
import type { CommitSummary } from "./types";

function commit(message: string, parentCount = 1, sha = "sha"): CommitSummary {
  return {
    sha,
    title: message.split("\n")[0],
    author: "author",
    date: "2026-08-20",
    parentCount,
  };
}

describe("classifyBlacklistedCommit", () => {
  it("부모가 2개 이상이면 병합 커밋으로 분류한다", () => {
    expect(classifyBlacklistedCommit(commit("feat: useful change", 2))).toBe("merge");
  });

  it.each([
    "docs: add guide",
    "Update documentation",
    "refresh README",
    "write changelog",
    "문서 추가",
    "리드미 수정",
  ])("문서 규칙을 판별한다: %s", (message) => {
    expect(classifyBlacklistedCommit(commit(message))).toBe("documentation");
  });

  it.each([
    "chore(deps): update react",
    "build(deps): update vite",
    "Bump react from 18 to 19",
    "update dependencies",
    "버전업",
  ])("의존성 규칙을 판별한다: %s", (message) => {
    expect(classifyBlacklistedCommit(commit(message))).toBe("dependency");
  });

  it.each(["fix typo", "fix misspell", "correct spelling", "오타 수정", "오탈자", "맞춤법 수정"])(
    "오타 규칙을 판별한다: %s",
    (message) => {
      expect(classifyBlacklistedCommit(commit(message))).toBe("typo");
    }
  );

  it.each([
    "format source",
    "run lint",
    "apply eslint",
    "use prettier",
    "포맷 적용",
    "린트 수정",
  ])("포맷팅 규칙을 판별한다: %s", (message) => {
    expect(classifyBlacklistedCommit(commit(message))).toBe("formatting");
  });

  it("본문에만 블랙리스트 키워드가 있으면 상세 조회 대상으로 남긴다", () => {
    const commits = [
      commit("feat: 실시간 채팅\n\n- docs 갱신", 1, "chat"),
      commit("feat: 결제 모듈 도입\n\n* fix typo in label", 1, "payment"),
    ];

    expect(filterCommitsForDetail(commits).map(({ sha }) => sha)).toEqual(["chat", "payment"]);
  });

  it("여러 규칙이 겹치면 병합 → 문서 → 의존성 → 오타 → 포맷팅 순서로 분류한다", () => {
    expect(classifyBlacklistedCommit(commit("docs: deps typo lint", 2))).toBe("merge");
    expect(classifyBlacklistedCommit(commit("docs: deps typo lint"))).toBe("documentation");
    expect(classifyBlacklistedCommit(commit("deps typo lint"))).toBe("dependency");
    expect(classifyBlacklistedCommit(commit("typo lint"))).toBe("typo");
  });

  it.each([
    "feat: add authentication",
    "fix: prevent duplicate requests",
    "chore: update config",
    "feat: add information panel",
    "fix: avoid speedbump regression",
    "feat: integrate flint parser",
    "feat: 주문서 결제 연동",
    "feat: 설문서 항목 추가",
    "feat: 스프린트 보드 뷰 구현",
    "feat: 프린트 미리보기 추가",
    "refactor: upgrade 파싱 알고리즘",
    "feat: 사용자 등급 upgrade 로직",
    "style: 친구 목록 퍼블리싱",
    "feat: 알림 읽기 상태에 따른 정렬 추가",
    "fix: bump upload limit to 10 MB",
    "fix: bump upload limit from 5 to 10 MB",
    "perf: implement bump allocator",
  ])(
    "일반 개발 커밋은 제외하지 않는다: %s",
    (message) => {
      expect(classifyBlacklistedCommit(commit(message))).toBeNull();
    }
  );

  it.each(["문서화", "리드미 수정", "버전업", "오타 수정", "포맷 적용", "린트 수정"])(
    "한국어 키워드로 시작하면 계속 분류한다: %s",
    (message) => {
      expect(classifyBlacklistedCommit(commit(message))).not.toBeNull();
    }
  );
});

describe("filterCommitsForDetail", () => {
  it("블랙리스트에 해당하지 않는 커밋만 상세 조회 대상으로 반환한다", () => {
    const commits = [
      commit("Merge branch main", 2, "merge"),
      commit("docs: update guide", 1, "docs"),
      commit("feat: add repository fetch", 1, "feature"),
      commit("fix: handle API error", 1, "fix"),
      commit("run prettier", 1, "formatting"),
    ];

    expect(filterCommitsForDetail(commits).map(({ sha }) => sha)).toEqual(["feature", "fix"]);
  });
});
