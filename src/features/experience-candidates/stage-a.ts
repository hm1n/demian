import { createGroq } from "@ai-sdk/groq";
import {
  APICallError,
  generateObject,
  jsonSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  RetryError,
} from "ai";
import {
  ExperienceCandidateOutputError,
  isModelOutputFailureResponseBody,
  isRateLimitResponseBody,
} from "./errors";
import type { StageACandidate, StageAChunkOutput, StageARateLimit } from "./types";
import { renderWorkUnitSummary, type WorkUnitSummary } from "./work-unit-summary";

// 이슈 #19 실측(2026-08-24): 기존 `llama-3.3-70b-versatile`은 Groq 모델 목록에서 사라져 404를
// 반환했습니다. 현재 서빙 중인 구조화 출력 가능 모델 중 입력 SHA 전수 응답 계약을 가장 잘
// 지킨 모델입니다. 같은 조건에서 `openai/gpt-oss-20b`는 8개 입력에도 1/8만 응답했습니다.
export const STAGE_A_MODEL = "openai/gpt-oss-120b";
export const INITIAL_STAGE_A_CANDIDATE_LIMIT = 20;
export const UNCLASSIFIED_LABEL = "미분류";
// 이슈 #19 실측으로 확정: 성공 호출은 3.1~11.1초, 계약 위반으로 끝난 호출도 29.0초였습니다.
// route maxDuration 60초보다 먼저 JSON 오류를 반환하는 시한으로 55초를 유지합니다.
export const STAGE_A_TIMEOUT_MS = 55_000;
/**
 * 한 청크가 모델에 보내는 프롬프트 바이트 상한입니다.
 *
 * 요청 본문이 아니라 접힌 묶음 문자열을 잽니다. 요청 본문은 구조화 요약이라 같은 내용이라도
 * 필드 이름과 따옴표 때문에 더 큽니다. 둘을 나눠서 잽니다.
 *
 * 이 값을 정하는 것은 모델 컨텍스트가 아니라 Groq 무료 등급의 분당 토큰 한도(TPM) 8,000입니다.
 * `gpt-oss` 계열 컨텍스트는 131,072토큰이라 저장소 전체를 한 번에 넣고도 남습니다. 하지만 TPM을
 * 넘는 요청은 기다려도 통과하지 않습니다. 근거는 `STAGE_A_MAX_SELECTION_BYTES`에 있습니다.
 *
 * 점수 선별이 입력을 이 상한 안으로 줄이므로 실측 두 저장소 모두 청크가 하나입니다. 청크 분할은
 * 선별이 예상보다 큰 입력을 넘길 때를 위한 안전장치로 남습니다.
 */
export const STAGE_A_CHUNK_MAX_BYTES = 10_500;
/**
 * 요청 본문 상한입니다.
 *
 * 구조화 요약의 필드 이름과 구분자 때문에 프롬프트보다 큽니다. 실측 배율은 `demian` 1.52,
 * `andbread` 1.25입니다. 프롬프트 상한 10,500에 최대 배율을 적용하면 15,960이라 여유를 둡니다.
 */
export const STAGE_A_CHUNK_MAX_REQUEST_BYTES = 20_000;
/** 한 청크에 담을 작업 묶음 수 상한입니다. 바이트 상한보다 먼저 걸리는 경우를 막는 안전장치입니다. */
export const STAGE_A_CHUNK_MAX_UNITS = 20;
/**
 * 청크 하나가 추천할 수 있는 묶음 수입니다.
 *
 * 이 값이 재판단 라운드를 없앱니다. 이전에는 청크마다 전역 상한 20을 그대로 보내서 청크가
 * 14개면 실효 상한이 280개가 되었고, 넘친 후보를 다시 줄이려고 재판단 라운드를 돌았습니다.
 * 청크마다 쿼터를 고정하면 후보 수가 `청크 수 × 쿼터`로 결정되므로 넘칠 일이 없습니다.
 *
 * 점수 선별을 넣으면서 2에서 5로 올렸습니다. 선별 뒤에는 청크가 하나뿐이라 2로 두면 저장소당
 * 후보가 2개로 끝납니다. 5면 Stage B 커밋 상한 30을 나눠 후보당 6커밋이 실려 근거가 두터워집니다.
 */
export const STAGE_A_CHUNK_QUOTA = 5;
export const STAGE_A_TOKEN_RESERVE = 6_000;
export const STAGE_A_RESET_SAFETY_MS = 1_000;

/**
 * 청크 수가 많아 `청크 수 × 쿼터`가 전역 상한을 넘을 때 쿼터를 줄입니다. 상한을 넘는 응답을
 * 받아 놓고 다시 줄이는 대신 요청 단계에서 넘지 않게 만듭니다.
 */
