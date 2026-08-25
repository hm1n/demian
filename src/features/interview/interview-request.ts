import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";

/**
 * 인터뷰 화면이 질문 생성 경로로 보내는 요청 본문입니다. 이슈 #64와 #63이 착수 전에 고정한
 * 계약이고 형태는 `{ snapshot: ExperienceEvidenceSnapshot }` 하나입니다.
 *
 * 화면의 책임은 이 본문을 만들어 전송 계층에 넘기는 데까지입니다. 전송, 재시도, 오류 분류는
 * `interview-stream-client.ts`와 질문 생성 route가 담당합니다.
 */
export const INTERVIEW_STREAM_REQUEST_METHOD = "POST";

export const INTERVIEW_STREAM_REQUEST_CONTENT_TYPE = "application/json";

export interface InterviewStreamRequestPayload {
  readonly snapshot: ExperienceEvidenceSnapshot;
}

export function createInterviewStreamRequestBody(snapshot: ExperienceEvidenceSnapshot): string {
  return JSON.stringify({ snapshot } satisfies InterviewStreamRequestPayload);
}

/**
 * 질문 생성 route가 근거 스냅샷을 본문으로 받는지 나타냅니다.
 *
 * 지금 `src/app/api/interview/stream/route.ts`는 `GET`만 내보내고 테스트 스트림을 돌려줍니다.
 * 그 route에 `POST`를 보내면 405가 나고, 405 본문에는 아는 오류 분류가 없어서 화면에는
 * "연결을 시작하지 못했습니다"만 남습니다. 그래서 본문을 실제로 싣는 것은 route가 `POST`와
 * 본문을 받는 시점(이슈 #63)까지 미룹니다. **그 시점에 이 값을 `true`로 바꾸면 배선이
 * 끝납니다.** 본문을 만드는 코드와 붙이는 코드는 이미 아래에 있고 양쪽 분기 모두 테스트가
 * 있습니다.
 */
export const INTERVIEW_STREAM_ROUTE_ACCEPTS_SNAPSHOT = false;

export interface InterviewStreamFetchOptions {
  /** 감쌀 `fetch`입니다. 생략하면 전송 계층의 기본값을 그대로 씁니다. */
  readonly baseFetch?: typeof fetch;
  /** 본문을 실을지 여부입니다. 생략하면 route 계약을 따릅니다. */
  readonly enabled?: boolean;
}

/**
 * 근거 스냅샷을 요청 본문으로 붙이는 `fetch`를 만듭니다.
 *
 * 전송 계층이 붙이는 `Accept`, `Last-Event-ID`, `signal`을 덮지 않고 method와 본문만 더합니다.
 * 재연결도 같은 본문으로 다시 보내야 하므로 호출마다 본문을 새로 만들지 않고 한 번 만든 문자열을
 * 재사용합니다.
 *
 * 본문을 싣지 않는 동안에는 감싸지 않고 `baseFetch`를 그대로 돌려줍니다. 아무 일도 하지 않는
 * 래퍼를 끼워 두면 전송 실패를 추적할 때 한 겹을 더 들여다봐야 합니다.
 */
export function createInterviewStreamFetch(
  snapshot: ExperienceEvidenceSnapshot,
  { baseFetch, enabled = INTERVIEW_STREAM_ROUTE_ACCEPTS_SNAPSHOT }: InterviewStreamFetchOptions = {}
): typeof fetch | undefined {
  if (!enabled) return baseFetch;

  const body = createInterviewStreamRequestBody(snapshot);
  const send = baseFetch ?? fetch;

  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Content-Type", INTERVIEW_STREAM_REQUEST_CONTENT_TYPE);
    return send(input, { ...init, method: INTERVIEW_STREAM_REQUEST_METHOD, headers, body });
  };
}
