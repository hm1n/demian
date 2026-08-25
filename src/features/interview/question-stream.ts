import { isServerErrorKind } from "./errors";
import type { InterviewStreamErrorKind } from "./errors";
import type { InterviewQuestionStream } from "./question-generation";
import { encodeSseEvent } from "./sse";
import type { InterviewStreamEvent } from "./sse";

/**
 * 생성 쪽 오류의 분류를 그대로 옮깁니다. 전송 계층이 다시 분류하지 않습니다.
 *
 * 아는 분류가 아니면 `llm_failure`로 둡니다. 전송 실패 분류(`stream_*`)로 떨어뜨리면 안 됩니다.
 * 여기까지 온 실패는 연결이 이미 열려 있는 상태에서 생성 쪽에서 난 것이므로 전송 문제가 아닙니다.
 */
export function resolveGenerationErrorKind(error: unknown): InterviewStreamErrorKind {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return isServerErrorKind(kind) ? kind : "llm_failure";
}

/**
 * 생성 스트림을 SSE 본문으로 옮깁니다. 이벤트 계약은 이슈 #60이 확정한 것을 그대로 씁니다
 * (`wiki/2026-08-25-스트리밍-렌더링-측정과-전송-계약.md`).
 *
 * 첫 조각이 이미 손에 있으므로 `seq` 1로 바로 내보냅니다. 테스트용 스트림처럼 keep-alive 주석을
 * 먼저 보내지 않습니다. 그 주석은 첫 데이터가 늦을 때 프록시가 헤더를 붙들고 있는 것을 막기 위한
 * 것이고, 여기서는 첫 조각을 받은 뒤에야 응답을 시작하므로 붙들릴 시간이 없습니다.
 */
export function createQuestionSseStream(
  question: InterviewQuestionStream,
  options: { signal?: AbortSignal } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const aborted = () => options.signal?.aborted === true;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: InterviewStreamEvent) =>
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      // 이미 닫힌 스트림을 닫으면 예외가 납니다. 중단 경로에서도 반드시 닫아야 읽는 쪽이 영원히
      // 기다리지 않습니다.
      const finish = () => {
        try {
          controller.close();
        } catch {
          // 이미 닫혔습니다.
        }
      };
      let seq = 1;
      try {
        send({ type: "chunk", seq, text: question.firstText });
        for (;;) {
          const text = await question.next();
          if (text === null) break;
          if (aborted()) {
            finish();
            return;
          }
          seq += 1;
          send({ type: "chunk", seq, text });
        }
        send({ type: "done", seq });
        finish();
      } catch (error) {
        // 클라이언트가 먼저 끊으면 enqueue가 실패합니다. 알릴 상대가 없으므로 정상 종료로 둡니다.
        if (aborted()) {
          finish();
          return;
        }
        try {
          send({
            type: "error",
            kind: resolveGenerationErrorKind(error),
            message: error instanceof Error ? error.message : "질문 생성에 실패했습니다.",
          });
          finish();
        } catch {
          controller.error(error);
        }
      } finally {
        await question.close();
      }
    },
    async cancel() {
      await question.close();
    },
  });
}
