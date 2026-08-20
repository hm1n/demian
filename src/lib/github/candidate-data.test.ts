import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCandidateData, fetchCandidateData } from "./candidate-data";
import type { CommitSummary, RepositoryContributionData } from "./types";

const ALL_COMMITS: readonly CommitSummary[] = [
  {
    sha: "included",
    title: "feat: add parser",
    author: "min",
    date: "2026-08-20",
    parentCount: 1,
  },
  {
    sha: "excluded",
    title: "docs: update readme",
    author: "min",
    date: "2026-08-19",
    parentCount: 1,
  },
];

function contributionData(): RepositoryContributionData {
  return {
    commits: [
      {
        ...ALL_COMMITS[0],
        message: "feat: add parser\n\nimplementation detail",
        additions: 12,
        deletions: 3,
        changedFiles: 1,
        files: [
          {
            path: "src/parser.ts",
            status: "modified",
            additions: 12,
            deletions: 3,
            changes: 15,
            patch: "@@ -1 +1 @@",
          },
        ],
        pullRequests: [
          {
            number: 4,
            title: "Add parser",
            url: "https://github.com/hm1n/demian/pull/4",
            state: "closed",
            baseBranch: "main",
            headBranch: "feature/parser",
          },
        ],
      },
    ],
    tree: [{ path: "src/parser.ts", type: "blob", sha: "file-sha", size: 120 }],
    treeTruncated: false,
    languages: { TypeScript: 1024, CSS: 256 },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildCandidateData", () => {
  it("전체 커밋과 RepositoryContributionData를 후보 생성 입력으로 전달한다", () => {
    const contributions = contributionData();
    const output = buildCandidateData(ALL_COMMITS, contributions);

    expect(output).toEqual({
      allCommits: ALL_COMMITS,
      includedCommits: contributions.commits,
      repository: {
        fileTree: contributions.tree,
        treeTruncated: false,
        languages: contributions.languages,
      },
    });
  });

  it("제외 커밋은 전체 메타데이터에만 남기고 비제외 커밋은 기존 평면 지표를 보존한다", () => {
    const output = buildCandidateData(ALL_COMMITS, contributionData());

    expect(output.allCommits.map(({ sha }) => sha)).toEqual(["included", "excluded"]);
    expect(output.includedCommits.map(({ sha }) => sha)).toEqual(["included"]);
    expect(output.includedCommits[0]).toMatchObject({
      additions: 12,
      deletions: 3,
      changedFiles: 1,
    });
  });

  it("PR이 없는 커밋은 빈 배열로 전달한다", () => {
    const contributions = contributionData();
    contributions.commits[0].pullRequests = [];

    expect(buildCandidateData(ALL_COMMITS, contributions).includedCommits[0].pullRequests).toEqual(
      []
    );
  });

  it("읽기 전용 계약으로 앞 단계의 배열과 PR 정보를 변형 없이 전달한다", () => {
    const contributions = contributionData();
    const output = buildCandidateData(ALL_COMMITS, contributions);

    expect(output.allCommits).toBe(ALL_COMMITS);
    expect(output.includedCommits).toBe(contributions.commits);
    expect(output.repository.fileTree).toBe(contributions.tree);
    expect(output.includedCommits[0].pullRequests).toBe(contributions.commits[0].pullRequests);
  });

  it("GitHub API 호출이나 후보 평가 결과를 출력 조립 단계에 추가하지 않는다", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const output = buildCandidateData(ALL_COMMITS, contributionData());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output.includedCommits[0]).not.toHaveProperty("score");
    expect(output.includedCommits[0]).not.toHaveProperty("rank");
    expect(output).not.toHaveProperty("candidates");
  });
});

describe("fetchCandidateData", () => {
  it("전체 커밋을 필터링한 뒤 기존 상세 조회 결과를 출력 인터페이스로 연결한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          sha: "included",
          commit: {
            message: "feat: add parser",
            author: { name: "min", date: "2026-08-20" },
          },
          author: { login: "min" },
          stats: { additions: 12, deletions: 3 },
          files: [],
        })
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ TypeScript: 1024 }))
      .mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const output = await fetchCandidateData(
      { owner: "hm1n", repo: "demian", token: "token" },
      ALL_COMMITS
    );

    expect(output.allCommits).toBe(ALL_COMMITS);
    expect(output.includedCommits.map(({ sha }) => sha)).toEqual(["included"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
