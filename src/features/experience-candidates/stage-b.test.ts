import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildStageBPayload, selectStageBCandidates, STAGE_B_MAX_PATCH_CHARS, STAGE_B_MAX_TOTAL_PATCH_CHARS } from "./stage-b";
import type { CommitDetail } from "@/lib/github/types";

const candidates = [
  { sha: "a", source: "contribution_match" as const, contributionItem: "성능 개선" },
  { sha: "b", source: "automatic_recommendation" as const, contributionItem: null },
];
const commits: CommitDetail[] = candidates.map(({ sha }, index) => ({
  sha, title: sha, author: "me", date: "2026-08-21", parentCount: 1, message: sha,
  additions: 1, deletions: 0, changedFiles: 1,
  files: [{ path: `src/${sha}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1, patch: "x".repeat(index ? 10 : STAGE_B_MAX_PATCH_CHARS + 1) }],
  pullRequests: [{ number: index ? 2 : 1, title: "PR", state: "closed", url: "url", baseBranch: "develop", headBranch: "feature" }],
}));

describe("Stage B", () => {
  it("파일 patch를 상한에서 자르고 절단 여부를 모델에 표시한다", () => {
    const payload = buildStageBPayload(commits, candidates);
    expect(payload.commits[0].files[0].patch).toHaveLength(STAGE_B_MAX_PATCH_CHARS);
    expect(payload.commits[0].files[0].patchTruncated).toBe(true);
  });

  it("정상 후보와 부족 사유를 검증하고 입력 근거만 허용한다", async () => {
    const output = await selectStageBCandidates(commits, candidates, async () => ({
      candidates: [{ sha: "a", relatedShas: [], evidence: "diff 근거", citedFilePaths: ["src/a.ts"], source: "contribution_match" }],
      insufficientCandidatesReason: "독립적인 경험이 하나뿐입니다.",
    }));
    expect(output.candidates).toHaveLength(1);
  });

  it("전체 patch 예산 이후에도 SHA와 파일 stat을 payload에 유지한다", () => {
    const large = commits.map((commit, index) => ({
      ...commit,
      files: Array.from({ length: index === 0 ? STAGE_B_MAX_TOTAL_PATCH_CHARS / STAGE_B_MAX_PATCH_CHARS : 1 }, (_, fileIndex) => ({
        ...commit.files[0],
        path: `src/${commit.sha}-${fileIndex}.ts`,
        patch: "x".repeat(STAGE_B_MAX_PATCH_CHARS),
      })),
    }));
    const payload = buildStageBPayload(large, candidates);
    expect(payload.commits[1]).toMatchObject({ sha: "b", files: [{ path: "src/b-0.ts", additions: 1 }] });
    expect(payload.commits[1].files[0]).not.toHaveProperty("patch");
    expect(payload.commits[1].files[0].patchTruncated).toBe(true);
  });

  it("후보 3개 계약과 부족 사유 계약을 검증한다", async () => {
    const threeCandidates = [...candidates, { sha: "c", source: "automatic_recommendation" as const, contributionItem: null }];
    const threeCommits = [...commits, { ...commits[1], sha: "c", files: [{ ...commits[1].files[0], path: "src/c.ts" }] }];
    const output = await selectStageBCandidates(threeCommits, threeCandidates, async () => ({
      candidates: threeCandidates.map(({ sha, source }) => ({ sha, relatedShas: [], evidence: "근거", citedFilePaths: [`src/${sha}.ts`], source })),
      insufficientCandidatesReason: null,
    }));
    expect(output.candidates).toHaveLength(3);
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [], insufficientCandidatesReason: null }))).rejects.toMatchObject({ kind: "schema_validation" });
  });

  it("입력 밖 SHA와 다른 PR 관련 SHA를 전체 거부한다", async () => {
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "z", relatedShas: [], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "contribution_match" }], insufficientCandidatesReason: "부족" }))).rejects.toMatchObject({ kind: "unknown_sha" });
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "a", relatedShas: ["b"], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "contribution_match" }], insufficientCandidatesReason: "부족" }))).rejects.toMatchObject({ kind: "unrelated_sha" });
  });

  it("diff에 없는 인용 경로를 전체 거부한다", async () => {
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "a", relatedShas: [], evidence: "근거", citedFilePaths: ["src/unknown.ts"], source: "contribution_match" }], insufficientCandidatesReason: "부족" }))).rejects.toMatchObject({ kind: "unknown_file_path" });
  });

  it("모델의 source를 Stage A 값으로 교정한다", async () => {
    const output = await selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "a", relatedShas: [], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "automatic_recommendation" }], insufficientCandidatesReason: "부족" }));
    expect(output.candidates[0].source).toBe("contribution_match");
  });

  // 이슈 #19 실측: provider가 분당 토큰 한도 초과를 429가 아니라 413으로 반환한다.
  // 413을 한도로 분류하지 않으면 일반 실패(502)로 새어 재시도 가능 여부를 알 수 없다.
  it.each([
    [429, "llm_rate_limit"],
    [413, "llm_rate_limit"],
  ] as const)("한도 상태 코드 %i를 %s로 매핑한다", async (statusCode, kind) => {
    const error = new APICallError({
      message: "rate limit",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      responseBody: "",
    });
    await expect(
      selectStageBCandidates(commits, candidates, async () => {
        throw error;
      })
    ).rejects.toMatchObject({ kind });
  });

  it("시한 중단을 llm_timeout으로 보존한다", async () => {
    vi.useFakeTimers();
    const promise = selectStageBCandidates(commits, candidates, async (_payload, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), 10);
    const assertion = expect(promise).rejects.toMatchObject({ kind: "llm_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    vi.useRealTimers();
  });
});
