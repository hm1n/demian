import { describe, expect, it } from "vitest";
import { InterviewStreamError } from "./errors";
import { createSseEventParser, encodeSseEvent, SSE_KEEP_ALIVE } from "./sse";

describe("encodeSseEvent", () => {
  it("청크는 id로 seq를 함께 실어 보낸다", () => {
    expect(encodeSseEvent({ type: "chunk", seq: 3, text: "안녕" })).toBe(
      'id: 3\nevent: chunk\ndata: {"seq":3,"text":"안녕"}\n\n'
    );
  });

  it("줄바꿈이 들어간 텍스트도 한 줄 data로 나간다", () => {
    const encoded = encodeSseEvent({ type: "chunk", seq: 1, text: "첫 줄\n둘째 줄" });
    expect(encoded.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
  });

  it("오류는 kind와 message를 담는다", () => {
    expect(encodeSseEvent({ type: "error", kind: "llm_rate_limit", message: "한도" })).toBe(
      'event: error\ndata: {"kind":"llm_rate_limit","message":"한도"}\n\n'
    );
  });
});

describe("createSseEventParser", () => {
  it("도착 순서대로 이벤트를 돌려준다", () => {
    const parser = createSseEventParser();
    const raw =
      encodeSseEvent({ type: "chunk", seq: 1, text: "가" }) +
      encodeSseEvent({ type: "chunk", seq: 2, text: "나" }) +
      encodeSseEvent({ type: "done", seq: 2 });

    expect(parser.push(raw)).toEqual([
      { type: "chunk", seq: 1, text: "가" },
      { type: "chunk", seq: 2, text: "나" },
      { type: "done", seq: 2 },
    ]);
  });

  it("이벤트 중간에서 끊긴 조각은 다음 조각과 이어 붙인다", () => {
    const parser = createSseEventParser();
    const raw = encodeSseEvent({ type: "chunk", seq: 1, text: "이어붙이기" });
    const cut = Math.floor(raw.length / 2);

    expect(parser.push(raw.slice(0, cut))).toEqual([]);
    expect(parser.push(raw.slice(cut))).toEqual([{ type: "chunk", seq: 1, text: "이어붙이기" }]);
  });

  it("연결 유지용 주석은 이벤트로 만들지 않는다", () => {
    expect(createSseEventParser().push(SSE_KEEP_ALIVE)).toEqual([]);
  });

  it("CRLF 줄바꿈도 처리한다", () => {
    const parser = createSseEventParser();
    const raw = encodeSseEvent({ type: "chunk", seq: 1, text: "윈도" }).replace(/\n/g, "\r\n");

    expect(parser.push(raw)).toEqual([{ type: "chunk", seq: 1, text: "윈도" }]);
  });

  it("계약에 없는 이벤트는 무시한다", () => {
    expect(createSseEventParser().push("event: ping\ndata: {}\n\n")).toEqual([]);
  });

  it("data가 JSON이 아니면 전송 중 단절로 처리한다", () => {
    const parser = createSseEventParser();

    expect(() => parser.push("event: chunk\ndata: {깨진\n\n")).toThrowError(InterviewStreamError);
    try {
      createSseEventParser().push("event: chunk\ndata: {깨진\n\n");
    } catch (error) {
      expect((error as InterviewStreamError).kind).toBe("stream_interrupted");
    }
  });
});
