import { describe, expect, it, vi } from "vitest";
import type { InterviewStreamError } from "./errors";
import { runInterviewStream, type InterviewStreamStatus } from "./interview-stream-client";
import { encodeSseEvent } from "./sse";

function sseResponse(body: string, init: { ok?: boolean; status?: number } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: init.ok === false ? null : stream,
  } as unknown as Response;
}

function collect() {
  const chunks: { seq: number; text: string }[] = [];
  const statuses: InterviewStreamStatus[] = [];
  const errors: InterviewStreamError[] = [];
  let done = false;
  return {
    chunks,
    statuses,
    errors,
    get done() {
      return done;
    },
    get text() {
      return chunks.map((chunk) => chunk.text).join("");
    },
    handlers: {
      onChunk: (chunk: { seq: number; text: string }) => chunks.push(chunk),
      onStatus: (status: InterviewStreamStatus) => statuses.push(status),
      onError: (error: InterviewStreamError) => errors.push(error),
      onDone: () => {
        done = true;
      },
    },
  };
}

const options = { url: "/api/interview/stream", sleep: async () => {} };

describe("runInterviewStream", () => {
  it("도착 순서대로 청크를 넘기고 done으로 끝낸다", async () => {
    const body =
      encodeSseEvent({ type: "chunk", seq: 1, text: "질" }) +
      encodeSseEvent({ type: "chunk", seq: 2, text: "문" }) +
      encodeSseEvent({ type: "done", seq: 2 });
    const sink = collect();

    await runInterviewStream(
      { ...options, fetchImpl: vi.fn().mockResolvedValue(sseResponse(body)) },
      sink.handlers
    );

    expect(sink.text).toBe("질문");
    expect(sink.done).toBe(true);
    expect(sink.statuses).toEqual(["connecting", "streaming", "done"]);
    expect(sink.errors).toEqual([]);
  });

  it("2xx가 아니면 연결 실패로 보고 자동 재시도하지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse("", { ok: false, status: 500 }));
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.errors.map((error) => error.kind)).toEqual(["stream_connect_failed"]);
    expect(sink.statuses.at(-1)).toBe("error");
  });

  it("전송 도중 끊기면 Last-Event-ID로 이어받아 재연결한다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          encodeSseEvent({ type: "chunk", seq: 1, text: "앞" }) +
            encodeSseEvent({ type: "chunk", seq: 2, text: "부분" })
        )
      )
      .mockResolvedValueOnce(
        sseResponse(
          encodeSseEvent({ type: "chunk", seq: 3, text: "뒷부분" }) +
            encodeSseEvent({ type: "done", seq: 3 })
        )
      );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers["Last-Event-ID"]).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1].headers["Last-Event-ID"]).toBe("2");
    expect(sink.text).toBe("앞부분뒷부분");
    expect(sink.statuses).toContain("reconnecting");
    expect(sink.done).toBe(true);
  });

  it("재연결을 다 쓰면 이미 받은 내용을 남긴 채 단절을 알린다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(encodeSseEvent({ type: "chunk", seq: 1, text: "앞" })));
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, retryDelaysMs: [0, 0] }, sink.handlers);

    // 최초 1회와 자동 재연결 2회입니다.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sink.errors.map((error) => error.kind)).toEqual(["stream_interrupted"]);
    expect(sink.chunks).not.toHaveLength(0);
  });

  it("seq를 건너뛰면 화면에 붙이지 않고 단절로 처리한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse(
        encodeSseEvent({ type: "chunk", seq: 1, text: "앞" }) +
          encodeSseEvent({ type: "chunk", seq: 3, text: "건너뜀" })
      )
    );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, retryDelaysMs: [] }, sink.handlers);

    expect(sink.text).toBe("앞");
    expect(sink.errors.map((error) => error.kind)).toEqual(["stream_interrupted"]);
  });

  it("생성 쪽 오류는 분류를 그대로 전달하고 재시도하지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse(
        encodeSseEvent({ type: "chunk", seq: 1, text: "앞" }) +
          encodeSseEvent({ type: "error", kind: "llm_rate_limit", message: "한도에 걸렸습니다." })
      )
    );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.errors[0].kind).toBe("llm_rate_limit");
    expect(sink.errors[0].message).toBe("한도에 걸렸습니다.");
    expect(sink.text).toBe("앞");
  });

  it("startSeq를 주면 첫 요청부터 이어받는다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse(
          encodeSseEvent({ type: "chunk", seq: 8, text: "이어받기" }) +
            encodeSseEvent({ type: "done", seq: 8 })
        )
      );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, startSeq: 7 }, sink.handlers);

    expect(fetchImpl.mock.calls[0][1].headers["Last-Event-ID"]).toBe("7");
    expect(sink.text).toBe("이어받기");
  });

  it("중단된 요청은 오류로 알리지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(""));
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, signal: controller.signal }, sink.handlers);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sink.errors).toEqual([]);
  });
});
