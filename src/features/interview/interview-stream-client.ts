import {
  InterviewStreamError,
  generationEmptyError,
  isServerErrorKind,
  transportError,
} from "./errors";
import { createSseEventParser } from "./sse";

export type InterviewStreamStatus =
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "done"
  | "error";

export interface InterviewStreamHandlers {
  onStatus?: (status: InterviewStreamStatus) => void;
  onChunk?: (chunk: { seq: number; text: string }) => void;
  onDone?: () => void;
  onError?: (error: InterviewStreamError) => void;
}

/**
 * 전송이 끊겼을 때 무엇을 하는지 정합니다.
 *
 * - `last-event-id`: `Last-Event-ID`로 마지막 `seq`를 보내 그 다음 청크부터 이어받습니다. 내용이
 *   결정적인 테스트용 스트림만 이 방식을 쓸 수 있습니다.
 * - `restart`: 이어받지 않습니다. 실제 LLM 스트림은 서버가 이미 보낸 청크를 보관하지 않아 `seq N`
 *   부터 이어 보낼 수 없고, 처음부터 다시 생성하면 같은 질문이 아니라 다른 질문이 나옵니다. 이미
 *   표시된 앞부분에 그 결과를 붙이면 한 메시지 안에서 서로 다른 질문이 이어집니다. 그래서 자동
 *   재연결을 하지 않고 사용자에게 결정을 넘깁니다. 근거는
 *   `wiki/2026-08-25-첫-질문-생성-provider-실측과-재개-방침.md`에 있습니다.
 */
export type InterviewStreamResumeMode = "last-event-id" | "restart";

export interface RunInterviewStreamOptions {
  url: string;
  /**
   * 보낼 요청 본문입니다. 있으면 `POST`로 보냅니다. 실제 생성 경로가 근거 스냅샷을 본문으로
   * 보내야 해서 필요합니다.
   */
  body?: string;
  resumeMode?: InterviewStreamResumeMode;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * 전송 도중 끊겼을 때의 자동 재연결 간격입니다. 배열 길이가 곧 최대 재시도 횟수입니다.
   *
   * 두 번으로 제한한 이유는 이 범위에 서버 지속 생성이 없기 때문입니다. 서버가 클라이언트 연결과
   * 무관하게 생성을 이어 가는 동작은 저장 계층과 사용자 식별자에 의존해서
   * `wiki/2026-08-24-경험선택-세션저장-후속-backlog.md`로 미뤄 두었습니다. 무한히 재시도해도
   * 이어받을 상태가 서버에 남아 있다고 보장할 수 없으므로 두 번 안에 붙지 않으면 사용자에게
   * 결정을 넘깁니다.
   */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * 이미 받은 마지막 `seq`입니다. 사용자가 직접 다시 시도할 때 이어받을 지점을 넘깁니다. 0이면
   * 처음부터 받습니다.
   */
  startSeq?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * 스트림이 시작되기 전에 실패한 응답을 오류로 바꿉니다.
 *
 * 본문의 `error.kind`를 읽는 이유는 이 시점의 실패가 전송 문제만이 아니기 때문입니다. 질문 생성
 * route는 첫 토큰 전에 나는 실패를 `stage-a`·`stage-b`와 같은 방식으로 HTTP 상태와 JSON 본문에
 * 실어 보냅니다(`llm_rate_limit` 503 등). 본문을 버리고 전송 실패로 뭉개면 한도 초과에
 * "네트워크 상태를 확인해 주세요"라는 틀린 안내가 나가고, 기다리면 풀리는 오류가 재시도 없이
 * 끝납니다.
 *
 * 본문이 없거나 아는 분류가 아니면 지금까지처럼 전송 실패로 둡니다.
 */
async function readResponseError(
  response: Response,
  lastSeq: number
): Promise<InterviewStreamError> {
  const fallback = () =>
    transportError(lastSeq === 0 ? "stream_connect_failed" : "stream_interrupted");
  if (typeof response.json !== "function") return fallback();
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { kind?: unknown; message?: unknown } } | null)?.error;
    if (!isServerErrorKind(error?.kind)) return fallback();
    const message = typeof error?.message === "string" ? error.message : undefined;
    return new InterviewStreamError(error.kind, message ?? fallback().message);
  } catch {
    return fallback();
  }
}

/**
 * SSE 스트림을 읽고 도착 순서대로 handler에 넘깁니다.
 *
 * `EventSource`를 쓰지 않는 이유는 세 가지입니다. 요청 헤더를 붙일 수 없고, POST를 보낼 수 없고,
 * 재연결 시점과 횟수를 제어할 수 없습니다. 이 기능은 재연결 횟수를 제한해야 하고 뒤에 붙을 질문
 * 생성 경로가 근거 스냅샷을 본문으로 보내야 합니다.
 */
