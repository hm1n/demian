import { APICallError, LoadAPIKeyError, RetryError } from "ai";
import {
  ExperienceCandidateOutputError,
  isAuthFailureResponseBody,
  isRateLimitResponseBody,
} from "@/features/experience-candidates/errors";

/**
 * provider 호출 실패를 기존 `ExperienceCandidateOutputErrorKind`로 옮깁니다.
 *
 * 분류 체계를 새로 만들지 않습니다. 상태 코드별 대응은
 * `llm-wiki/wiki/2026-08-21-stage-a-선별-계약.md`의 표를 그대로 따릅니다. 스트리밍 호출이라
 * `NoObjectGeneratedError`(구조화 출력 실패)만 여기 없습니다. 첫 질문 생성은 자유 텍스트를
 * 받으므로 출력 스키마가 없습니다.
 *
 * 같은 매핑이 `stage-a.ts`와 `stage-b.ts`에도 있습니다. 세 번째 사본입니다. 두 파일은 이번 이슈의
 * 파일 경계 밖(`src/features/experience-candidates/`)이라 옮기지 못했고, 통합은 후속 항목으로
 * 남겼습니다. 사본을 늘리는 대신 이 파일을 인터뷰 기능의 단일 지점으로 두어 꼬리 질문이 같은
 * 함수를 쓰게 합니다.
 */
export function mapInterviewLlmError(
  error: unknown,
  context: string
): ExperienceCandidateOutputError {
  if (error instanceof ExperienceCandidateOutputError) return error;
  // SDK가 재시도한 실패는 `RetryError`로 감싸져 옵니다. `RetryError`는 `APICallError`가 아니므로
  // 벗기지 않으면 429·413 같은 한도가 전부 llm_failure로 뭉개집니다.
  if (RetryError.isInstance(error)) return mapInterviewLlmError(error.lastError, context);
  if (LoadAPIKeyError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "llm_configuration",
      "LLM API 키가 설정되지 않았습니다.",
      { cause: error }
    );
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new ExperienceCandidateOutputError("llm_timeout", `${context} 시간이 초과되었습니다.`, {
      cause: error,
    });
  }
  if (APICallError.isInstance(error)) {
    // Gemini는 잘못된 키를 401이 아니라 400 `INVALID_ARGUMENT`로 돌려줍니다. 갈라 두지 않으면 이
    // 실패가 `llm_request`로 가고, 첫 질문 화면이 그 분류에 붙여 둔 "근거가 크기를 넘었습니다"를
    // 띄웁니다. 판별은 `errors.ts`에 실측 근거와 함께 있습니다.
    if (
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      (error.statusCode === 400 && isAuthFailureResponseBody(error.responseBody))
    ) {
      return new ExperienceCandidateOutputError("llm_auth", "LLM 인증에 실패했습니다.", {
        cause: error,
      });
    }
    // 413은 상태 코드만으로 갈리지 않습니다. Groq는 분당 토큰 한도 초과를 429가 아니라 413
    // `rate_limit_exceeded`로 반환하지만, 요청·컨텍스트가 모델 한도보다 큰 경우도 413입니다.
    // 앞은 기다리면 풀리고 뒤는 같은 근거로는 풀리지 않아 사용자에게 줄 안내가 갈립니다.
    if (
      error.statusCode === 429 ||
      (error.statusCode === 413 && isRateLimitResponseBody(error.responseBody))
    ) {
      return new ExperienceCandidateOutputError("llm_rate_limit", "LLM 호출 한도에 도달했습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 413) {
      return new ExperienceCandidateOutputError(
        "llm_request",
        "질문 근거가 LLM이 받을 수 있는 크기를 넘었습니다.",
        { cause: error }
      );
    }
    if (error.statusCode === 408 || error.statusCode === 504) {
      return new ExperienceCandidateOutputError("llm_timeout", `${context} 시간이 초과되었습니다.`, {
        cause: error,
      });
    }
    if (error.statusCode === 404) {
      return new ExperienceCandidateOutputError(
        "llm_configuration",
        "LLM 모델 설정이 올바르지 않습니다.",
        { cause: error }
      );
    }
    // Gemini는 모델 과부하를 503 `UNAVAILABLE`로, 내부 오류를 500 `INTERNAL`로 돌려줍니다. Groq
    // 기준으로 배선했을 때는 이 갈래가 없어도 됐지만 flash 계열에서는 가장 흔한 일시 실패입니다.
    // 기다리면 풀리는 실패이므로 재시도 가능한 `llm_failure`로 두고, 문구에서 원인이 일시 장애임을
    // 밝힙니다. 504는 위에서 이미 시간 초과로 갈라 두었습니다.
    if ((error.statusCode ?? 0) >= 500) {
      return new ExperienceCandidateOutputError("llm_failure", "질문 생성 서비스가 일시적으로 응답하지 못했습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 422) {
      return new ExperienceCandidateOutputError("llm_request", "LLM이 요청을 거부했습니다.", {
        cause: error,
      });
    }
    return new ExperienceCandidateOutputError("llm_failure", `${context}에 실패했습니다.`, {
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new ExperienceCandidateOutputError("llm_network", "LLM에 연결하지 못했습니다.", {
      cause: error,
    });
  }
  return new ExperienceCandidateOutputError("llm_failure", `${context}에 실패했습니다.`, {
    cause: error,
  });
}
