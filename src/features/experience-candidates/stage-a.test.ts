import { APICallError, LoadAPIKeyError, NoObjectGeneratedError, RetryError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceCandidateOutputError } from "./errors";
import {
  buildStageAPayload,
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  selectStageACandidates,
  type StageAInput,
  type StageAUnitInput,
} from "./stage-a";

function unit(
  pullRequestNumber: number,
  representativeSha: string,
  pullRequestTitle: string,
  commitTitles: readonly string[],
  topFilePaths: readonly string[]
): StageAUnitInput {
  return {
    pullRequestNumber,
    representativeSha,
    summary: {
      pullRequestNumber,
      pullRequestTitle,
      commitCount: commitTitles.length,
      spanDays: 1,
      additions: 20,
      deletions: 2,
      commitTitles: [...commitTitles],
      changedFilePathCount: topFilePaths.length,
      topFilePaths: [...topFilePaths],
    },
  };
}

const input: StageAInput = {
  contributionItems: ["인증 구현"],
  candidateLimit: INITIAL_STAGE_A_CANDIDATE_LIMIT,
  units: [
    unit(1, "matched", "인증 구현", ["feat: 인증 구현"], ["src/auth.ts"]),
    unit(2, "automatic", "오류 처리", ["fix: 오류 처리"], ["src/error.ts"]),
    unit(3, "unclassified", "문서", ["docs: 문서"], ["README.md"]),
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Stage A 후보 선별", () => {
  it("기여 항목 매칭과 미분류 자동 추천을 한 경로에서 조합한다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 1, contributionItem: "인증 구현", recommended: true },
      { pullRequestNumber: 2, contributionItem: "미분류", recommended: true },
      { pullRequestNumber: 3, contributionItem: "미분류", recommended: false },
    ] }));

    expect(output).toEqual({
      candidates: [
        { sha: "matched", source: "contribution_match", contributionItem: "인증 구현" },
        { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
      ],
      unclassifiedShas: ["unclassified"],
      rateLimit: null,
    });
  });

  it("기여 항목이 없으면 추천된 SHA를 자동 추천 후보로 만든다", async () => {
    const output = await selectStageACandidates(
      { ...input, contributionItems: [] },
      async () => ({ decisions: input.units.map(({ pullRequestNumber }) => ({ pullRequestNumber, contributionItem: null, recommended: pullRequestNumber === 2 })) })
    );
    expect(output.candidates).toEqual([
      { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
    ]);
  });

  it("기여 항목만 있으면 일치한 SHA를 해당 항목 후보로 만든다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 1, contributionItem: "인증 구현", recommended: false },
      { pullRequestNumber: 2, contributionItem: null, recommended: false },
      { pullRequestNumber: 3, contributionItem: null, recommended: false },
    ] }));
    expect(output.candidates[0]).toEqual({
      sha: "matched",
      source: "contribution_match",
      contributionItem: "인증 구현",
    });
  });

  it.each(["미분류", "존재하지 않는 항목"])("%s 라벨도 추천되면 자동 추천 후보로 정규화한다", async (label) => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 1, contributionItem: label, recommended: true },
      { pullRequestNumber: 2, contributionItem: null, recommended: false },
      { pullRequestNumber: 3, contributionItem: null, recommended: false },
    ] }));
    expect(output.candidates).toEqual([
      { sha: "matched", source: "automatic_recommendation", contributionItem: null },
    ]);
  });

  it("recommended가 false인 커밋만 미분류로 남긴다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 1, contributionItem: null, recommended: false },
      { pullRequestNumber: 2, contributionItem: null, recommended: true },
      { pullRequestNumber: 3, contributionItem: "미분류", recommended: false },
    ] }));
    expect(output.unclassifiedShas).toEqual(["matched", "unclassified"]);
  });

  it("사용자가 입력한 미분류 문자열을 기여 항목으로 오인하지 않는다", async () => {
    const output = await selectStageACandidates(
      { ...input, contributionItems: ["미분류"] },
      async () => ({ decisions: [
        { pullRequestNumber: 1, contributionItem: "미분류", recommended: false },
        { pullRequestNumber: 2, contributionItem: null, recommended: false },
        { pullRequestNumber: 3, contributionItem: null, recommended: false },
      ] })
    );
    expect(output.candidates).toEqual([]);
    expect(output.unclassifiedShas).toContain("matched");
  });

  it("LLM payload에 patch와 커밋 본문이 실리지 않는다", () => {
    const taintedInput = {
      ...input,
      units: [{
        ...input.units[0],
        summary: { ...input.units[0].summary, patch: "secret diff" },
      }],
    } as unknown as StageAInput;
    const payload = buildStageAPayload(taintedInput);
    expect(JSON.stringify(payload)).not.toContain("patch");
    expect(payload.units[0]).toEqual({
      pullRequestNumber: 1,
      summary: [
        "PR#1 인증 구현 [1커밋 1일 +20-2 1파일]",
        "  feat: 인증 구현",
        "  src/{auth.ts}",
      ].join("\n"),
    });
  });

  it("구조 위반, 환각 SHA, 누락 SHA를 전체 거부한다", async () => {
    await expect(selectStageACandidates(input, async () => ({ decisions: "invalid" }))).rejects.toMatchObject({ kind: "schema_validation" });
    await expect(selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 99, contributionItem: null, recommended: true },
    ] }))).rejects.toMatchObject({ kind: "unknown_sha", unknownShas: ["#99"] });
    await expect(selectStageACandidates(input, async () => ({ decisions: [
      { pullRequestNumber: 1, contributionItem: "인증 구현", recommended: true },
    ] }))).rejects.toMatchObject({ kind: "schema_validation" });
  });

  it("청크 쿼터를 넘긴 응답을 순서대로 절단하지 않고 전체 거부한다", async () => {
    const units = Array.from({ length: 4 }, (_, index) =>
      unit(index + 1, `sha-${index}`, "제목", ["feat: 작업"], ["src/a.ts"])
    );
    await expect(selectStageACandidates(
      { units, contributionItems: [], candidateLimit: 2 },
      async () => ({ decisions: units.map(({ pullRequestNumber }) => ({
        pullRequestNumber,
        contributionItem: null,
        recommended: true,
      })) })
    )).rejects.toMatchObject({ kind: "schema_validation" });
  });

  const apiError = (statusCode: number, responseBody?: string) => new APICallError({
    message: "provider error",
    url: "https://api.groq.com",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
  // Groq가 분당 토큰 한도 초과를 413으로 반환할 때의 본문 형태(이슈 #19 실측).
  const rateLimitBody = '{"error":{"code":"rate_limit_exceeded","type":"tokens"}}';
  // 요청·컨텍스트 자체가 모델 한도보다 클 때의 413 본문. 한도 초과가 아니다.
  const tooLargeBody = '{"error":{"code":"request_too_large","type":"invalid_request_error"}}';
  const retried = (statusCode: number, responseBody?: string) => new RetryError({
    message: "failed after 3 attempts",
    reason: "maxRetriesExceeded",
    errors: [apiError(statusCode, responseBody)],
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
    // 413은 두 갈래다. 본문이 한도 초과일 때만 한도로 분류한다(이슈 #19 실측).
    [apiError(413, rateLimitBody), "llm_rate_limit"],
    // 요청 과대 413은 기다려도 풀리지 않으므로 재시도 안내(503)를 보내면 안 된다.
    [apiError(413, tooLargeBody), "llm_request"],
    // 본문이 없으면 한도라고 단정할 근거가 없다. 재시도 안내를 보내지 않는 쪽으로 기운다.
    [apiError(413), "llm_request"],
    [apiError(408), "llm_timeout"],
    [apiError(504), "llm_timeout"],
    [apiError(404), "llm_configuration"],
    [apiError(400), "llm_request"],
    [apiError(409), "llm_request"],
    [apiError(422), "llm_request"],
    // 이슈 #19 실측: SDK가 재시도한 실패는 RetryError로 감싸져 오고 APICallError가 아니다.
    // 벗기지 않으면 한도 초과가 llm_failure로 뭉개진다.
    [retried(429), "llm_rate_limit"],
    [retried(413, rateLimitBody), "llm_rate_limit"],
    [retried(413, tooLargeBody), "llm_request"],
    [retried(404), "llm_configuration"],
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
      return { decisions: input.units.map(({ pullRequestNumber }) => ({
        pullRequestNumber,
        contributionItem: null,
        recommended: false,
      })) };
    }, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
