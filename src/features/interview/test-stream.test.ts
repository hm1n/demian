import { describe, expect, it } from "vitest";
import { createSseEventParser } from "./sse";
import type { InterviewStreamEvent } from "./sse";
import {
  createTestStream,
  isTestStreamScenario,
  TEST_STREAM_CHUNKS,
  TEST_STREAM_INTERRUPT_AFTER_SEQ,
  type TestStreamScenario,
} from "./test-stream";

async function readEvents(options: {
  scenario: TestStreamScenario;
  startSeq?: number;
}): Promise<InterviewStreamEvent[]> {
  const stream = createTestStream({ ...options, delayMs: 0 });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseEventParser();
  const events: InterviewStreamEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  return events;
}

describe("isTestStreamScenario", () => {
  it("계약에 있는 값만 받아들인다", () => {
    expect(isTestStreamScenario("normal")).toBe(true);
    expect(isTestStreamScenario("interrupt")).toBe(true);
    expect(isTestStreamScenario("unknown")).toBe(false);
  });
});

describe("createTestStream", () => {
  it("normal은 seq가 1부터 1씩 늘고 done으로 끝난다", async () => {
    const events = await readEvents({ scenario: "normal" });

    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks.map((chunk) => chunk.seq)).toEqual(
      TEST_STREAM_CHUNKS.map((_, index) => index + 1)
    );
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(TEST_STREAM_CHUNKS.join(""));
    expect(events.at(-1)).toEqual({ type: "done", seq: TEST_STREAM_CHUNKS.length });
  });

  it("startSeq를 주면 그 다음 청크부터 이어서 보낸다", async () => {
    const events = await readEvents({ scenario: "normal", startSeq: 4 });

    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks[0]).toEqual({ type: "chunk", seq: 5, text: TEST_STREAM_CHUNKS[4] });
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(TEST_STREAM_CHUNKS.slice(4).join(""));
  });

  it("같은 seq는 언제 요청해도 같은 텍스트를 돌려준다", async () => {
    const first = await readEvents({ scenario: "normal" });
    const resumed = await readEvents({ scenario: "normal", startSeq: 3 });

    const textAt = (events: InterviewStreamEvent[], seq: number) =>
      events.find((event) => event.type === "chunk" && event.seq === seq);
    expect(textAt(resumed, 4)).toEqual(textAt(first, 4));
  });

  it("interrupt는 done 없이 끊긴다", async () => {
    const events = await readEvents({ scenario: "interrupt" });

    expect(events.filter((event) => event.type === "chunk")).toHaveLength(
      TEST_STREAM_INTERRUPT_AFTER_SEQ
    );
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("interrupt로 끊긴 뒤 이어받는 요청은 끝까지 보낸다", async () => {
    const events = await readEvents({
      scenario: "interrupt",
      startSeq: TEST_STREAM_INTERRUPT_AFTER_SEQ,
    });

    expect(events.at(-1)).toEqual({ type: "done", seq: TEST_STREAM_CHUNKS.length });
  });

  it("error는 기존 오류 분류를 그대로 실어 보낸다", async () => {
    const events = await readEvents({ scenario: "error" });

    const error = events.at(-1);
    expect(error?.type).toBe("error");
    expect(error).toMatchObject({ kind: "llm_rate_limit" });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("empty는 청크 없이 done만 보낸다", async () => {
    // 실제 생성 경로가 본문 없이 스트림을 끝내는 경우와 같은 모양입니다. 수신부가 이를 정상 완료가
    // 아니라 Error로 다루는지 검증하는 데 씁니다. 실제 생성은 비결정적이라 기준이 될 수 없습니다.
    const events = await readEvents({ scenario: "empty" });

    expect(events).toEqual([{ type: "done", seq: 0 }]);
  });
});
