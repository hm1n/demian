"use client";

import { useId } from "react";
import { clearsOnRetry } from "./errors";
import type { InterviewStreamErrorKind, InterviewStreamRequestErrorKind } from "./errors";
import { InterviewMessage } from "./interview-message";
import { useAutoScroll } from "./use-auto-scroll";
import { useInterviewStream, type InterviewStreamPhase, type UseInterviewStreamOptions } from "./use-interview-stream";
import styles from "./interview-stream-view.module.css";

export const DEFAULT_INTERVIEW_STREAM_URL = "/api/interview/stream";

const STATUS_TEXT: Record<InterviewStreamPhase, string> = {
  idle: "질문 스트리밍을 아직 시작하지 않았습니다.",
  connecting: "질문 스트리밍에 연결하고 있습니다.",
  streaming: "질문이 도착하는 중입니다.",
  reconnecting: "연결이 끊겨 다시 연결하고 있습니다. 이미 받은 내용은 그대로 둡니다.",
  done: "질문이 모두 도착했습니다.",
  error: "질문을 받지 못했습니다.",
};

/**
 * 스트림이 시작되기 전 서버가 거절한 경우입니다. 다시 시도해서 풀리는 것과 아닌 것을 구분해
 * 알립니다.
 */
const REQUEST_ERROR_GUIDANCE: Partial<Record<InterviewStreamRequestErrorKind, string>> = {
  unauthorized: "GitHub 인증 세션이 필요합니다. 다시 로그인한 뒤 시도해 주세요.",
  invalid_request: "요청 형식이 올바르지 않습니다. 다시 시도해도 같은 결과가 나오면 화면을 새로 고쳐 주세요.",
  invalid_json: "요청 형식이 올바르지 않습니다. 다시 시도해도 같은 결과가 나오면 화면을 새로 고쳐 주세요.",
  body_too_large: "질문 근거가 한 번에 보낼 수 있는 크기를 넘었습니다. 다시 시도해도 같은 결과가 나옵니다.",
};

/**
 * 생성 쪽 실패의 안내입니다. 기다리면 풀리는 실패와 같은 근거로는 풀리지 않는 실패를 같은 문구로
 * 묶지 않습니다. 어느 쪽인지는 `clearsOnRetry`가 한 곳에서 정합니다.
 */
const GENERATION_ERROR_GUIDANCE: Partial<Record<InterviewStreamErrorKind, string>> = {
  generation_empty:
    "질문 내용이 한 조각도 오지 않았습니다. 아직 받은 내용은 없습니다. 다시 시도하면 같은 근거로 질문을 새로 만듭니다.",
  llm_rate_limit:
    "질문 생성 호출 한도에 걸렸습니다. 이미 받은 내용은 그대로 두었습니다. 잠시 뒤에 다시 시도해 주세요.",
  llm_timeout: "질문 생성이 시간 안에 끝나지 않았습니다. 잠시 뒤에 다시 시도해 주세요.",
  llm_network: "질문 생성 서비스에 연결하지 못했습니다. 잠시 뒤에 다시 시도해 주세요.",
  llm_auth:
    "질문 생성 서비스 인증에 실패했습니다. 서버 설정 문제이므로 다시 시도해도 같은 결과가 나옵니다.",
  llm_configuration:
    "질문 생성 서비스 설정에 문제가 있습니다. 다시 시도해도 같은 결과가 나옵니다.",
  llm_request:
    "질문 근거가 질문 생성 서비스가 받을 수 있는 크기를 넘었습니다. 다시 시도해도 같은 결과가 나옵니다.",
};

/**
 * 오류마다 사용자가 무엇을 할 수 있는지 달라지므로 안내를 따로 둡니다. `aria-label`로 버튼 이름만
 * 바꾸지 않고 `aria-describedby`로 이 내용을 노출합니다.
 *
 * `resumable`은 끊긴 지점부터 이어받을 수 있는 스트림인지입니다. 실제 생성 스트림은 이어받을 수
 * 없어 다시 시도가 처음부터 새로 만드는 것이 되므로 같은 분류라도 안내가 달라집니다.
 */
