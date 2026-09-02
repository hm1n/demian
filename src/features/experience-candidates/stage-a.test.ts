import { APICallError, generateObject, LoadAPIKeyError, NoObjectGeneratedError, RetryError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceCandidateOutputError } from "./errors";
import {
  buildStageAPayload,
  createStageAGenerate,
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  renderStageAPrompt,
  selectStageACandidates,
  type StageAInput,
  type StageAUnitInput,
} from "./stage-a";
import { LLM_MAX_RETRIES, STAGE_JUDGMENT_TEMPERATURE } from "./llm-provider";

// `createStageAGenerate`가 실제로 제공자에 보내는 프롬프트를 가로채기 위한 부분 모킹입니다.
// `generateObject`만 대체하고 나머지(`jsonSchema`, `APICallError` 등)는 실제 구현을 씁니다.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});

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
  vi.unstubAllEnvs();
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
      unjudgedShas: [],
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
  // Gemini가 잘못된 키에 돌려주는 400 본문(2026-09-01 실측). 상태 코드는 요청 형식 오류와 같고
  // `details`의 `reason`만 다르다.
  const invalidKeyBody =
    '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",' +
    '"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",' +
    '"reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}';
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
    // Gemini는 모델 과부하를 503, 내부 오류를 500으로 돌려준다. 기다리면 풀리는 실패다.
    [apiError(500), "llm_failure"],
    [apiError(503), "llm_failure"],
    [retried(503), "llm_failure"],
    // Gemini는 잘못된 키를 401이 아니라 400으로 돌려준다(2026-09-01 실측). 본문으로 갈라야 한다.
    [apiError(400, invalidKeyBody), "llm_auth"],
    [retried(400, invalidKeyBody), "llm_auth"],
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

describe("renderStageAPrompt", () => {
  it("기여 항목이 없으면 빈 섹션을 붙이지 않는다", () => {
    const payload = buildStageAPayload({ ...input, contributionItems: [] });
    const prompt = renderStageAPrompt(payload);
    expect(prompt).not.toContain("기여 항목:");
    expect(prompt).toBe(payload.units.map(({ summary }) => summary).join("\n"));
  });

  it("기여 항목이 있으면 구분된 문단으로 붙인다", () => {
    const payload = buildStageAPayload(input);
    const prompt = renderStageAPrompt(payload);
    expect(prompt).toContain("\n\n기여 항목:\n인증 구현");
  });

  // 이 테스트가 핵심입니다. 라우트가 예산을 재는 문자열과 모델에 실제로 실리는 문자열이
  // 다시 어긋나면(Codex 리뷰 P2-1처럼) 이 테스트가 잡습니다.
  it("createStageAGenerate가 제공자에 실제로 보내는 프롬프트와 같은 문자열을 만든다", async () => {
    const payload = buildStageAPayload(input);
    const generateObjectMock = vi.mocked(generateObject);
    generateObjectMock.mockResolvedValue({
      object: { decisions: payload.units.map(({ pullRequestNumber }) => ({
        pullRequestNumber, contributionItem: null, recommended: false,
      })) },
      response: { headers: {} },
      usage: { totalTokens: 0 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const generate = createStageAGenerate("test-model");
    await generate(payload, new AbortController().signal);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const actualPrompt = generateObjectMock.mock.calls[0]![0].prompt;
    expect(actualPrompt).toBe(renderStageAPrompt(payload));
  });
});

describe("로컬 전용 입력 범위 안내", () => {
  async function capturedCall() {
    const payload = buildStageAPayload(input);
    const generateObjectMock = vi.mocked(generateObject);
    generateObjectMock.mockResolvedValue({
      object: {
        decisions: payload.units.map(({ pullRequestNumber }) => ({
          pullRequestNumber,
          contributionItem: null,
          recommended: false,
        })),
      },
      response: { headers: {} },
      usage: { totalTokens: 0 },
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    await createStageAGenerate("test-model")(payload, new AbortController().signal);

    return generateObjectMock.mock.calls.at(-1)![0];
  }

  // 온도는 프로덕션에서도 고정값을 보냅니다. 2026-09-01 실측에서 제공자 기본 온도(1.0)가 같은 입력
  // 7회에 서로 다른 후보 집합 4개를 냈습니다. 프롬프트의 로컬 전용 문구만 프로덕션에서 빠집니다.
  it("프로덕션 경로에서는 프롬프트를 건드리지 않고 고정 온도를 보낸다", async () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", undefined);

    const call = await capturedCall();

    expect(call.system).not.toContain("커밋 제목 안에 적힌 다른 PR 번호");
    expect(call.temperature).toBe(STAGE_JUDGMENT_TEMPERATURE);
    expect(call.maxRetries).toBe(LLM_MAX_RETRIES);
  });

  /**
   * 묶음 요약의 커밋 제목에는 `Merge pull request #35` 같은 문구가 섞여 있습니다. 2026-08-25
   * 실측에서 `qwen2.5:7b`가 그 번호들을 판단 대상으로 끌어와 입력 11묶음에 46개 판정을 냈습니다.
   */
  it("로컬 경로에서는 판단 대상 범위를 프롬프트로 못박는다", async () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("STAGE_A_MODEL", "qwen2.5:7b");
    vi.stubEnv("LLM_TEMPERATURE", "0");

    const call = await capturedCall();

    expect(call.system).toContain("커밋 제목 안에 적힌 다른 PR 번호");
    expect(call.temperature).toBe(0);
    // 프로덕션 지시는 그대로 남아 있어야 합니다.
    expect(call.system).toContain("decisions 배열은 입력에 있는 PR 번호 전부를");
  });
});
