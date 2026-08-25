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

/**
 * 생성은 성공으로 끝났는데 질문 본문이 한 조각도 없는 경우입니다.
 *
 * 전송 문제가 아니므로 `stream_connect_failed`도 `stream_interrupted`도 쓰지 않습니다. 둘의 안내는
 * 각각 "연결하지 못했다"와 "받는 도중 끊겼다"인데, 이 경우는 연결도 되고 끊기지도 않았습니다.
 * provider 호출도 실패하지 않았으므로 `llm_*` 어느 값도 맞지 않습니다.
 *
 * Empty가 아니라 Error로 다룹니다. 2026-08-25 결정이며 근거는
 * `llm-wiki/wiki/2026-08-25-스트리밍-후속-backlog.md` 1번 항목이 남긴 미결입니다. 사용자에게 빈
 * 화면과 `질문이 모두 도착했습니다.`를 함께 보여 주면 무엇이 잘못됐는지 알 방법이 없고 다시 시도
 * 버튼도 나타나지 않습니다.
 */
export type InterviewQuestionErrorKind = "generation_empty";

export type InterviewStreamErrorKind =
  | InterviewStreamTransportErrorKind
  | InterviewStreamRequestErrorKind
  | InterviewQuestionErrorKind
  | ExperienceCandidateOutputErrorKind;

/**
 * 스트림이 시작되기 전 HTTP 오류 본문으로 올 수 있는 분류입니다.
 *
 * `Record`로 둔 이유는 `ExperienceCandidateOutputErrorKind`에 값이 추가될 때 여기 빠뜨리면
 * 컴파일이 실패하게 하기 위해서입니다. 배열로 두면 새 분류가 조용히 누락되고, 그 오류는 다시
 * 전송 실패로 뭉개져서 사용자에게 틀린 안내가 나갑니다.
 */
const SERVER_ERROR_KINDS: Record<
  InterviewStreamRequestErrorKind | InterviewQuestionErrorKind | ExperienceCandidateOutputErrorKind,
  true
> = {
  unauthorized: true,
  invalid_json: true,
  invalid_request: true,
  body_too_large: true,
  generation_empty: true,
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

/**
 * 같은 근거를 다시 보내면 풀릴 수 있는 분류인지 나타냅니다.
 *
 * 기다리면 풀리는 실패(한도 초과, 시간 초과, 전송 실패, 모델 출력 흔들림)와 같은 입력으로는
 * 풀리지 않는 실패(서버 설정, 인증, 요청 형식, 크기 초과)를 갈라야 합니다. 두 갈래를 같은 문구로
 * 묶으면 한쪽에는 무의미한 재시도를 권하고 다른 쪽에는 할 수 있는 일을 알려 주지 않게 됩니다.
 *
 * `Record`로 둔 이유는 `SERVER_ERROR_KINDS`와 같습니다. 분류가 추가될 때 여기 빠뜨리면 컴파일이
 * 실패합니다. 조용히 누락되면 새 분류가 기본값으로 한쪽에 붙습니다.
 */
const RETRY_CLEARS: Record<InterviewStreamErrorKind, boolean> = {
  // 전송 실패는 네트워크가 회복되면 풀립니다.
  stream_connect_failed: true,
  stream_interrupted: true,
  // 생성이 비어 끝난 이유는 provider마다 다르고 같은 입력에서 늘 재현되지도 않습니다.
  generation_empty: true,
  // 모델 출력이 흔들린 실패입니다. 같은 입력이 시도마다 다른 출력을 내는 것이 실측입니다.
  json_parse: true,
  schema_validation: true,
  unknown_sha: true,
  unrelated_sha: true,
  unknown_file_path: true,
  llm_network: true,
  llm_rate_limit: true,
  llm_timeout: true,
  llm_failure: true,
  // 서버 쪽 설정과 자격 증명 문제입니다. 사용자가 다시 눌러도 같은 결과입니다.
  llm_auth: false,
  llm_configuration: false,
  // 근거 자체가 크거나 형식이 어긋난 경우입니다. 같은 근거로는 풀리지 않습니다.
  llm_request: false,
  invalid_json: false,
  invalid_request: false,
  body_too_large: false,
  // 세션을 다시 만들어야 합니다. 같은 세션으로 다시 보내면 같은 결과입니다.
  unauthorized: false,
};

/** 같은 근거로 다시 시도해서 풀릴 수 있는 실패인지 판별합니다. */
export function clearsOnRetry(kind: InterviewStreamErrorKind): boolean {
  return RETRY_CLEARS[kind];
}

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

export const GENERATION_EMPTY_MESSAGE = "질문을 만들지 못했습니다.";

/** 청크 없이 끝난 생성입니다. 서버와 수신부가 같은 문구를 쓰도록 여기 한 곳에 둡니다. */
export function generationEmptyError(options?: ErrorOptions): InterviewStreamError {
  return new InterviewStreamError("generation_empty", GENERATION_EMPTY_MESSAGE, options);
}
