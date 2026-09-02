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
  isAuthFailureResponseBody,
  isModelOutputFailureResponseBody,
  isRateLimitResponseBody,
} from "./errors";
import {
  createStageAModel,
  isLocalLlm,
  judgmentSamplingOptions,
  LLM_MAX_RETRIES,
  resolveLlmTimeoutMs,
  toLlmUsageSample,
  type LlmUsageSink,
} from "./llm-provider";
import type { StageACandidate, StageACandidateOutput } from "./types";
import { renderWorkUnitSummary, type WorkUnitSummary } from "./work-unit-summary";

// 2026-09-01에 Groq `openai/gpt-oss-120b`에서 옮겼습니다. 확정 근거와 탈락 사유는
// `llm-wiki/wiki/2026-09-01-네-경로-LLM-모델-확정.md`에 있습니다. 이 단계의 기준은 입력 PR 번호
// 전수 응답 계약이고, 실측에서 27묶음 전량에 대해 5회 모두 `27/27`을 지켰습니다. 첫 질문 생성이
// 같은 모델을 씁니다. 한도가 프로젝트별이면서 모델별이라 한 통을 공유하지만, 유료 등급 한도가
// RPM 4,000·분당 입력 4,000,000토큰이라 문제가 되지 않습니다.
export const STAGE_A_MODEL = "gemini-3.1-flash-lite";
export const INITIAL_STAGE_A_CANDIDATE_LIMIT = 20;
export const UNCLASSIFIED_LABEL = "미분류";
// 이슈 #19 실측으로 확정: 성공 호출은 3.1~11.1초, 계약 위반으로 끝난 호출도 29.0초였습니다.
// route maxDuration 60초보다 먼저 JSON 오류를 반환하는 시한으로 55초를 유지합니다.
export const STAGE_A_TIMEOUT_MS = 55_000;
/**
 * 복구 호출을 시작할 최소 잔여 예산입니다.
 *
 * 라우트는 계약 위반과 스키마 실패를 최대 3회까지 다시 시도합니다. 그 세 번이 각자 새 시한을 받고
 * 있어서 라우트 전체가 `STAGE_A_TIMEOUT_MS`의 세 배까지 늘어날 수 있었습니다. `maxDuration`이 60초라
 * 넘기면 플랫폼이 함수를 끊고, 그러면 우리가 정한 오류 계약 대신 생 504가 나갑니다. Stage B가
 * `STAGE_B_MIN_LLM_BUDGET_MS`로 같은 문제를 이미 막고 있고 이 값은 그 짝입니다.
 *
 * 12초로 정한 근거는 관측된 최대 성공 시간입니다. Gemini에서 2,042~3,590밀리초이고 Groq 시절
 * 이슈 #19 실측이 3.1~11.1초였습니다. 잔여가 이 값보다 적으면 복구를 시작해도 완주하지 못할
 * 가능성이 높으므로, 시작하지 않고 부분 결과로 저하시킵니다.
 */
export const STAGE_A_MIN_LLM_BUDGET_MS = 12_000;
/**
 * 한 청크가 모델에 보내는 프롬프트 바이트 상한입니다.
 *
 * 요청 본문이 아니라 접힌 묶음 문자열을 잽니다. 요청 본문은 구조화 요약이라 같은 내용이라도
 * 필드 이름과 따옴표 때문에 더 큽니다. 둘을 나눠서 잽니다.
 *
 * **`STAGE_A_MAX_SELECTION_BYTES`와 같은 값이어야 합니다.** 선별이 고른 결과가 그대로 한 요청에
 * 실려야 하므로 두 값이 어긋나면 선별 결과가 청크 둘로 갈립니다. 그러면 청크 사이 대기 경로가
 * 살아나는데, 그 대기는 Groq의 분당 토큰 창에서 나온 값이라 Gemini에서는 근거가 없습니다
 * (`STAGE_A_DEGRADED_WAIT_MS` 참고). 값과 재산정 근거는 `STAGE_A_MAX_SELECTION_BYTES`에 있습니다.
 *
 * 점수 선별이 입력을 이 상한 안으로 줄이므로 실측 저장소는 청크가 하나입니다. 청크 분할은
 * 선별이 예상보다 큰 입력을 넘길 때를 위한 안전장치로 남습니다.
 */
