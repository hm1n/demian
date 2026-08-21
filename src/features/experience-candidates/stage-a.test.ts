import { APICallError, LoadAPIKeyError, NoObjectGeneratedError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceCandidateOutputError } from "./errors";
import {
  buildStageAPayload,
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  selectStageACandidates,
  type StageAInput,
} from "./stage-a";

const input: StageAInput = {
  contributionItems: ["인증 구현"],
  commits: [
    {
      sha: "matched",
      message: "feat: 인증 구현",
      additions: 20,
      deletions: 2,
      changedFiles: 1,
      files: [{
        path: "src/auth.ts",
        status: "modified",
        additions: 20,
        deletions: 2,
        changes: 22,
      }],
    },
    {
      sha: "automatic",
      message: "fix: 오류 처리",
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      files: [{
        path: "src/error.ts",
        status: "modified",
        additions: 5,
        deletions: 1,
        changes: 6,
      }],
    },
    {
      sha: "unclassified",
      message: "docs: 문서",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Stage A 후보 선별", () => {
  it("기여 항목 매칭과 미분류 자동 추천을 한 경로에서 조합한다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: "인증 구현", recommended: true },
      { sha: "automatic", contributionItem: "미분류", recommended: true },
      { sha: "unclassified", contributionItem: "미분류", recommended: false },
    ] }));

    expect(output).toEqual({
      candidates: [
        { sha: "matched", source: "contribution_match", contributionItem: "인증 구현" },
        { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
      ],
      unclassifiedShas: ["unclassified"],
    });
  });

  it("기여 항목이 없으면 추천된 SHA를 자동 추천 후보로 만든다", async () => {
    const output = await selectStageACandidates(
      { ...input, contributionItems: [] },
      async () => ({ decisions: input.commits.map(({ sha }) => ({ sha, contributionItem: null, recommended: sha === "automatic" })) })
    );
    expect(output.candidates).toEqual([
      { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
    ]);
  });

  it("기여 항목만 있으면 일치한 SHA를 해당 항목 후보로 만든다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: "인증 구현", recommended: false },
      { sha: "automatic", contributionItem: null, recommended: false },
      { sha: "unclassified", contributionItem: null, recommended: false },
    ] }));
    expect(output.candidates[0]).toEqual({
      sha: "matched",
      source: "contribution_match",
      contributionItem: "인증 구현",
    });
  });

  it.each(["미분류", "존재하지 않는 항목"])("%s 라벨도 추천되면 자동 추천 후보로 정규화한다", async (label) => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: label, recommended: true },
      { sha: "automatic", contributionItem: null, recommended: false },
      { sha: "unclassified", contributionItem: null, recommended: false },
    ] }));
    expect(output.candidates).toEqual([
      { sha: "matched", source: "automatic_recommendation", contributionItem: null },
    ]);
  });

  it("recommended가 false인 커밋만 미분류로 남긴다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: null, recommended: false },
      { sha: "automatic", contributionItem: null, recommended: true },
      { sha: "unclassified", contributionItem: "미분류", recommended: false },
    ] }));
    expect(output.unclassifiedShas).toEqual(["matched", "unclassified"]);
  });

  it("사용자가 입력한 미분류 문자열을 기여 항목으로 오인하지 않는다", async () => {
    const output = await selectStageACandidates(
      { ...input, contributionItems: ["미분류"] },
      async () => ({ decisions: [
        { sha: "matched", contributionItem: "미분류", recommended: false },
        { sha: "automatic", contributionItem: null, recommended: false },
        { sha: "unclassified", contributionItem: null, recommended: false },
      ] })
    );
    expect(output.candidates).toEqual([]);
    expect(output.unclassifiedShas).toContain("matched");
  });

  it("실제 LLM payload에서 patch와 불필요한 메타데이터를 제외한다", () => {
    const taintedInput = {
      ...input,
      commits: [{
        ...input.commits[0],
        files: [{ ...input.commits[0].files[0], patch: "secret diff" }],
      }],
    } as unknown as StageAInput;
    const payload = buildStageAPayload(taintedInput);
    expect(JSON.stringify(payload)).not.toContain("patch");
    expect(payload.commits[0]).toEqual({
      sha: "matched",
      message: "feat: 인증 구현",
      additions: 20,
      deletions: 2,
      changedFiles: 1,
      files: [{ path: "src/auth.ts", status: "modified", additions: 20, deletions: 2, changes: 22 }],
    });
  });

  it("구조 위반, 환각 SHA, 누락 SHA를 전체 거부한다", async () => {
    await expect(selectStageACandidates(input, async () => ({ decisions: "invalid" }))).rejects.toMatchObject({ kind: "schema_validation" });
    await expect(selectStageACandidates(input, async () => ({ decisions: [
      { sha: "invented", contributionItem: null, recommended: true },
    ] }))).rejects.toMatchObject({ kind: "unknown_sha", unknownShas: ["invented"] });
    await expect(selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: "인증 구현", recommended: true },
    ] }))).rejects.toMatchObject({ kind: "schema_validation" });
  });

  it("초기 후보 상한을 넘긴 응답을 순서대로 절단하지 않고 전체 거부한다", async () => {
    const commits = Array.from({ length: INITIAL_STAGE_A_CANDIDATE_LIMIT + 1 }, (_, index) => ({
      ...input.commits[0],
      sha: `sha-${index}`,
    }));
    await expect(selectStageACandidates(
      { commits, contributionItems: [] },
      async () => ({ decisions: commits.map(({ sha }) => ({
        sha,
        contributionItem: null,
        recommended: true,
      })) })
    )).rejects.toMatchObject({ kind: "schema_validation" });
  });

  const apiError = (statusCode: number) => new APICallError({
    message: "provider error",
    url: "https://api.groq.com",
    requestBodyValues: {},
    statusCode,
  });
  const noObjectError = new NoObjectGeneratedError({
    response: { id: "response", timestamp: new Date(), modelId: "model" },
    usage: {
      inputTokens: 0,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: 0,
    },
    finishReason: "error",
  });

  it.each([
    [new TypeError("fetch failed"), "llm_network"],
    [apiError(500), "llm_failure"],
    [new DOMException("aborted", "AbortError"), "llm_timeout"],
    [new DOMException("timeout", "TimeoutError"), "llm_timeout"],
    [apiError(401), "llm_auth"],
    [apiError(403), "llm_auth"],
    [apiError(429), "llm_rate_limit"],
    [apiError(408), "llm_timeout"],
    [apiError(504), "llm_timeout"],
    [apiError(404), "llm_configuration"],
    [apiError(400), "llm_request"],
    [apiError(409), "llm_request"],
    [apiError(422), "llm_request"],
    [noObjectError, "schema_validation"],
    [new LoadAPIKeyError({ message: "missing key" }), "llm_configuration"],
    [new Error("unknown"), "llm_failure"],
  ] as const)("LLM 호출 실패 %#을 구분한다", async (error, kind) => {
    await expect(selectStageACandidates(input, async () => { throw error; })).rejects.toEqual(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({ kind })
    );
  });

  it("응답하지 않는 generator를 시한에 중단하고 llm_timeout으로 매핑한다", async () => {
    vi.useFakeTimers();
    const selection = selectStageACandidates(
      input,
      async (_payload, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      10
    );
    const assertion = expect(selection).rejects.toMatchObject({ kind: "llm_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("정상 응답 뒤에는 중단 타이머를 제거한다", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    await selectStageACandidates(input, async (_payload, receivedSignal) => {
      signal = receivedSignal;
      return { decisions: input.commits.map(({ sha }) => ({
        sha,
        contributionItem: null,
        recommended: false,
      })) };
    }, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
