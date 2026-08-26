import type { NextRequest } from "next/server";
import {
  ExperienceCandidateOutputError,
  type ExperienceCandidateOutputErrorKind,
} from "@/features/experience-candidates/errors";
import { InterviewStreamError, type InterviewQuestionErrorKind } from "@/features/interview/errors";
import {
  INTERVIEW_QUESTION_MAX_PROMPT_BYTES,
  buildInterviewQuestionPrompt,
  interviewQuestionPromptBytes,
  startInterviewQuestionStream,
  type StartInterviewQuestionStreamOptions,
} from "@/features/interview/question-generation";
import {
  MAX_INTERVIEW_STREAM_BODY_BYTES,
  isInterviewStreamRequestBody,
} from "@/features/interview/question-request";
import { createQuestionSseStream } from "@/features/interview/question-stream";
import { SSE_RESPONSE_HEADERS } from "@/features/interview/sse";
import {
  createTestStream,
  isTestStreamScenario,
  TEST_STREAM_CHUNKS,
  type TestStreamScenario,
} from "@/features/interview/test-stream";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 질문 스트리밍의 SSE 전송 계약을 구현합니다.
 *
 * `POST`가 실제 생성 경로입니다. 근거 스냅샷을 본문으로 받아 첫 질문 하나를 생성해 스트리밍합니다.
 * `GET`은 이슈 #60이 만든 테스트용 스트림입니다. 실제 생성은 비결정적이라 전송 계약 회귀 테스트의
 * 기준으로 쓸 수 없어 남겨 둡니다. 하위 이슈 B의 화면 개발도 `?scenario=` 경로를 씁니다.
 */
function errorResponse(kind: string, message: string, status: number): Response {
  return Response.json({ error: { kind, message } }, { status });
}

function invalidRequest(message: string): Response {
  return errorResponse("invalid_request", message, 422);
}

function bodyTooLarge(): Response {
  return errorResponse(
    "body_too_large",
    `요청 본문은 ${MAX_INTERVIEW_STREAM_BODY_BYTES / 1024}KB 이하여야 합니다.`,
    413
  );
}

/**
 * 생성 실패의 상태 코드입니다. 값은 `wiki/2026-08-21-stage-a-선별-계약.md`의 표를 그대로 씁니다.
 *
 * `generation_empty`는 502입니다. 요청은 정상이고 provider 호출도 실패하지 않았지만 응답에 질문이
 * 없었으므로 상위 서비스의 응답 문제로 봅니다.
 */
const GENERATION_ERROR_STATUS: Record<
  ExperienceCandidateOutputErrorKind | InterviewQuestionErrorKind,
  number
> = {
  json_parse: 502,
  schema_validation: 502,
  unknown_sha: 502,
  unrelated_sha: 502,
  unknown_file_path: 502,
  llm_network: 502,
  llm_auth: 502,
  llm_rate_limit: 503,
  llm_timeout: 504,
  llm_configuration: 500,
  llm_request: 502,
  llm_failure: 502,
  generation_empty: 502,
};

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

/**
 * 근거 스냅샷으로 첫 질문을 생성해 스트리밍합니다.
 *
 * GitHub PAT 세션을 요구합니다. 이 route가 LLM을 호출하게 되었으므로 다른 LLM route와 같은 경계를
 * 붙입니다. 이유는 LLM 호출 비용이 공개적으로 노출되는 것을 막는 것이고
 * `wiki/2026-08-21-stage-a-선별-계약.md`에 있습니다.
 *
 * 첫 조각이 도착한 뒤에 응답을 시작합니다. 그 전에 난 실패는 HTTP 상태와 JSON 본문에 분류를 실어
 * 보낼 수 있고, 그 뒤의 실패는 이미 보낸 내용이 있으므로 스트림 안의 `error` 이벤트로 보냅니다.
 * 수신부가 비2xx 본문의 `error.kind`를 읽어 안내를 가르는 설계가 이 순서에 의존합니다.
 */
