import { InterviewStreamError } from "./errors";
import type { InterviewStreamErrorKind } from "./errors";

/**
 * 서버가 보내고 클라이언트가 읽는 SSE 이벤트 계약입니다. 계약을 한 곳에 두어 route handler와
 * 수신부가 같은 정의를 씁니다.
 *
 * `seq`는 1부터 1씩 늘어납니다. 재연결할 때 클라이언트가 `Last-Event-ID`로 마지막 `seq`를 보내면
 * 서버가 그 다음 청크부터 이어서 보냅니다.
 */
export type InterviewStreamEvent =
  | { type: "chunk"; seq: number; text: string }
  | { type: "done"; seq: number }
  | { type: "error"; kind: InterviewStreamErrorKind; message: string };

export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // 중간 프록시가 스트림을 모아 두었다가 한 번에 내보내면 스트리밍이 아니게 됩니다.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function encodeSseEvent(event: InterviewStreamEvent): string {
  if (event.type === "chunk") {
    const data = JSON.stringify({ seq: event.seq, text: event.text });
    return `id: ${event.seq}\nevent: chunk\ndata: ${data}\n\n`;
  }
  if (event.type === "done") {
    return `event: done\ndata: ${JSON.stringify({ seq: event.seq })}\n\n`;
  }
  return `event: error\ndata: ${JSON.stringify({ kind: event.kind, message: event.message })}\n\n`;
}

/** 연결 유지용 주석입니다. 데이터가 아니므로 파서가 이벤트로 만들지 않습니다. */
export const SSE_KEEP_ALIVE = ": keep-alive\n\n";

function parseRecord(record: string): InterviewStreamEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }
  if (eventName === "message" || dataLines.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch (cause) {
    throw new InterviewStreamError("stream_interrupted", "스트림 데이터를 해석하지 못했습니다.", {
      cause,
    });
  }
  const record_ = payload as Record<string, unknown>;
  if (eventName === "chunk" && typeof record_?.seq === "number" && typeof record_?.text === "string") {
    return { type: "chunk", seq: record_.seq, text: record_.text };
  }
  if (eventName === "done" && typeof record_?.seq === "number") {
    return { type: "done", seq: record_.seq };
  }
  if (eventName === "error" && typeof record_?.kind === "string" && typeof record_?.message === "string") {
    return { type: "error", kind: record_.kind as InterviewStreamErrorKind, message: record_.message };
  }
  // 계약에 없는 이벤트는 무시합니다. 서버가 나중에 이벤트를 추가해도 옛 클라이언트가 깨지지
  // 않아야 SSE를 쓰는 이점이 유지됩니다.
  return null;
}

/**
 * 조각난 SSE 텍스트를 이벤트로 바꿉니다. 네트워크 청크 경계는 이벤트 경계와 일치하지 않으므로
 * 완성되지 않은 마지막 레코드를 버퍼에 남깁니다.
 */
export function createSseEventParser(): { push(text: string): InterviewStreamEvent[] } {
  let buffer = "";
  return {
    push(text: string): InterviewStreamEvent[] {
      buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const events: InterviewStreamEvent[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseRecord(record);
        if (event) events.push(event);
        boundary = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}
