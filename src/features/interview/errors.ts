import type { ExperienceCandidateOutputErrorKind } from "@/features/experience-candidates/errors";

/**
 * 전송 계층에서만 생기는 오류 분류입니다.
 *
 * 생성 쪽 오류는 `ExperienceCandidateOutputErrorKind`를 그대로 실어 나르고 이 기능이 다시
 * 분류하지 않습니다. 여기 두 값은 기존 분류에 대응하는 값이 없어서 추가한 것입니다. 기존
 * `llm_*` 분류는 provider 호출에 대한 것이라서 브라우저와 서버 사이의 전송 실패에 붙이면 안
 * 됩니다.
 *
 * 두 값을 나눈 이유는 사용자에게 줄 안내가 다르기 때문입니다.
 * - `stream_connect_failed`: 아직 받은 내용이 없습니다. 자동 재시도를 하지 않습니다. 인증 실패나
 *   잘못된 요청처럼 같은 요청을 반복해도 풀리지 않는 원인이 섞여 있습니다.
 * - `stream_interrupted`: 이미 받은 내용이 있습니다. 지우지 않고 이어서 재연결을 시도합니다.
 */
export type InterviewStreamTransportErrorKind = "stream_connect_failed" | "stream_interrupted";

/**
 * route handler가 스트림을 시작하기 전에 거절할 때 쓰는 분류입니다. 값과 상태 코드는
 * `src/app/api/candidates/stage-a/route.ts`의 기존 규칙과 같습니다.
 */
export type InterviewStreamRequestErrorKind =
  | "unauthorized"
  | "invalid_json"
  | "invalid_request"
  | "body_too_large";

export type InterviewStreamErrorKind =
  | InterviewStreamTransportErrorKind
  | InterviewStreamRequestErrorKind
  | ExperienceCandidateOutputErrorKind;

/**
 * 스트림이 시작되기 전 HTTP 오류 본문으로 올 수 있는 분류입니다.
 *
 * `Record`로 둔 이유는 `ExperienceCandidateOutputErrorKind`에 값이 추가될 때 여기 빠뜨리면
 * 컴파일이 실패하게 하기 위해서입니다. 배열로 두면 새 분류가 조용히 누락되고, 그 오류는 다시
 * 전송 실패로 뭉개져서 사용자에게 틀린 안내가 나갑니다.
 */
const SERVER_ERROR_KINDS: Record<
  InterviewStreamRequestErrorKind | ExperienceCandidateOutputErrorKind,
  true
> = {
  unauthorized: true,
  invalid_json: true,
  invalid_request: true,
  body_too_large: true,
  json_parse: true,
  schema_validation: true,
  unknown_sha: true,
  unrelated_sha: true,
  unknown_file_path: true,
  llm_network: true,
  llm_auth: true,
  llm_rate_limit: true,
  llm_timeout: true,
  llm_configuration: true,
  llm_request: true,
  llm_failure: true,
};

/** 서버가 보낸 `error.kind`가 우리가 아는 분류인지 판별합니다. */
export function isServerErrorKind(value: unknown): value is InterviewStreamErrorKind {
  return typeof value === "string" && Object.hasOwn(SERVER_ERROR_KINDS, value);
}

export class InterviewStreamError extends Error {
  readonly kind: InterviewStreamErrorKind;
  /** 자동 재연결을 이미 다 쓴 뒤에도 사용자가 직접 다시 시도할 수 있는지 나타냅니다. */
  readonly retryable: boolean;

  constructor(
    kind: InterviewStreamErrorKind,
    message: string,
    options?: ErrorOptions & { retryable?: boolean }
  ) {
    super(message, options);
    this.name = "InterviewStreamError";
    this.kind = kind;
    this.retryable = options?.retryable ?? true;
  }
}

const TRANSPORT_MESSAGE: Record<InterviewStreamTransportErrorKind, string> = {
  stream_connect_failed: "질문 스트리밍 연결을 시작하지 못했습니다.",
  stream_interrupted: "질문을 받는 도중 연결이 끊겼습니다.",
};

export function transportError(
  kind: InterviewStreamTransportErrorKind,
  options?: ErrorOptions & { retryable?: boolean }
): InterviewStreamError {
  return new InterviewStreamError(kind, TRANSPORT_MESSAGE[kind], options);
}