export const STAGE_A_MAX_PROMPT_BYTES = 110_000;
/**
 * 요청 본문 상한입니다.
 *
 * 구조화 요약의 필드 이름과 구분자 때문에 프롬프트보다 큽니다. 실측 배율은 `demian` 1.52,
 * `andbread` 1.25입니다. 프롬프트 상한 110,000에 최대 배율을 적용하면 167,200이라 여유를 둡니다.
 */
export const STAGE_A_MAX_REQUEST_BYTES = 176_000;
/**
 * 한 요청에 담을 작업 묶음 수 상한입니다.
 *
 * **이 값이 Stage A 입력의 실질 상한입니다.** 바이트 상한은 이 개수를 담을 수 있는 크기로
 * 맞춰 둔 값이고, 실제로 사용자가 겪는 제약은 개수입니다. 소요가 묶음 수에 선형으로 늘기
 * 때문입니다.
 *
 * **2026-09-02에 40에서 200으로 올렸습니다.** 그 전까지 이 값은 실측 없이 정한 여유였습니다.
 * 40은 `demian` 27묶음 위에 얹은 값이고, `andbread` 66묶음에서 곧바로 모자랐습니다. 상한을
 * 저장소 하나 위에 얹는 방식으로는 다음 저장소에서 같은 문제가 반복됩니다.
 *
 * 그래서 벽을 직접 쟀습니다(`llm-wiki/raw/2026-09-02-Stage-A-묶음-수-천장-실측.md`). 실제 묶음
 * 66개를 복제해 개수만 늘린 입력으로 전수 응답 계약을 확인했습니다.
 *
 * | 묶음 | 프롬프트 | 계약 | 소요 | 예산 55초 대비 |
 * | --- | --- | --- | --- | --- |
 * | 66 | 35,550바이트 | `66/66` | 6.3~7.0초 | 12.7% |
 * | 100 | 59,266바이트 | `100/100` | 13.1초 | 23.7% |
 * | 200 | 109,333바이트 | `200/200` | 17.1초 | 31.1% |
 * | 300 | 167,333바이트 | `300/300` | 24.5초 | 44.5% |
 * | 400 | 218,122바이트 | `400/400` | 30.7초 | 55.8% |
 *
 * **계약은 400에서도 깨지지 않았고 먼저 차는 것은 시간입니다.** 묶음당 약 75밀리초씩 늘어납니다.
 * 200을 고른 이유는 소요 17.1초가 예산의 31퍼센트여서 재시도 여유가 남고, 계약을 확인한 400의
 * 절반이라 관측 범위 안에 있기 때문입니다. 400묶음을 30초 기다려 후보 5개를 고르는 것이 사용자에게
 * 이득인지는 확인된 바가 없습니다.
 *
 * 이 측정은 복제 입력이라 **형식 계약만** 잰 것입니다. 서로 다른 실제 묶음 400개는 모델이 더
 * 어려워할 수 있고, 그것은 그만한 저장소가 있어야 잴 수 있습니다.
 *
 * 200을 넘는 저장소는 존재합니다. 그때 점수 선별이 상위 200묶음만 남기고, 남은 묶음에 왜 빠졌는지를
 * 화면이 알립니다. 상한을 넘는 것은 고장이 아니라 설계된 동작입니다.
 */
export const STAGE_A_MAX_UNITS = 200;
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
export const STAGE_A_CANDIDATE_QUOTA = 5;



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

/**
 * 모델에 실제로 보내는 프롬프트 본문(사용자 메시지)입니다.
 *
 * `createStageAGenerate`와 프롬프트 예산을 재는 라우트가 이 함수 하나로 같은 문자열을 보게
 * 합니다. 전에는 라우트가 이 문자열을 손으로 다시 계산했고, 그 계산이 기여 항목을 빠뜨려
 * 로컬 가드를 통과한 요청이 실제 프롬프트에서는 Groq 분당 토큰 한도를 넘겨 413을 받는
 * 결함(Codex 리뷰 P2-1)이 생겼습니다.
 *
 * 시스템 프롬프트는 여기 포함하지 않습니다. `STAGE_A_MAX_PROMPT_BYTES`는 실측 시점에 시스템
 * 프롬프트가 이미 실려 있던 호출에서 관측한 바이트당 토큰 비율(0.676)로 역산한 값이라 시스템
 * 프롬프트의 토큰 기여가 상한에 이미 녹아 있습니다. 여기서 시스템 프롬프트 글자 수를 더하면
 * 같은 기여를 두 번 반영하게 됩니다. 근거는
 * `llm-wiki/wiki/2026-08-25-Stage-A-청크-폐기와-점수-선별-전환.md` 6절입니다.
 */