export function resolveChunkQuota(chunkCount: number): number {
  if (chunkCount <= 0) return STAGE_A_CHUNK_QUOTA;
  return Math.max(
    1,
    Math.min(STAGE_A_CHUNK_QUOTA, Math.floor(INITIAL_STAGE_A_CANDIDATE_LIMIT / chunkCount))
  );
}

/**
 * Stage A가 판단하는 단위입니다.
 *
 * `representativeSha`는 이 묶음을 뒤 단계에서 가리키는 식별자입니다. 모델은 PR 번호로
 * 답하지만 후보 출력과 오류 보고는 SHA를 그대로 씁니다. Stage B와 화면이 커밋 SHA 기반이라
 * 식별자를 PR 번호로 바꾸면 파급이 큽니다.
 */
export interface StageAUnitInput {
  readonly pullRequestNumber: number;
  readonly representativeSha: string;
  readonly summary: WorkUnitSummary;
}

export interface StageAInput {
  readonly units: readonly StageAUnitInput[];
  readonly contributionItems: readonly string[];
  /** 이 청크가 추천할 수 있는 묶음 수입니다. 항상 보냅니다. */
  readonly candidateLimit: number;
}

interface StageADecision {
  readonly pullRequestNumber: number;
  readonly contributionItem: string | null;
  readonly recommended: boolean;
}

interface StageAStructuredOutput {
  readonly decisions: readonly StageADecision[];
  readonly __rateLimit?: StageARateLimit | null;
}

/** 모델에 실제로 보내는 형태입니다. 묶음은 이미 문자열로 접혀 있습니다. */
export interface StageAPayload {
  readonly units: readonly { readonly pullRequestNumber: number; readonly summary: string }[];
  readonly contributionItems: readonly string[];
  readonly candidateLimit: number;
}

export type GenerateStageA = (
  payload: StageAPayload,
  abortSignal: AbortSignal
) => Promise<unknown>;

const structuredOutputSchema = jsonSchema<StageAStructuredOutput>({
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pullRequestNumber", "contributionItem", "recommended"],
        properties: {
          pullRequestNumber: { type: "integer" },
          contributionItem: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          recommended: { type: "boolean" },
        },
      },
    },
  },
});

function validateStructuredOutput(value: unknown): StageAStructuredOutput {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { decisions?: unknown }).decisions) ||
    (value as { decisions: unknown[] }).decisions.some((decision) => {
      if (typeof decision !== "object" || decision === null) return true;
      const { pullRequestNumber, contributionItem, recommended } =
        decision as Partial<StageADecision>;
      return (
        Object.keys(decision).length !== 3 ||
        !Number.isInteger(pullRequestNumber) ||
        (contributionItem !== null &&
          (typeof contributionItem !== "string" || contributionItem.length === 0)) ||
        typeof recommended !== "boolean"
      );
    })
  ) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 구조화 응답이 출력 스키마와 일치하지 않습니다."
    );
  }
  return value as StageAStructuredOutput;
}

/**
 * 묶음을 문자열로 접어 모델 입력을 만듭니다.
 *
 * 렌더링을 서버에서 합니다. 클라이언트가 접은 문자열을 그대로 받으면 형식이 두 곳으로 갈리고
 * 요청 검증이 문자열 안을 들여다볼 수 없습니다.
 */
export function buildStageAPayload(input: StageAInput): StageAPayload {
  return {
    units: input.units.map((unit) => ({
      pullRequestNumber: unit.pullRequestNumber,
      summary: renderWorkUnitSummary(unit.summary),
    })),
    contributionItems: [...input.contributionItems],
    candidateLimit: input.candidateLimit,
  };
}

