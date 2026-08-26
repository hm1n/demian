import { encodeSseEvent, SSE_KEEP_ALIVE } from "./sse";
import type { InterviewStreamEvent } from "./sse";

/**
 * 표시 기반을 검증하기 위한 테스트용 스트림입니다. **질문 생성 경로가 아닙니다.**
 *
 * 실제 생성 경로는 같은 route의 `POST`이고 `question-generation.ts`에 있습니다. 이 모듈은 대체되지
 * 않고 남습니다. 실제 생성은 비결정적이라 전송 계약 회귀 테스트의 기준으로 쓸 수 없고, 화면 개발도
 * 이 경로를 씁니다. 여기에 프롬프트나 모델 선택을 덧붙이지 말아 주세요.
 *
 * 내용은 결정적입니다. 같은 `seq`는 언제 요청해도 같은 텍스트를 돌려주므로 재연결 시 이어붙이기를
 * 검증할 수 있습니다.
 */
export const TEST_STREAM_SCENARIOS = ["normal", "slow", "interrupt", "error", "empty"] as const;

export type TestStreamScenario = (typeof TEST_STREAM_SCENARIOS)[number];

export function isTestStreamScenario(value: unknown): value is TestStreamScenario {
  return TEST_STREAM_SCENARIOS.includes(value as TestStreamScenario);
}

const TEST_MESSAGE = [
  "## 청크 경계를 세 조건으로 함께 닫은 이유",
  "",
  "`selectStageACandidates`는 커밋 8개, 경량 JSON 6,000바이트, 파일 32개 가운데 하나라도 다음 커밋에서 넘으면 그 직전에서 청크를 닫습니다.",
  "",
  "```ts",
  "for (const commit of commits) {",
  "  if (exceedsAnyLimit(current, commit)) {",
  "    chunks.push(current);",
  "    current = createChunk();",
  "  }",
  "  current.push(commit);",
  "}",
  "```",
  "",
  "세 조건 가운데 실제로 먼저 걸린 조건이 무엇이었는지 커밋 이력을 근거로 설명해 주세요. 다음 항목을 함께 다뤄 주세요.",
  "",
  "- 개수 상한만으로 부족했던 상황",
  "- 바이트 상한을 6,000으로 정한 근거",
  "- 파일 수 상한이 실제로 걸린 사례",
].join("\n");

/** SSE 청크 하나의 길이입니다. 측정에 쓴 24자와 같은 값을 씁니다. */
export const TEST_STREAM_CHUNK_SIZE = 24;

export const TEST_STREAM_CHUNKS: readonly string[] = (() => {
  const chunks: string[] = [];
  for (let offset = 0; offset < TEST_MESSAGE.length; offset += TEST_STREAM_CHUNK_SIZE) {
    chunks.push(TEST_MESSAGE.slice(offset, offset + TEST_STREAM_CHUNK_SIZE));
  }
  return chunks;
})();

/** `interrupt` 시나리오가 연결을 끊는 지점입니다. 재연결이 이어받는 것을 확인하려고 고정합니다. */
export const TEST_STREAM_INTERRUPT_AFTER_SEQ = 6;

export interface TestStreamOptions {
  scenario: TestStreamScenario;
  /** 이미 받은 마지막 `seq`입니다. 재연결 요청의 `Last-Event-ID`에서 옵니다. */
  startSeq?: number;
  /** 청크 사이 간격입니다. 테스트에서는 0으로 둡니다. */
  delayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTestStream({
  scenario,
  startSeq = 0,
  delayMs,
  signal,
  sleep = defaultSleep,
}: TestStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const interval = delayMs ?? (scenario === "slow" ? 60 : 8);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: InterviewStreamEvent) =>
        controller.enqueue(encoder.encode(encodeSseEvent(event)));

      try {
        // 첫 바이트를 바로 보내 프록시가 응답 헤더를 붙들고 있지 않도록 합니다.
        controller.enqueue(encoder.encode(SSE_KEEP_ALIVE));

        // 청크 없이 `done`으로 끝나는 스트림입니다. 실제 생성 경로에서 provider가 본문 없이
        // 스트림을 끝내는 경우와 같은 모양이고, 수신부가 이를 정상 완료가 아니라 Error로 다루는지
        // 검증하는 데 씁니다. 실제 생성은 비결정적이라 이 경로의 회귀 테스트 기준이 될 수 없습니다.
        if (scenario === "empty") {
          send({ type: "done", seq: 0 });
          controller.close();
          return;
        }

        for (let index = startSeq; index < TEST_STREAM_CHUNKS.length; index += 1) {
          if (signal?.aborted) return;
          const seq = index + 1;

          // 재연결로 다시 들어온 요청은 정상적으로 끝까지 보냅니다. 그래야 이어받기가 성공하는
          // 경로를 검증할 수 있습니다.
          if (scenario === "interrupt" && startSeq === 0 && seq > TEST_STREAM_INTERRUPT_AFTER_SEQ) {
            controller.close();
            return;
          }
          if (scenario === "error" && seq > TEST_STREAM_INTERRUPT_AFTER_SEQ) {
            send({
              type: "error",
              kind: "llm_rate_limit",
              message: "질문 생성 호출 한도에 걸렸습니다. 잠시 뒤에 다시 시도해 주세요.",
            });
            controller.close();
            return;
          }

          send({ type: "chunk", seq, text: TEST_STREAM_CHUNKS[index] });
          if (interval > 0) await sleep(interval);
        }
        send({ type: "done", seq: TEST_STREAM_CHUNKS.length });
        controller.close();
      } catch (error) {
        // 클라이언트가 먼저 끊으면 enqueue가 실패합니다. 정상 종료로 취급합니다.
        if (signal?.aborted) return;
        controller.error(error);
      }
    },
  });
}