export async function handleInterviewQuestionStream(
  request: NextRequest,
  options: Omit<StartInterviewQuestionStreamOptions, "signal"> = {}
): Promise<Response> {
  try {
    getGitHubTokenFromRequest(request);
  } catch (error) {
    if (error instanceof GitHubFetchError && error.kind === "auth_revoked") {
      return errorResponse("unauthorized", "GitHub 인증 세션이 필요합니다.", 401);
    }
    /**
     * 두 갈래를 모두 남기는 이유는 아래 갈래도 도달하기 때문입니다.
     *
     * 쿠키가 없으면 `auth_revoked`입니다. 쿠키가 있는데 `GITHUB_SESSION_ENCRYPTION_KEY`가 없거나
     * 32바이트가 아니면 `decryptGitHubToken`이 그 `server_error`를 그대로 올립니다. 두 경우는
     * 사용자가 할 수 있는 일이 다릅니다. 앞은 다시 로그인이고 뒤는 사용자가 할 수 있는 일이
     * 없습니다.
     *
     * `server_error`는 `interview/errors.ts`의 아는 분류에 등록해 두었습니다. 등록하지 않으면
     * 수신부가 전송 실패로 떨어뜨려 서버 설정 문제에 네트워크 확인 안내가 나갑니다.
     */
    return errorResponse("server_error", "서버 설정 문제로 질문 생성을 시작하지 못했습니다.", 500);
  }

  /**
   * 실제 생성 경로는 이어받기를 지원하지 않습니다.
   *
   * LLM 스트림은 서버가 이미 보낸 청크를 보관하지 않아 `seq N`부터 이어 보낼 수 없고, 클라이언트가
   * 끊긴 뒤에도 서버가 생성을 계속하는 동작은 저장 계층과 사용자 식별자에 의존해 범위 밖입니다.
   * 이어받는 대신 처음부터 다시 생성하면 같은 질문이 아니라 다른 질문이 나와 이미 표시된 내용과
   * 어긋납니다. 그래서 조용히 무시하지 않고 거절합니다. 조용히 무시하면 클라이언트가 이어받았다고
   * 믿고 앞부분에 새 생성 결과를 덧붙입니다.
   */
  if ((request.headers.get("Last-Event-ID") ?? "") !== "") {
    return invalidRequest(
      "질문 생성 스트림은 이어받기를 지원하지 않습니다. Last-Event-ID 없이 다시 요청해 주세요."
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > MAX_INTERVIEW_STREAM_BODY_BYTES) return bodyTooLarge();

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERVIEW_STREAM_BODY_BYTES) {
    return bodyTooLarge();
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid_json", "요청 본문은 JSON이어야 합니다.", 400);
  }
  if (!isInterviewStreamRequestBody(body)) {
    return invalidRequest("근거 스냅샷 형식이 올바르지 않습니다.");
  }

  // 모델에 실제로 실리는 프롬프트를 서버에서 접어 보고 상한을 확인합니다. 스냅샷을 만드는 쪽에
  // 이미 상한이 있지만 이 route는 클라이언트가 보낸 값을 그대로 받으므로 여기서 한 번 더 봅니다.
  // Stage A route가 같은 이유로 같은 가드를 둡니다.
  const promptBytes = interviewQuestionPromptBytes(
    buildInterviewQuestionPrompt(body.snapshot, options.variant)
  );
  if (promptBytes > INTERVIEW_QUESTION_MAX_PROMPT_BYTES) {
    return invalidRequest("질문 근거가 한 번에 보낼 수 있는 크기를 넘었습니다.");
  }

  try {
    const question = await startInterviewQuestionStream(body.snapshot, {
      ...options,
      signal: request.signal,
    });
    return new Response(createQuestionSseStream(question, { signal: request.signal }), {
      headers: SSE_RESPONSE_HEADERS,
    });
  } catch (error) {
    if (error instanceof ExperienceCandidateOutputError || error instanceof InterviewStreamError) {
      const status = GENERATION_ERROR_STATUS[error.kind as keyof typeof GENERATION_ERROR_STATUS];
      if (status !== undefined) return errorResponse(error.kind, error.message, status);
    }
    return errorResponse("llm_failure", "질문 생성에 실패했습니다.", 502);
  }
}

export function GET(request: NextRequest): Response {
  return handleInterviewStream(request);
}

export function POST(request: NextRequest): Promise<Response> {
  return handleInterviewQuestionStream(request);
}
