import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encryptGitHubToken, GITHUB_SESSION_COOKIE, GITHUB_SESSION_KEY_ENV } from "@/lib/github/auth-session";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import { STAGE_B_MAX_CANDIDATES, STAGE_B_MAX_PATCH_CHARS, STAGE_B_MAX_TOTAL_PATCH_CHARS } from "@/features/experience-candidates/stage-b";
import { GitHubFetchError } from "@/lib/github/errors";
import { handleStageB } from "./route";

const candidate = { sha: "a", source: "automatic_recommendation" as const, contributionItem: null };
function request(value: unknown, authenticated = true) {
  return new NextRequest("https://example.com/api/candidates/stage-b", { method: "POST", headers: authenticated ? { cookie: `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("token")}` } : undefined, body: JSON.stringify(value) });
}
const detail = { sha: "a", title: "a", author: "me", date: "date", parentCount: 1, message: "a", additions: 1, deletions: 0, changedFiles: 1, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "diff" }], pullRequests: [] };

beforeEach(() => { process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64"); });
afterEach(() => { delete process.env[GITHUB_SESSION_KEY_ENV]; });
afterEach(() => { vi.useRealTimers(); });

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

  it("후보 상한, 잘못된 JSON, 본문 크기 상한을 요청 오류로 구분한다", async () => {
    const tooMany = Array.from({ length: STAGE_B_MAX_CANDIDATES + 1 }, (_, index) => ({ ...candidate, sha: String(index) }));
    expect((await handleStageB(request({ owner: "o", repo: "r", candidates: tooMany }))).status).toBe(422);
    const malformed = request({});
    Object.defineProperty(malformed, "json", { value: async () => { throw new SyntaxError(); } });
    expect((await handleStageB(malformed)).status).toBe(400);
    const oversized = request({ owner: "o", repo: "r", candidates: [] });
    oversized.headers.set("content-length", String(4.5 * 1024 * 1024 + 1));
    expect((await handleStageB(oversized)).status).toBe(413);
  });

  it.each([["llm_configuration", 500], ["llm_rate_limit", 503]] as const)("%s 오류를 HTTP %i로 매핑한다", async (kind, status) => {
    const response = await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }), async () => { throw new ExperienceCandidateOutputError(kind, "safe"); }, undefined, async () => detail);
    expect(response.status).toBe(status);
  });

  it("GitHub 조회에서 전체 예산이 소진되면 LLM 호출 없이 504를 반환한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generate = vi.fn();
    const second = { ...candidate, sha: "b" };
    const response = await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate, second] }), generate, 20_000, async (_auth, sha) => {
      vi.setSystemTime(11_001);
      return { ...detail, sha };
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { kind: "llm_timeout", message: "Stage B 실행 시간 예산이 초과되었습니다." } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("GitHub 조회에 쓴 시간을 제외한 잔여 예산만 LLM에 전달한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responsePromise = handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }), async (_payload, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), 20_000, async () => {
      vi.setSystemTime(5_000);
      return detail;
    });
    const assertion = expect(responsePromise).resolves.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("파일별 상한과 전체 예산 절단 표시를 응답 diff에 보존한다", async () => {
    const files = Array.from({ length: STAGE_B_MAX_TOTAL_PATCH_CHARS / STAGE_B_MAX_PATCH_CHARS + 1 }, (_, index) => ({
      ...detail.files[0],
      path: `src/${index}.ts`,
      patch: "x".repeat(index === 0 ? STAGE_B_MAX_PATCH_CHARS + 1 : STAGE_B_MAX_PATCH_CHARS),
    }));
    const response = await handleStageB(request({ owner: "o", repo: "r", candidates: [candidate] }), async () => ({ candidates: [{ sha: "a", relatedShas: [], evidence: "근거", citedFilePaths: ["src/0.ts"], source: candidate.source }], insufficientCandidatesReason: "부족" }), undefined, async () => ({ ...detail, files }));
    const body = await response.json();
    expect(body.diffs[0].files[0].patchTruncated).toBe(true);
    expect(body.diffs[0].files.at(-1).patchTruncated).toBe(true);
  });
});
