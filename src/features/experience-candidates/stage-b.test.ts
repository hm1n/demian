import { describe, expect, it, vi } from "vitest";
import { buildStageBPayload, selectStageBCandidates, STAGE_B_MAX_PATCH_CHARS } from "./stage-b";
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

  it("입력 밖 SHA와 다른 PR 관련 SHA를 전체 거부한다", async () => {
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "z", relatedShas: [], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "contribution_match" }], insufficientCandidatesReason: "부족" }))).rejects.toMatchObject({ kind: "unknown_sha" });
    await expect(selectStageBCandidates(commits, candidates, async () => ({ candidates: [{ sha: "a", relatedShas: ["b"], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "contribution_match" }], insufficientCandidatesReason: "부족" }))).rejects.toMatchObject({ kind: "unrelated_sha" });
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
