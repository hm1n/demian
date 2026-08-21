import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_BATCH_LIMITS } from "./api-contract";
import { toAnalysisError } from "@/features/repository-analysis/repository-analysis";
import { fetchAuthoredCommitsFromApi, fetchContributionsFromApi } from "./route-client";
import type { CommitSummary } from "./types";

const REPOSITORY = { owner: "octocat", repo: "hello-world" };
const commits: CommitSummary[] = Array.from({ length: GITHUB_BATCH_LIMITS.commitDetails + 1 }, (_, index) => ({
  sha: String(index).padStart(40, "0"),
  title: "feat",
  author: "octocat",
  date: "2026-08-21",
  parentCount: 1,
}));

afterEach(() => vi.unstubAllGlobals());

describe("GitHub route client", () => {
  it("이전 성공 배치와 실패 배치의 부분 커밋을 모두 보존한다", async () => {
    const first = commits[0];
    const failedBatchPartial = commits[1];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ commits: [first], repositoryHasCommits: true, cursor: "next" }))
      .mockResolvedValueOnce(Response.json({
        error: {
          kind: "partial_failure",
          message: "limited",
          causeKind: "rate_limit",
          partialCommits: [failedBatchPartial],
          completed: 1,
        },
      }, { status: 500 })));

    const error = await fetchAuthoredCommitsFromApi(REPOSITORY).catch((caught) => caught);

    expect(error.partialCommits).toEqual([first, failedBatchPartial]);
    expect(toAnalysisError(error, { step: "commits" })).toMatchObject({
      kind: "partial_failure",
      causeKind: "rate_limit",
      completed: 2,
    });
  });

  it("서버 상세 상한을 단일 출처로 사용하고 meta 요청에 저장소 존재 플래그를 보내지 않는다", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ commits: commits.slice(0, GITHUB_BATCH_LIMITS.commitDetails).map((commit) => ({ ...commit, message: "feat", additions: 0, deletions: 0, changedFiles: 0, files: [], pullRequests: [] })) }))
      .mockResolvedValueOnce(Response.json({ commits: [{ ...commits.at(-1)!, message: "feat", additions: 0, deletions: 0, changedFiles: 0, files: [], pullRequests: [] }] }))
      .mockResolvedValueOnce(Response.json({ tree: [], treeTruncated: false, languages: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchContributionsFromApi(REPOSITORY, commits, vi.fn());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).commits).toHaveLength(GITHUB_BATCH_LIMITS.commitDetails);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).commits).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(REPOSITORY);
  });

  it("null languages 응답을 server_error로 거부한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ tree: [], treeTruncated: false, languages: null })));
    await expect(fetchContributionsFromApi(REPOSITORY, [], vi.fn())).rejects.toMatchObject({ kind: "server_error" });
  });
});
