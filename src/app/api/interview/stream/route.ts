import type { NextRequest } from "next/server";
import { SSE_RESPONSE_HEADERS } from "@/features/interview/sse";
import {
  createTestStream,
  isTestStreamScenario,
  TEST_STREAM_CHUNKS,
  type TestStreamScenario,
} from "@/features/interview/test-stream";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 질문 스트리밍의 SSE 전송 계약을 구현합니다. 스트림 소스는 이슈 #60의 범위에 따라 테스트용
 * 스트림입니다. 실제 질문 생성 경로 배선은 이슈 #59에서 합니다.
 *
 * GitHub PAT 세션을 요구하지 않습니다. 다른 route가 세션을 요구하는 이유는 LLM 호출 비용이
 * 공개적으로 노출되는 것을 막기 위해서인데(`wiki/2026-08-21-stage-a-선별-계약.md`) 이 route는
 * LLM을 호출하지 않습니다. 실제 생성 경로가 붙는 시점에 같은 이유로 세션 경계를 함께 붙여야
 * 합니다.
 */
function invalidRequest(message: string): Response {
  return Response.json({ error: { kind: "invalid_request", message } }, { status: 422 });
}

/** `Last-Event-ID`는 클라이언트가 마지막으로 받은 `seq`입니다. 다음 청크부터 이어서 보냅니다. */
function readStartSeq(request: NextRequest): number | "invalid" {
  const raw = request.headers.get("Last-Event-ID");
  if (raw === null || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > TEST_STREAM_CHUNKS.length) return "invalid";
  return parsed;
}

export function handleInterviewStream(
  request: NextRequest,
  options?: { delayMs?: number; sleep?: (ms: number) => Promise<void> }
): Response {
  const scenarioParam = request.nextUrl.searchParams.get("scenario") ?? "normal";
  if (!isTestStreamScenario(scenarioParam)) {
    return invalidRequest("scenario 값이 올바르지 않습니다.");
  }
  const startSeq = readStartSeq(request);
  if (startSeq === "invalid") {
    return invalidRequest("Last-Event-ID 값이 올바르지 않습니다.");
  }

  const stream = createTestStream({
    scenario: scenarioParam as TestStreamScenario,
    startSeq,
    delayMs: options?.delayMs,
    sleep: options?.sleep,
    signal: request.signal,
  });
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
}

export function GET(request: NextRequest): Response {
  return handleInterviewStream(request);
}
