import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createSseEventParser } from "@/features/interview/sse";
import type { InterviewStreamEvent } from "@/features/interview/sse";
import { TEST_STREAM_CHUNKS } from "@/features/interview/test-stream";
import { handleInterviewStream } from "./route";

function request(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/interview/stream${query}`, { headers });
}

async function readEvents(response: Response): Promise<InterviewStreamEvent[]> {
  const parser = createSseEventParser();
  const events: InterviewStreamEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  return events;
}

describe("handleInterviewStream", () => {
  it("SSE 응답 헤더를 붙인다", () => {
    const response = handleInterviewStream(request("?scenario=normal", {}), { delayMs: 0 });

    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("scenario 없이 요청하면 normal로 처리한다", async () => {
    const events = await readEvents(handleInterviewStream(request(), { delayMs: 0 }));

    expect(events.at(-1)).toEqual({ type: "done", seq: TEST_STREAM_CHUNKS.length });
  });

  it("계약에 없는 scenario는 422로 거절한다", async () => {
    const response = handleInterviewStream(request("?scenario=unknown"), { delayMs: 0 });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("Last-Event-ID로 이어받을 지점을 받는다", async () => {
    const events = await readEvents(
      handleInterviewStream(request("?scenario=normal", { "Last-Event-ID": "5" }), { delayMs: 0 })
    );

    const first = events.find((event) => event.type === "chunk");
    expect(first).toEqual({ type: "chunk", seq: 6, text: TEST_STREAM_CHUNKS[5] });
  });

  it("Last-Event-ID가 정수가 아니면 422로 거절한다", async () => {
    const response = handleInterviewStream(request("", { "Last-Event-ID": "six" }), { delayMs: 0 });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("Last-Event-ID가 전체 청크 수를 넘으면 422로 거절한다", async () => {
    const response = handleInterviewStream(
      request("", { "Last-Event-ID": String(TEST_STREAM_CHUNKS.length + 1) }),
      { delayMs: 0 }
    );

    expect(response.status).toBe(422);
  });

  it("error 시나리오는 스트림 안에서 오류 분류를 전달한다", async () => {
    const events = await readEvents(
      handleInterviewStream(request("?scenario=error"), { delayMs: 0 })
    );

    expect(events.at(-1)).toMatchObject({ type: "error", kind: "llm_rate_limit" });
  });
});
