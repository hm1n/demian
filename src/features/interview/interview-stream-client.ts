import { InterviewStreamError, transportError } from "./errors";
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

export interface RunInterviewStreamOptions {
  url: string;
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
 * SSE 스트림을 읽고 도착 순서대로 handler에 넘깁니다.
 *
 * `EventSource`를 쓰지 않는 이유는 세 가지입니다. 요청 헤더를 붙일 수 없고, POST를 보낼 수 없고,
 * 재연결 시점과 횟수를 제어할 수 없습니다. 이 기능은 재연결 횟수를 제한해야 하고 뒤에 붙을 질문
 * 생성 경로가 근거 스냅샷을 본문으로 보내야 합니다.
 */
export async function runInterviewStream(
  {
    url,
    fetchImpl = fetch,
    signal,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    startSeq = 0,
  }: RunInterviewStreamOptions,
  handlers: InterviewStreamHandlers = {}
): Promise<void> {
  let lastSeq = startSeq;
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
        headers: {
          Accept: "text/event-stream",
          ...(lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : {}),
        },
      });
      if (!response.ok || !response.body) {
        // 응답 본문이 시작되기 전의 실패입니다. 이미 받은 내용이 있으면 전송 중 단절로 봅니다.
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
            handlers.onDone?.();
            setStatus("done");
            return;
          }
          // 생성 쪽 오류는 분류를 그대로 전달합니다. 전송 계층이 다시 분류하지 않습니다.
          fail(new InterviewStreamError(event.kind, event.message));
          return;
        }
      }
      // `done` 없이 본문이 끝났습니다. 정상 종료와 구분해서 단절로 처리합니다.
      throw transportError("stream_interrupted");
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
      if (streamError.kind !== "stream_interrupted" || retriesUsed >= retryDelaysMs.length) {
        fail(streamError);
        return;
      }
      await sleep(retryDelaysMs[retriesUsed]);
      retriesUsed += 1;
    }
  }
}
