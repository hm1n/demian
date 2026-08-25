"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InterviewStreamError } from "./errors";
import { runInterviewStream, type InterviewStreamStatus } from "./interview-stream-client";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";

export type InterviewStreamPhase = "idle" | InterviewStreamStatus;

export interface InterviewStreamMessage {
  id: string;
  text: string;
  /** 아직 도착 중인 메시지인지 여부입니다. 완료된 메시지는 다시 렌더하지 않습니다. */
  isStreaming: boolean;
}

export interface UseInterviewStreamOptions {
  url: string;
  /**
   * 첫 질문을 생성할 근거 스냅샷입니다.
   *
   * 있으면 `POST`로 스냅샷을 실어 실제 생성 경로를 씁니다. 없으면 지금까지처럼 `GET`으로 테스트용
   * 스트림을 받습니다. 두 경로의 재개 방침이 다릅니다. 테스트용 스트림은 내용이 결정적이라
   * `Last-Event-ID`로 이어받을 수 있지만 실제 생성 스트림은 이어받을 수 없습니다.
   */
  snapshot?: ExperienceEvidenceSnapshot;
  autoStart?: boolean;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** 테스트에서 프레임 스케줄러를 대체하기 위한 통로입니다. */
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface InterviewStreamState {
  messages: readonly InterviewStreamMessage[];
  status: InterviewStreamPhase;
  error: InterviewStreamError | null;
  /** 지금까지 도착한 청크 수입니다. 도착 순서 검증과 재연결 이어받기에 씁니다. */
  receivedSeq: number;
  start: () => void;
  retry: () => void;
}

const defaultScheduleFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => callback())
    : (setTimeout(callback, 0) as unknown as number);

const defaultCancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

/**
 * SSE 수신 결과를 화면 상태로 바꿉니다.
 *
 * 도착한 청크를 바로 반영하지 않고 애니메이션 프레임마다 모아서 한 번만 반영합니다. 측정 결과
 * 스트리밍 메시지의 재파싱 비용이 길이에 비례해서 커지는데(733자 0.53밀리초, 4,919자 2.94밀리초)
 * SSE 청크는 한 프레임 안에 여러 개가 도착할 수 있습니다. 프레임당 한 번으로 모으면 같은 프레임
 * 안에서 같은 파싱을 반복하지 않습니다. 버퍼는 도착 순서를 그대로 유지하므로 표시 순서는 달라지지
 * 않습니다.
 */
export function useInterviewStream({
  url,
  snapshot,
  autoStart = true,
  fetchImpl,
  retryDelaysMs,
  sleep,
  scheduleFrame = defaultScheduleFrame,
  cancelFrame = defaultCancelFrame,
}: UseInterviewStreamOptions): InterviewStreamState {
  const [messages, setMessages] = useState<readonly InterviewStreamMessage[]>([]);
  const [status, setStatus] = useState<InterviewStreamPhase>("idle");
  const [error, setError] = useState<InterviewStreamError | null>(null);
  const [receivedSeq, setReceivedSeq] = useState(0);

  const bufferRef = useRef<string[]>([]);
  // 프레임이 잡혀 있는지는 handle 값과 따로 둡니다. 스케줄러가 콜백을 동기로 실행하면 handle을
  // 돌려받기 전에 flush가 끝나므로 handle만으로는 예약 여부를 판별할 수 없습니다.
  const frameScheduledRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSeqRef = useRef(0);
  const optionsRef = useRef({
    url,
    snapshot,
    fetchImpl,
    retryDelaysMs,
    sleep,
    scheduleFrame,
    cancelFrame,
  });
  // 실행 중인 스트림이 최신 옵션을 보게 하되 옵션이 바뀔 때마다 스트림을 다시 시작하지는
  // 않습니다. ref 갱신은 렌더 도중이 아니라 렌더가 끝난 뒤에 합니다.
  useEffect(() => {
    optionsRef.current = { url, snapshot, fetchImpl, retryDelaysMs, sleep, scheduleFrame, cancelFrame };
  });

  const flush = useCallback(() => {
    frameScheduledRef.current = false;
    frameRef.current = null;
    const appended = bufferRef.current.join("");
    bufferRef.current = [];
    if (appended === "") return;
    setMessages((previous) => {
      const last = previous[previous.length - 1];
      if (last?.isStreaming) {
        return [...previous.slice(0, -1), { ...last, text: last.text + appended }];
      }
      return [...previous, { id: `message-${previous.length + 1}`, text: appended, isStreaming: true }];
    });
    setReceivedSeq(lastSeqRef.current);
  }, []);

  const flushNow = useCallback(() => {
    if (frameScheduledRef.current && frameRef.current !== null) {
      optionsRef.current.cancelFrame(frameRef.current);
    }
    flush();
  }, [flush]);

  const completeStreamingMessage = useCallback(() => {
    setMessages((previous) => {
      const last = previous[previous.length - 1];
      if (!last?.isStreaming) return previous;
      return [...previous.slice(0, -1), { ...last, isStreaming: false }];
    });
  }, []);

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const current = optionsRef.current;
    void runInterviewStream(
      {
        url: current.url,
        ...(current.snapshot === undefined
          ? {}
          : {
              body: JSON.stringify({ snapshot: current.snapshot }),
              resumeMode: "restart" as const,
            }),
        fetchImpl: current.fetchImpl,
        signal: controller.signal,
        retryDelaysMs: current.retryDelaysMs,
        sleep: current.sleep,
        startSeq: lastSeqRef.current,
      },
      {
        onStatus: (next) => {
          if (!controller.signal.aborted) setStatus(next);
        },
        onChunk: ({ seq, text }) => {
          lastSeqRef.current = seq;
          bufferRef.current.push(text);
          if (!frameScheduledRef.current) {
            frameScheduledRef.current = true;
            frameRef.current = current.scheduleFrame(() => flush());
          }
        },
        onDone: () => {
          flushNow();
          completeStreamingMessage();
        },
        onError: (streamError) => {
          // 이미 도착한 내용은 지우지 않습니다. 버퍼에 남은 청크도 화면에 반영한 뒤 알립니다.
          flushNow();
          setError(streamError);
        },
      }
    );
  }, [completeStreamingMessage, flush, flushNow]);

  // 이전 오류 표시는 사용자가 다시 시도할 때 지웁니다. 자동 재연결 중에는 오류를 표시하지 않으므로
  // 지울 것도 없습니다.
  const retry = useCallback(() => {
    setError(null);
    // 실제 생성 경로는 이어받을 수 없으므로 다시 시도가 처음부터 다시 생성합니다. 이미 표시된
    // 앞부분을 남겨 두면 새 생성 결과가 그 뒤에 붙어 한 메시지 안에서 서로 다른 질문이 이어집니다.
    if (optionsRef.current.snapshot !== undefined) {
      lastSeqRef.current = 0;
      bufferRef.current = [];
      setMessages([]);
      setReceivedSeq(0);
    }
    start();
  }, [start]);

  useEffect(() => {
    if (autoStart) start();
    return () => {
      abortRef.current?.abort();
      if (frameScheduledRef.current && frameRef.current !== null) {
        optionsRef.current.cancelFrame(frameRef.current);
      }
      frameScheduledRef.current = false;
      frameRef.current = null;
    };
  }, [autoStart, start]);

  return { messages, status, error, receivedSeq, start, retry };
}
