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
 *
 * **프로덕션 경로에서는 도달하지 않습니다.** 이 판별과 아래 `isModelOutputFailureResponseBody`는 둘
 * 다 Groq 본문 규약이고, 2026-09-01에 네 경로가 Gemini로 옮겼습니다. Gemini는 한도를 413으로 돌려주지
 * 않고, 구조화 출력 실패도 400이 아니라 SDK `NoObjectGeneratedError`로 옵니다. 남겨 두는 이유는
 * 로컬 전환이 `createGroq({ baseURL })`로 OpenAI 호환 엔드포인트를 가리키기 때문입니다.
 */
export function isRateLimitResponseBody(responseBody: string | undefined): boolean {
  return responseBody?.includes("rate_limit_exceeded") ?? false;
}

/**
 * 400이 자격 증명 실패인지 판별합니다.
 *
 * Groq는 잘못된 키를 401로 돌려주지만 **Gemini는 400 `INVALID_ARGUMENT`로 돌려줍니다.** 상태 코드만
 * 보면 요청 형식 오류와 구분되지 않습니다. 갈라 주는 값은 본문 `details`의
 * `google.rpc.ErrorInfo`에 실리는 `reason`이고, 잘못된 키에서는 `API_KEY_INVALID`입니다.
 *
 * 실측(2026-09-01, `scripts/measure-llm-errors.mts`)입니다. `gemini-3.1-flash-lite`에 잘못된 키를 보내면
 * 스트리밍과 구조화 출력 양쪽에서 400 `INVALID_ARGUMENT` `reason=[API_KEY_INVALID]`가 왔고,
 * 범위 밖 temperature를 보낸 400에는 `details`가 아예 없었습니다. 즉 이 문자열은 요청 형식 오류와
 * 겹치지 않습니다.
 *
 * 갈라야 하는 이유는 사용자에게 나가는 안내가 다르기 때문입니다. 갈라 두지 않으면 400이
 * `llm_request`로 가고, 첫 질문 화면은 그 분류에 "질문 근거가 질문 생성 서비스가 받을 수 있는 크기를
 * 넘었습니다"를 띄웁니다. 서버 키가 잘못됐을 때 근거를 줄이라고 안내하게 됩니다.
 *
 * 키 자체를 거부하는 403 `PERMISSION_DENIED`는 상태 코드로 이미 갈리므로 여기서 다루지 않습니다.
 */
export function isAuthFailureResponseBody(responseBody: string | undefined): boolean {
  return responseBody?.includes("API_KEY_INVALID") ?? false;
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
