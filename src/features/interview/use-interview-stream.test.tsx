// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeSseEvent } from "./sse";
import { useInterviewStream } from "./use-interview-stream";

afterEach(cleanup);

function controllableResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: { ok: true, status: 200, body: stream } as unknown as Response,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      controller.close();
    },
  };
}

describe("useInterviewStream", () => {
  it("한 프레임 안에 도착한 청크를 모아 한 번만 반영한다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);
    const frames: (() => void)[] = [];
    const scheduleFrame = vi.fn((callback: () => void) => frames.push(callback));

    const { result } = renderHook(() =>
      useInterviewStream({
        url: "/api/interview/stream",
        fetchImpl,
        sleep: async () => {},
        scheduleFrame: (callback) => scheduleFrame(callback),
        cancelFrame: () => {},
      })
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    await act(async () => {
      source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "가" }));
      source.push(encodeSseEvent({ type: "chunk", seq: 2, text: "나" }));
      source.push(encodeSseEvent({ type: "chunk", seq: 3, text: "다" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(scheduleFrame).toHaveBeenCalledTimes(1));
    expect(result.current.messages).toHaveLength(0);

    await act(async () => {
      frames.forEach((frame) => frame());
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].text).toBe("가나다");
    expect(result.current.receivedSeq).toBe(3);
  });

  it("done이 오면 프레임을 기다리지 않고 남은 청크까지 반영하고 메시지를 닫는다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    const { result } = renderHook(() =>
      useInterviewStream({
        url: "/api/interview/stream",
        fetchImpl,
        sleep: async () => {},
        // 프레임을 영영 실행하지 않아도 done이 남은 청크를 반영해야 합니다.
        scheduleFrame: () => 0,
        cancelFrame: () => {},
      })
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "마지막 청크" }));
    source.push(encodeSseEvent({ type: "done", seq: 1 }));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({ text: "마지막 청크", isStreaming: false });
    expect(result.current.status).toBe("done");
  });

  it("오류가 나도 버퍼에 남은 청크를 화면에 반영한다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    const { result } = renderHook(() =>
      useInterviewStream({
        url: "/api/interview/stream",
        fetchImpl,
        sleep: async () => {},
        retryDelaysMs: [],
        scheduleFrame: () => 0,
        cancelFrame: () => {},
      })
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "받은 내용" }));
    source.close();

    await waitFor(() => expect(result.current.error?.kind).toBe("stream_interrupted"));
    expect(result.current.messages[0].text).toBe("받은 내용");
  });
});