function errorGuidance(kind: InterviewStreamErrorKind, resumable: boolean): string {
  if (kind === "stream_connect_failed") {
    return "연결을 시작하지 못했습니다. 아직 받은 내용은 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  }
  if (kind === "stream_interrupted") {
    return resumable
      ? "자동으로 두 번 다시 연결했지만 실패했습니다. 이미 받은 내용은 그대로 두었고, 다시 시도하면 받은 지점부터 이어받습니다."
      : "질문을 받는 도중 연결이 끊겼습니다. 이 스트림은 끊긴 지점부터 이어받을 수 없어, 다시 시도하면 같은 근거로 질문을 처음부터 새로 만듭니다. 지금까지 받은 내용은 사라집니다.";
  }
  const requestGuidance = REQUEST_ERROR_GUIDANCE[kind as InterviewStreamRequestErrorKind];
  if (requestGuidance) return requestGuidance;
  const generationGuidance = GENERATION_ERROR_GUIDANCE[kind];
  if (generationGuidance) return generationGuidance;
  return clearsOnRetry(kind)
    ? "질문을 만드는 중에 오류가 발생했습니다. 이미 받은 내용은 그대로 두었습니다. 다시 시도해 주세요."
    : "질문을 만드는 중에 오류가 발생했습니다. 다시 시도해도 같은 결과가 나옵니다.";
}

export interface InterviewStreamViewProps extends Partial<UseInterviewStreamOptions> {
  url?: string;
}

/**
 * 질문 스트리밍의 표시 기반입니다.
 *
 * `snapshot`을 주면 실제 생성 경로를 씁니다. 근거 스냅샷을 `POST` 본문으로 보내고, 끊겼을 때
 * 이어받지 않습니다. 주지 않으면 테스트용 스트림을 `GET`으로 받고 이어받기도 그대로 동작합니다.
 */
export function InterviewStreamView({
  url = DEFAULT_INTERVIEW_STREAM_URL,
  ...streamOptions
}: InterviewStreamViewProps = {}) {
  const { messages, status, error, receivedSeq, retry } = useInterviewStream({ url, ...streamOptions });
  const { containerRef, hasUnreadContent, scrollToBottom, handleScroll } =
    useAutoScroll<HTMLDivElement>(receivedSeq);

  const baseId = useId();
  const statusId = `${baseId}-status`;
  const unreadId = `${baseId}-unread`;
  const errorId = `${baseId}-error`;

  const isPreparing = messages.length === 0 && (status === "connecting" || status === "idle");

  return (
    <section className={styles.stream} aria-label="AI 질문 스트리밍">
      <div
        ref={containerRef}
        className={styles.log}
        role="log"
        // 스트리밍 중에는 메시지 하나의 텍스트가 프레임마다 자라납니다. 이 자리를 live region으로
        // 두면 스크린리더가 커지는 질문 전체를 프레임마다 다시 읽습니다. `role="log"`는 완성된
        // 메시지가 하나씩 추가되는 패턴을 전제하므로 여기에는 맞지 않습니다. 낭독은 아래 상태
        // 문단과 새 메시지 안내가 담당합니다.
        aria-live="off"
        aria-busy={status === "connecting" || status === "streaming" || status === "reconnecting"}
        aria-describedby={statusId}
        tabIndex={0}
        onScroll={handleScroll}
      >
        {isPreparing ? <p className={styles.preparing}>질문을 준비하고 있습니다.</p> : null}
        {messages.map((message) => (
          <InterviewMessage key={message.id} text={message.text} isStreaming={message.isStreaming} />
        ))}
      </div>

      {/* 상태 전이를 낭독하는 자리입니다. 처음부터 붙어 있어야 스크린리더가 변경을 잡습니다. */}
      <p id={statusId} className={styles.status} aria-live="polite">
        {STATUS_TEXT[status]}
      </p>

      {/*
        안내 문단을 조건부로 만들지 않고 항상 두고 내용만 비웁니다. live region은 붙어 있는 동안의
        변경만 알리므로, 내용을 담은 채 새로 나타나면 낭독되지 않는 스크린리더가 있습니다.
      */}
      {hasUnreadContent ? (
        <button
          type="button"
          className={styles.unreadButton}
          onClick={scrollToBottom}
          aria-describedby={unreadId}
        >
          새 메시지 보기
        </button>
      ) : null}
      <p id={unreadId} className={styles.unreadNotice} aria-live="polite">
        {hasUnreadContent
          ? "자동 스크롤을 멈춘 동안 새 내용이 도착했습니다. 하단으로 돌아오면 자동 스크롤을 다시 시작합니다."
          : ""}
      </p>

      {error ? (
        <div className={styles.error} role="alert">
          <p className={styles.errorMessage}>{error.message}</p>
          <p id={errorId} className={styles.errorGuidance}>
            {errorGuidance(error.kind, streamOptions.snapshot === undefined)}
          </p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={retry}
            aria-describedby={errorId}
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}