function mapLlmError(error: unknown): ExperienceCandidateOutputError {
  if (error instanceof ExperienceCandidateOutputError) return error;
  // SDK가 재시도한 실패는 `RetryError`로 감싸져 옵니다. `RetryError`는 `APICallError`가 아니므로
  // 벗기지 않으면 429·413 같은 한도와 재시도 대상 서버 오류가 전부 llm_failure로 뭉개집니다.
  // 이슈 #19 실측에서 실제로 한도 초과가 llm_failure로 보고됐습니다.
  if (RetryError.isInstance(error)) return mapLlmError(error.lastError);
  if (NoObjectGeneratedError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 구조화 응답이 출력 스키마와 일치하지 않습니다.",
      { cause: error }
    );
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "llm_configuration",
      "LLM API 키가 설정되지 않았습니다.",
      { cause: error }
    );
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new ExperienceCandidateOutputError("llm_timeout", "Stage A 분석 시간이 초과되었습니다.", {
      cause: error,
    });
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new ExperienceCandidateOutputError("llm_auth", "LLM 인증에 실패했습니다.", {
        cause: error,
      });
    }
    // 413도 한도일 수 있다. 이슈 #19 실측에서 Groq는 분당 토큰(TPM) 한도 초과를 429가 아니라
    // 413 `rate_limit_exceeded`로 반환했다. 다만 상태 코드만으로 한도로 단정하면 요청·컨텍스트가
    // 실제로 너무 큰 413에도 "기다렸다 재시도" 안내가 나가므로 본문으로 갈라 본다.
    if (
      error.statusCode === 429 ||
      (error.statusCode === 413 && isRateLimitResponseBody(error.responseBody))
    ) {
      return new ExperienceCandidateOutputError("llm_rate_limit", "LLM 호출 한도에 도달했습니다.", {
        cause: error,
      });
    }
    // 한도가 아닌 413은 페이로드가 모델 한도를 넘은 것이다. 같은 입력으로 재시도해도 풀리지 않아
    // 재시도 대상이 아닌 요청 오류로 분류한다.
    if (error.statusCode === 413) {
      return new ExperienceCandidateOutputError(
        "llm_request",
        "Stage A 입력이 LLM이 받을 수 있는 크기를 넘었습니다.",
        { cause: error }
      );
    }
    if (error.statusCode === 408 || error.statusCode === 504) {
      return new ExperienceCandidateOutputError("llm_timeout", "Stage A 분석 시간이 초과되었습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 404) {
      return new ExperienceCandidateOutputError("llm_configuration", "LLM 모델 설정이 올바르지 않습니다.", {
        cause: error,
      });
    }
    // 400이라도 본문에 `json_validate_failed`가 있으면 요청이 아니라 모델 출력이 실패한 것이다.
    // 같은 입력을 다시 보내면 다른 출력이 나오므로 스키마 검증 실패로 분류해 재시도에 맡긴다.
    if (error.statusCode === 400 && isModelOutputFailureResponseBody(error.responseBody)) {
      return new ExperienceCandidateOutputError(
        "schema_validation",
        "LLM이 형식에 맞는 응답을 만들지 못했습니다.",
        { cause: error }
      );
    }
    if (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 422) {
      return new ExperienceCandidateOutputError("llm_request", "LLM이 요청을 거부했습니다.", {
        cause: error,
      });
    }
    return new ExperienceCandidateOutputError("llm_failure", "Stage A 분석에 실패했습니다.", {
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new ExperienceCandidateOutputError("llm_network", "LLM에 연결하지 못했습니다.", {
      cause: error,
    });
  }
  return new ExperienceCandidateOutputError("llm_failure", "Stage A 분석에 실패했습니다.", {
    cause: error,
  });
}

/** 모델 ID를 주입할 수 있게 열어 둡니다. 이슈 #19의 측정 스크립트가 후보 모델을 비교할 때 씁니다. */
export function createStageAGenerate(model: string = STAGE_A_MODEL): GenerateStageA {
  return async (payload, abortSignal) => {
    const { object, response, usage } = await generateObject({
      model: createGroq()(model),
      schema: structuredOutputSchema,
      /**
       * 전수 응답 지시와 후보 상한을 문단으로 갈라 둡니다.
       *
       * 한 문단에 같이 두면 모델이 "최대 N개"를 "N개만 반환"으로 읽습니다. `gpt-oss-20b`에 묶음
       * 15개와 상한 5를 준 A/B 실측에서 기존 문구는 3회 모두 정확히 5개만 돌려줘 10개를
       * 빠뜨렸고, 문단을 가른 문구는 4회 중 3회가 15개를 전부 돌려줬습니다. 상한이 반환
       * 개수가 아니라 추천 개수에만 걸린다는 것을 명시해야 합니다.
       */
      system:
        `Pull Request 단위 작업 묶음을 보고 개발 경험 후보를 선별하세요. 각 묶음은 'PR#번호 제목 [커밋수 기간 증감 파일수]'와 커밋 제목 목록, 변경량 상위 파일 경로로 이뤄집니다.

가장 중요한 규칙입니다. decisions 배열은 입력에 있는 PR 번호 전부를 하나도 빠뜨리지 않고 각각 정확히 한 번 담아야 합니다. 입력 묶음이 N개면 decisions도 반드시 N개입니다. 추천하지 않는 묶음도 반드시 담습니다.

각 묶음의 판정은 이렇게 씁니다. 기여 항목과 명확히 맞으면 contributionItem을 목록의 원문 그대로 씁니다. 어느 항목에도 맞지 않지만 설명할 가치가 있으면 contributionItem을 null로 두고 recommended를 true로 합니다. 그 밖에는 contributionItem을 '${UNCLASSIFIED_LABEL}'로 두고 recommended를 false로 합니다.

recommended가 true이거나 기여 항목에 맞는 묶음은 합쳐서 최대 ${payload.candidateLimit}개까지만 고르세요. 이 상한은 고르는 개수에만 걸립니다. decisions 배열의 길이를 줄이는 데 쓰면 안 됩니다. 나머지 묶음은 전부 '${UNCLASSIFIED_LABEL}'로 담으세요. 규모가 크다는 이유만으로 고르지 말고 설명할 거리가 있는 묶음을 고르세요.`,
      prompt: [
        payload.units.map(({ summary }) => summary).join("\n"),
        payload.contributionItems.length > 0
          ? `기여 항목:\n${payload.contributionItems.join("\n")}`
          : "",
      ]
        .filter((section) => section !== "")
        .join("\n\n"),
      abortSignal,
    });
    const remaining = Number(response.headers?.["x-ratelimit-remaining-tokens"]);
    const reset = response.headers?.["x-ratelimit-reset-tokens"];
    const match = reset?.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
    const resetAfterMs = match
      ? Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000 }[match[2]] ?? 0)
      : Number.NaN;
    return {
      ...object,
      __rateLimit:
        Number.isFinite(remaining) && Number.isFinite(resetAfterMs)
          ? { remainingTokens: remaining, resetAfterMs, usedTokens: usage.totalTokens ?? 0 }
          : null,
    };
  };
}

