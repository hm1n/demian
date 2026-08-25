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

export type InterviewStreamErrorKind =
  | InterviewStreamTransportErrorKind
  | ExperienceCandidateOutputErrorKind;

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
