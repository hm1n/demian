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

/** route handler가 스트림을 시작하기 전에 거절할 때의 응답입니다. stage-a route와 같은 모양입니다. */
function errorResponse(status: number, error: { kind: string; message: string }): Response {
  return {
    ok: false,
    status,
    body: null,
    json: () => Promise.resolve({ error }),
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

  it("청크를 하나도 받지 못하고 끊기면 이어받기 안내를 쓰지 않는다", async () => {
    // 2xx로 열린 본문이 keep-alive만 보내고 닫힌 경우입니다. `stream_interrupted`로 두면 이어받을
    // 내용이 없는데도 "받은 지점부터 이어받습니다"라고 안내하게 됩니다.
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(": keep-alive\n\n"));
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, retryDelaysMs: [] }, sink.handlers);

    expect(sink.chunks).toEqual([]);
    expect(sink.errors.map((error) => error.kind)).toEqual(["stream_connect_failed"]);
    // 이어받을 지점이 없으므로 자동 재연결도 하지 않습니다.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("done의 seq가 실제로 받은 seq와 다르면 완료로 두지 않는다", async () => {
    // 청크 2·3이 빠진 채 done만 온 경우입니다. done 도착을 완결의 대리 지표로 쓰면 잘린 질문이
    // 완성된 것처럼 남습니다.
    const truncated =
      encodeSseEvent({ type: "chunk", seq: 1, text: "앞부분" }) +
      encodeSseEvent({ type: "done", seq: 3 });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(truncated));
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl, retryDelaysMs: [] }, sink.handlers);

    expect(sink.done).toBe(false);
    expect(sink.text).toBe("앞부분");
    expect(sink.errors.map((error) => error.kind)).toEqual(["stream_interrupted"]);
    expect(sink.statuses.at(-1)).toBe("error");
  });

  it("done의 seq가 맞으면 이어받은 스트림도 완료로 본다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(encodeSseEvent({ type: "chunk", seq: 1, text: "앞" })))
      .mockResolvedValue(
        sseResponse(
          encodeSseEvent({ type: "chunk", seq: 2, text: "뒤" }) +
            encodeSseEvent({ type: "done", seq: 2 })
        )
      );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(sink.done).toBe(true);
    expect(sink.text).toBe("앞뒤");
    expect(sink.errors).toEqual([]);
  });

  it("스트림 시작 전 오류는 서버가 보낸 분류와 문구를 그대로 전달한다", async () => {
    // 질문 생성 route는 첫 토큰 전에 나는 실패를 stage-a·stage-b와 같이 HTTP 상태와 JSON 본문에
    // 실어 보냅니다. 본문을 버리면 한도 초과에 네트워크 확인 안내가 나갑니다.
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(503, { kind: "llm_rate_limit", message: "질문 생성 호출 한도에 걸렸습니다." })
    );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.errors.map((error) => error.kind)).toEqual(["llm_rate_limit"]);
    expect(sink.errors[0].message).toBe("질문 생성 호출 한도에 걸렸습니다.");
  });

  it("route가 요청을 거절하면 그 분류를 전송 실패로 뭉개지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(422, { kind: "invalid_request", message: "Last-Event-ID 값이 올바르지 않습니다." })
    );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    expect(sink.errors.map((error) => error.kind)).toEqual(["invalid_request"]);
  });

  it("모르는 분류이거나 본문을 읽지 못하면 전송 실패로 둔다", async () => {
    const unknownKind = errorResponse(500, { kind: "made_up_kind", message: "…" });
    const brokenBody = {
      ok: false,
      status: 500,
      body: null,
      json: () => Promise.reject(new Error("본문 없음")),
    } as unknown as Response;
    const sink = collect();

    await runInterviewStream(
      { ...options, fetchImpl: vi.fn().mockResolvedValue(unknownKind) },
      sink.handlers
    );
    await runInterviewStream(
      { ...options, fetchImpl: vi.fn().mockResolvedValue(brokenBody) },
      sink.handlers
    );

    expect(sink.errors.map((error) => error.kind)).toEqual([
      "stream_connect_failed",
      "stream_connect_failed",
    ]);
  });

  it("이미 받은 뒤 재연결에서 생성 오류가 오면 재시도하지 않고 그 분류를 알린다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(encodeSseEvent({ type: "chunk", seq: 1, text: "질" })))
      .mockResolvedValue(
        errorResponse(503, { kind: "llm_rate_limit", message: "질문 생성 호출 한도에 걸렸습니다." })
      );
    const sink = collect();

    await runInterviewStream({ ...options, fetchImpl }, sink.handlers);

    // 첫 연결 + 재연결 한 번까지만 부릅니다. 기다려도 풀리지 않는 분류라 남은 재시도를 쓰지 않습니다.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sink.text).toBe("질");
    expect(sink.errors.map((error) => error.kind)).toEqual(["llm_rate_limit"]);
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