const generateWithGroq: GenerateStageA = createStageAGenerate();

export async function selectStageACandidates(
  input: StageAInput,
  generate: GenerateStageA = generateWithGroq,
  timeoutMs = STAGE_A_TIMEOUT_MS
): Promise<StageAChunkOutput> {
  const payload = buildStageAPayload(input);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new DOMException("Stage A timeout", "TimeoutError")),
    timeoutMs
  );
  let output: StageAStructuredOutput;
  try {
    output = validateStructuredOutput(await generate(payload, abortController.signal));
  } catch (error) {
    throw mapLlmError(error);
  } finally {
    clearTimeout(timeout);
  }

  // 모델은 PR 번호로 답하지만 이 지점 이후로는 전부 대표 SHA로 옮깁니다. 뒤 단계와 오류 보고가
  // 커밋 SHA 기반이라 식별자를 두 종류로 들고 다니면 복구 경로가 갈라집니다.
  const shaByPullRequest = new Map(
    input.units.map(({ pullRequestNumber, representativeSha }) => [
      pullRequestNumber,
      representativeSha,
    ])
  );
  const returnedNumbers = output.decisions.map(({ pullRequestNumber }) => pullRequestNumber);
  const unknownNumbers = [
    ...new Set(returnedNumbers.filter((number) => !shaByPullRequest.has(number))),
  ];
  if (unknownNumbers.length > 0) {
    throw new ExperienceCandidateOutputError(
      "unknown_sha",
      `입력 집합에 없는 PR 번호가 포함되어 있습니다: ${unknownNumbers.map((number) => `#${number}`).join(", ")}`,
      { unknownShas: unknownNumbers.map((number) => `#${number}`) }
    );
  }
  if (new Set(returnedNumbers).size !== returnedNumbers.length) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 응답에 같은 PR 번호가 두 번 이상 포함되어 있습니다."
    );
  }
  const contributionItems = new Set(input.contributionItems);
  const candidates = output.decisions.flatMap<StageACandidate>((decision) => {
    const sha = shaByPullRequest.get(decision.pullRequestNumber)!;
    if (
      decision.contributionItem !== UNCLASSIFIED_LABEL &&
      decision.contributionItem !== null &&
      contributionItems.has(decision.contributionItem)
    ) {
      return [{
        sha,
        source: "contribution_match" as const,
        contributionItem: decision.contributionItem,
      }];
    }
    if (decision.recommended) {
      return [{ sha, source: "automatic_recommendation" as const, contributionItem: null }];
    }
    return [];
  });

  if (candidates.length > input.candidateLimit) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      `Stage A 후보는 요청 상한 ${input.candidateLimit}개를 넘을 수 없습니다.`
    );
  }

  const candidateShas = new Set(candidates.map(({ sha }) => sha));
  const unclassifiedShas = input.units
    .map(({ representativeSha }) => representativeSha)
    .filter((sha) => !candidateShas.has(sha));
  const returned = new Set(returnedNumbers);
  const missingShas = input.units
    .filter(({ pullRequestNumber }) => !returned.has(pullRequestNumber))
    .map(({ representativeSha }) => representativeSha);
  if (missingShas.length > 0) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 응답은 입력된 모든 PR 번호를 정확히 한 번 포함해야 합니다.",
      { missingShas, partialOutput: {
        candidates,
        unclassifiedShas: unclassifiedShas.filter((sha) => !missingShas.includes(sha)),
        unjudgedShas: [],
      } }
    );
  }
  return {
    candidates,
    unclassifiedShas,
    unjudgedShas: [],
    rateLimit: output.__rateLimit ?? null,
  };
}
