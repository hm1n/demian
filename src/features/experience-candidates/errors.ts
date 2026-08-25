export type ExperienceCandidateOutputErrorKind =
  | "json_parse"
  | "schema_validation"
  | "unknown_sha"
  | "unrelated_sha"
  | "unknown_file_path"
  | "llm_network"
  | "llm_auth"
  | "llm_rate_limit"
  | "llm_timeout"
  | "llm_configuration"
  | "llm_request"
  | "llm_failure";

export class ExperienceCandidateOutputError extends Error {
  readonly kind: ExperienceCandidateOutputErrorKind;
  readonly unknownShas?: readonly string[];
  readonly missingShas?: readonly string[];
  readonly partialOutput?: import("./types").StageACandidateOutput;

  constructor(
    kind: ExperienceCandidateOutputErrorKind,
    message: string,
    options?: ErrorOptions & {
      unknownShas?: readonly string[];
      missingShas?: readonly string[];
      partialOutput?: import("./types").StageACandidateOutput;
    }
  ) {
    super(message, options);
    this.name = "ExperienceCandidateOutputError";
    this.kind = kind;
    this.unknownShas = options?.unknownShas;
    this.missingShas = options?.missingShas;
    this.partialOutput = options?.partialOutput;
  }
}

/**
 * 413 응답이 한도 초과인지 판별합니다. 413은 두 갈래이고 상태 코드만으로는 구분되지 않습니다.
 *
 * - 한도 초과: Groq는 분당 토큰(TPM) 초과를 429가 아니라 413으로 반환하고 본문에
 *   `rate_limit_exceeded`를 담습니다(이슈 #19 실측). 기다렸다 재시도하면 풀립니다.
 * - 요청 과대: 요청·컨텍스트 자체가 모델 한도보다 큰 413입니다. 같은 페이로드로는 몇 번을
 *   기다려도 풀리지 않으므로 재시도 안내(`llm_rate_limit`, 503)를 보내면 안 됩니다.
 *
 * 두 단계 모두 같은 규칙을 써야 하므로 판별을 여기 한 곳에 둡니다. provider SDK 타입에 묶이지
 * 않도록 본문 문자열만 받습니다.
 */
export function isRateLimitResponseBody(responseBody: string | undefined): boolean {
  return responseBody?.includes("rate_limit_exceeded") ?? false;
}

/**
 * 400이 모델 출력 실패인지 판별합니다.
 *
 * Groq는 구조화 출력에서 모델이 스키마를 맞추지 못하면 `json_validate_failed`를 담은 400을
 * 돌려줍니다. `type`이 `invalid_request_error`지만 요청은 멀쩡하고 실패한 것은 모델 출력입니다.
 * 요청 오류로 분류하면 재시도하면 풀릴 실패를 재시도 불가로 처리하게 됩니다.
 *
 * 실측: `openai/gpt-oss-20b`에 작업 묶음 15개를 보내면 전수 응답 위반과 이 400이 번갈아
 * 나왔습니다. 같은 입력을 다시 보내면 다른 결과가 나오므로 재시도 대상입니다.
 */
export function isModelOutputFailureResponseBody(responseBody: string | undefined): boolean {
  return responseBody?.includes("json_validate_failed") ?? false;
}