export async function runInterviewStream(
  {
    url,
    body,
    resumeMode = "last-event-id",
    fetchImpl = fetch,
    signal,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    startSeq = 0,
  }: RunInterviewStreamOptions,
  handlers: InterviewStreamHandlers = {}
): Promise<void> {
  const resumes = resumeMode === "last-event-id";
  let lastSeq = resumes ? startSeq : 0;
  let retriesUsed = 0;

  const setStatus = (status: InterviewStreamStatus) => handlers.onStatus?.(status);
  const fail = (error: InterviewStreamError) => {
    handlers.onError?.(error);
    setStatus("error");
  };

  for (;;) {
    if (signal?.aborted) return;
    setStatus(lastSeq === 0 ? "connecting" : "reconnecting");

    try {
      const response = await fetchImpl(url, {
        signal,
        ...(body === undefined ? {} : { method: "POST", body }),
        headers: {
          Accept: "text/event-stream",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(resumes && lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : {}),
        },
      });
      if (!response.ok) {
        throw await readResponseError(response, lastSeq);
      }
      if (!response.body) {
        // 2xx인데 본문이 없습니다. 서버가 분류를 실어 보낼 자리가 없으므로 전송 실패로 둡니다.
        throw transportError(lastSeq === 0 ? "stream_connect_failed" : "stream_interrupted");
      }

      setStatus("streaming");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseEventParser();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.type === "chunk") {
            // 도착 순서를 서버 `seq`로 확인합니다. 건너뛴 번호가 있으면 이어붙인 결과가 실제
            // 응답과 달라지므로 화면에 붙이지 않고 단절로 처리합니다.
            if (event.seq !== lastSeq + 1) {
              await reader.cancel().catch(() => {});
              throw transportError("stream_interrupted");
            }
            lastSeq = event.seq;
            handlers.onChunk?.({ seq: event.seq, text: event.text });
            continue;
          }
          await reader.cancel().catch(() => {});
          if (event.type === "done") {
            // `done`이 도착했다는 사실은 완결의 대리 지표일 뿐입니다. 서버가 말한 마지막 `seq`와
            // 실제로 받은 `seq`가 다르면 중간 청크가 빠진 것이고, 그대로 완료로 두면 잘린 질문이
            // 완성된 것처럼 남습니다. 단절로 처리해야 `Last-Event-ID`로 빠진 지점부터 이어받습니다.
            if (event.seq !== lastSeq) {
              throw transportError("stream_interrupted");
            }
            // 청크 없이 `done`으로 끝난 스트림은 정상 완료가 아닙니다. 그대로 두면 빈 로그와
            // `질문이 모두 도착했습니다.` 안내가 함께 남고 다시 시도 버튼도 나타나지 않습니다.
            // Empty가 아니라 Error로 다루는 2026-08-25 결정입니다.
            if (lastSeq === 0) {
              throw generationEmptyError();
            }
            handlers.onDone?.();
            setStatus("done");
            return;
          }
          // 생성 쪽 오류는 분류를 그대로 전달합니다. 전송 계층이 다시 분류하지 않습니다.
          fail(new InterviewStreamError(event.kind, event.message));
          return;
        }
      }
      // `done` 없이 본문이 끝났습니다. 정상 종료와 구분해서 실패로 처리합니다.
      //
      // 청크를 하나도 받지 못한 채 끝난 경우까지 `stream_interrupted`로 두면 안 됩니다. 그 분류의
      // 안내는 "이미 받은 내용은 그대로 두었고, 다시 시도하면 받은 지점부터 이어받습니다"인데
      // 이어받을 내용이 없습니다. 재연결도 `Last-Event-ID` 없이 처음부터 받는 것이라 이어받기가
      // 아닙니다. 받은 청크가 있는지로 갈라야 안내와 실제 동작이 맞습니다.
      throw transportError(lastSeq === 0 ? "stream_connect_failed" : "stream_interrupted");
    } catch (error) {
      if (isAbort(error, signal)) return;
      const streamError =
        error instanceof InterviewStreamError
          ? error
          : transportError(lastSeq === 0 ? "stream_connect_failed" : "stream_interrupted", {
              cause: error,
            });

      // 시작 자체가 실패한 경우에는 자동으로 재시도하지 않습니다. 인증 실패나 잘못된 요청처럼
      // 같은 요청을 반복해도 풀리지 않는 원인이 섞여 있습니다.
      //
      // 이어받을 수 없는 스트림도 자동 재연결하지 않습니다. 재연결은 처음부터 다시 생성하는 것이고
      // 그 결과는 이미 표시된 내용과 다른 질문입니다.
      if (!resumes || streamError.kind !== "stream_interrupted" || retriesUsed >= retryDelaysMs.length) {
        fail(streamError);
        return;
      }
      await sleep(retryDelaysMs[retriesUsed]);
      retriesUsed += 1;
    }
  }
}
