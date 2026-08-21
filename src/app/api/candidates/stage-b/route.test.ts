import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encryptGitHubToken, GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import { handleStageB } from "./route";

const candidate = { sha: "a", source: "automatic_recommendation" as const, contributionItem: null };
function request(value: unknown, authenticated = true) {
  return new NextRequest("https://example.com/api/candidates/stage-b", { method: "POST", headers: authenticated ? { cookie: `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("token")}` } : undefined, body: JSON.stringify(value) });
}
const detail = { sha: "a", title: "a", author: "me", date: "date", parentCount: 1, message: "a", additions: 1, deletions: 0, changedFiles: 1, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "diff" }], pullRequests: [] };

beforeEach(() => { process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64"); });
afterEach(() => { delete process.env[GITHUB_SESSION_KEY_ENV]; });

describe("POST /api/candidates/stage-b", () => {
  it("빈 후보는 GitHub와 LLM 호출 없이 200 Empty 계약을 반환한다", async () => {
    const fetchDetail = vi.fn();
    const generate = vi.fn();
    const response = await handleStageB(request({ owner: "o", repo: "r", candidates: [] }), generate, undefined, fetchDetail);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ candidates: [], insufficientCandidatesReason: "Stage A에서 선별된 후보가 없습니다.", diffs: [] });
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("최종 후보에 포함된 SHA의 diff만 반환한다", async () => {
    const response = await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }), async () => ({ candidates: [{ sha: "a", relatedShas: [], evidence: "근거", citedFilePaths: ["src/a.ts"], source: "automatic_recommendation" }], insufficientCandidatesReason: "하나뿐" }), undefined, async () => detail);
    expect(response.status).toBe(200);
    expect((await response.json()).diffs).toEqual([{ sha: "a", files: detail.files }]);
  });

  it("세션 누락, 중복 SHA, GitHub 실패를 LLM 호출 전에 거부한다", async () => {
    const generate = vi.fn();
    expect((await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }, false), generate)).status).toBe(401);
    expect((await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate, candidate] }), generate)).status).toBe(422);
    const failed = await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }), generate, undefined, async () => { throw new GitHubFetchError("rate_limit", "제한"); });
    expect(failed.status).toBe(429);
    expect(generate).not.toHaveBeenCalled();
  });
});