export function renderStageAPrompt(payload: StageAPayload): string {
  return [
    payload.units.map(({ summary }) => summary).join("\n"),
    payload.contributionItems.length > 0
      ? `기여 항목:\n${payload.contributionItems.join("\n")}`
      : "",
  ]
    .filter((section) => section !== "")
    .join("\n\n");
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
    // Gemini는 잘못된 키를 401이 아니라 400 `INVALID_ARGUMENT`로 돌려줍니다. 본문의
    // `reason=API_KEY_INVALID`로 갈라야 요청 형식 오류와 섞이지 않습니다. 판별은 `errors.ts`에
    // 실측 근거와 함께 있습니다.
    if (
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      (error.statusCode === 400 && isAuthFailureResponseBody(error.responseBody))
    ) {
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
    // Gemini는 모델 과부하를 503 `UNAVAILABLE`로, 내부 오류를 500 `INTERNAL`로 돌려줍니다. Groq
    // 기준으로 배선했을 때는 이 갈래가 없어도 됐지만 flash 계열에서는 가장 흔한 일시 실패입니다.
    // 기다리면 풀리는 실패이므로 재시도 가능한 `llm_failure`로 두고, 문구에서 원인이 일시 장애임을
    // 밝힙니다. 504는 위에서 이미 시간 초과로 갈라 두었습니다.
    if ((error.statusCode ?? 0) >= 500) {
      return new ExperienceCandidateOutputError(
        "llm_failure",
        "LLM 서비스가 일시적으로 응답하지 못했습니다.",
        { cause: error }
      );
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

/**
 * 로컬 모델에만 붙이는 입력 범위 안내입니다. 프로덕션 프롬프트는 그대로 둡니다.
 *
 * 2026-08-25 실측입니다. 묶음 요약의 커밋 제목에는 `Merge pull request #35` 같은 문구가 섞여
 * 있습니다. `qwen2.5:7b`는 그 번호들을 판단 대상으로 끌어와 입력 11묶음에 대해 46개 판정을
 * 돌려줬고 `unknown_sha`로 끝났습니다. 같은 입력에서 `openai/gpt-oss-120b`는 이 혼동을 보이지
 * 않았으므로 프로덕션 프롬프트를 바꾸지 않고 로컬에서만 범위를 명시합니다.
 */
function localInputScopeHint(): string {
  if (!isLocalLlm()) return "";
  return [
    "",
    "",
    "판단 대상은 각 묶음 첫 줄의 'PR#번호'뿐입니다. 커밋 제목 안에 적힌 다른 PR 번호는 " +
      "판단 대상이 아니므로 decisions에 넣지 마세요. decisions의 길이는 입력 묶음 수와 정확히 " +
      "같아야 합니다.",
  ].join("\n");
}

/**
 * 모델 ID를 주입할 수 있게 열어 둡니다. 이슈 #19의 측정 스크립트가 후보 모델을 비교할 때 씁니다.
 *
 * `onUsage`는 측정용 통로입니다. 프로덕션은 넘기지 않습니다. 근거는 `LlmUsageSample`에 있습니다.
 */
export function createStageAGenerate(
  model: string = STAGE_A_MODEL,
  onUsage?: LlmUsageSink
): GenerateStageA {
  return async (payload, abortSignal) => {
    const { object, usage } = await generateObject({
      model: createStageAModel(model),
      schema: structuredOutputSchema,
      /**
       * 전수 응답 지시와 후보 상한을 문단으로 갈라 둡니다.
       *
       * 한 문단에 같이 두면 모델이 "최대 N개"를 "N개만 반환"으로 읽습니다. `gpt-oss-20b`에 묶음
       * 15개와 상한 5를 준 A/B 실측에서 기존 문구는 3회 모두 정확히 5개만 돌려줘 10개를
       * 빠뜨렸고, 문단을 가른 문구는 4회 중 3회가 15개를 전부 돌려줬습니다. 상한이 반환
       * 개수가 아니라 추천 개수에만 걸린다는 것을 명시해야 합니다.
       *
       * 2026-09-01에 선정 문단에 **하한과 입력의 성격**을 넣었습니다. 제공자를 Gemini로 옮긴 뒤
       * 후보를 0개 고르는 응답이 나왔습니다. 실데이터 같은 입력에서 `gemini-3.5-flash-lite`가 4회
       * 모두 0개, `gemini-3.1-flash-lite`가 6회 중 2회 0개였습니다. 상한만 있고 하한이 없었으며
       * 입력이 이미 점수로 걸러낸 상위 후보라는 사실이 프롬프트에 없어, 모델이 "고를 것이 없다"고
       * 답하는 것이 형식상 정상이었습니다. `gpt-oss-120b`는 같은 문구에서 5개를 골랐으므로 문구가
       * 그 모델에 맞춰져 있었습니다.
       *
       * 하한을 넣은 뒤 같은 입력에서 `gemini-3.5-flash-lite`가 5회 모두 5개,
       * `gemini-3.1-flash-lite`가 7회 모두 3개 이상을 골랐고 0개는 사라졌습니다. 로컬 전용 문구를
       * 프로덕션으로 올리는 방식은 효과가 없어 되돌렸습니다. 측정은
       * `llm-wiki/raw/2026-09-01-Stage-A-후보-선정-분산-측정.md`에 있습니다.
       */
      system:
        `Pull Request 단위 작업 묶음을 보고 개발 경험 후보를 선별하세요. 각 묶음은 'PR#번호 제목 [커밋수 기간 증감 파일수]'와 커밋 제목 목록, 변경량 상위 파일 경로로 이뤄집니다.

가장 중요한 규칙입니다. decisions 배열은 입력에 있는 PR 번호 전부를 하나도 빠뜨리지 않고 각각 정확히 한 번 담아야 합니다. 입력 묶음이 N개면 decisions도 반드시 N개입니다. 추천하지 않는 묶음도 반드시 담습니다.

각 묶음의 판정은 이렇게 씁니다. 기여 항목과 명확히 맞으면 contributionItem을 목록의 원문 그대로 씁니다. 어느 항목에도 맞지 않지만 설명할 가치가 있으면 contributionItem을 null로 두고 recommended를 true로 합니다. 그 밖에는 contributionItem을 '${UNCLASSIFIED_LABEL}'로 두고 recommended를 false로 합니다.

입력으로 들어온 묶음은 이미 저장소 전체에서 점수로 걸러낸 상위 후보입니다. 따라서 고를 것이 없는 입력이 아닙니다. recommended가 true이거나 기여 항목에 맞는 묶음을 합쳐서 최소 1개, 최대 ${payload.candidateLimit}개 고르세요. 이 상한은 고르는 개수에만 걸립니다. decisions 배열의 길이를 줄이는 데 쓰면 안 됩니다. 나머지 묶음은 전부 '${UNCLASSIFIED_LABEL}'로 담으세요. 고를 때는 규모가 큰 묶음보다 설명할 거리가 있는 묶음을 앞세우세요.` +
        localInputScopeHint(),
      prompt: renderStageAPrompt(payload),
      abortSignal,
      maxRetries: LLM_MAX_RETRIES,
      ...judgmentSamplingOptions(),
    });
    onUsage?.(toLlmUsageSample(usage));
    return object;
  };
}

// 프로덕션은 Gemini, 로컬 전환에서는 OpenAI 호환 엔드포인트로 갑니다. 제공자 이름을 여기 붙이지
// 않는 이유입니다. 2026-09-01까지 이 상수 이름이 `generateWithGroq`였습니다.
const defaultGenerate: GenerateStageA = createStageAGenerate();

export async function selectStageACandidates(
  input: StageAInput,
  generate: GenerateStageA = defaultGenerate,
  // 로컬 제공자일 때만 `LLM_TIMEOUT_MS`가 이 기본값을 대신합니다.
  timeoutMs = resolveLlmTimeoutMs(STAGE_A_TIMEOUT_MS)
): Promise<StageACandidateOutput> {
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
  return { candidates, unclassifiedShas, unjudgedShas: [] };
}
