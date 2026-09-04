import { APICallError } from "ai";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceSnapshotFixture } from "@/features/interview/question-fixture";
import {
  INTERVIEW_QUESTION_MAX_PROMPT_BYTES,
  toInterviewQuestionMessages,
  type GenerateInterviewQuestion,
} from "@/features/interview/question-generation";
import {
  INTERVIEW_HISTORY_ITEM_MAX_BYTES,
  INTERVIEW_HISTORY_MAX_ITEMS,
} from "@/features/interview/history";
import { MAX_INTERVIEW_STREAM_BODY_BYTES } from "@/features/interview/question-request";
import { createSseEventParser } from "@/features/interview/sse";
import type { InterviewStreamEvent } from "@/features/interview/sse";
import {
  encryptGitHubToken,
  GITHUB_SESSION_COOKIE,
  GITHUB_SESSION_KEY_ENV,
} from "@/lib/github/auth-session";
import { handleInterviewQuestionStream } from "./route";

const snapshot = evidenceSnapshotFixture();

function request(
  body: unknown,
  { authenticated = true, headers = {} }: { authenticated?: boolean; headers?: Record<string, string> } = {}
): NextRequest {
  return new NextRequest("https://example.com/api/interview/stream", {
    method: "POST",
    headers: {
      ...(authenticated ? { cookie: `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("token")}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function chunks(...texts: string[]): GenerateInterviewQuestion {
  return () =>
    (async function* () {
      for (const text of texts) yield text;
    })();
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

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  delete process.env[GITHUB_SESSION_KEY_ENV];
});

describe("POST /api/interview/stream", () => {
  it("근거 스냅샷으로 생성한 질문을 SSE로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: chunks("첫 질문", " 이어지는 내용"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    await expect(readEvents(response)).resolves.toEqual([
      { type: "chunk", seq: 1, text: "첫 질문" },
      { type: "chunk", seq: 2, text: " 이어지는 내용" },
      { type: "done", seq: 2 },
    ]);
  });

  it("세션이 없으면 401 unauthorized로 거절한다", async () => {
    // 이 route가 LLM을 호출하므로 다른 LLM route와 같은 경계를 붙입니다.
    const response = await handleInterviewQuestionStream(
      request({ snapshot }, { authenticated: false }),
      { generate: chunks("질문") }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "unauthorized" } });
  });

  it("세션 암호화 키가 없으면 500 server_error로 알린다", async () => {
    // 쿠키가 없으면 `auth_revoked`이지만 쿠키가 있는데 서버 키가 없으면 `server_error`입니다. 두
    // 경우 사용자가 할 수 있는 일이 다르므로 같은 401로 묶지 않습니다.
    const authenticated = request({ snapshot });
    delete process.env[GITHUB_SESSION_KEY_ENV];

    const response = await handleInterviewQuestionStream(authenticated, {
      generate: chunks("질문"),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "server_error" } });
  });

  it("JSON이 아니면 400 invalid_json으로 거절한다", async () => {
    const response = await handleInterviewQuestionStream(request("{"), {
      generate: chunks("질문"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_json" } });
  });

  it("스냅샷 계약을 어기면 422 invalid_request로 거절한다", async () => {
    const response = await handleInterviewQuestionStream(
      request({ snapshot: { ...snapshot, candidateSha: "abc" } }),
      { generate: chunks("질문") }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("본문 상한을 넘으면 413 body_too_large로 거절한다", async () => {
    const oversized = "x".repeat(MAX_INTERVIEW_STREAM_BODY_BYTES + 1);
    const response = await handleInterviewQuestionStream(
      request({ snapshot, padding: oversized }),
      { generate: chunks("질문") }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "body_too_large" } });
  });

  it("프롬프트가 상한을 넘으면 LLM을 부르기 전에 422로 거절한다", async () => {
    // 스냅샷을 만드는 쪽에 이미 상한이 있지만 이 route는 클라이언트가 보낸 값을 그대로 받습니다.
    // 한국어 한 글자가 3바이트이므로 프롬프트 상한만 넘기고 본문 상한은 넘기지 않습니다. 본문
    // 상한을 함께 넘기면 앞 단계에서 413으로 끊겨 이 가드가 도달 불가능해집니다.
    const longMessage = "가".repeat(Math.ceil(INTERVIEW_QUESTION_MAX_PROMPT_BYTES / 3));
    const oversized = {
      ...snapshot,
      representativeCommit: { ...snapshot.representativeCommit, message: longMessage },
    };
    let called = false;
    const response = await handleInterviewQuestionStream(request({ snapshot: oversized }), {
      generate: () => {
        called = true;
        return (async function* () {
          yield "질문";
        })();
      },
    });

    expect(response.status).toBe(422);
    expect(called).toBe(false);
  });

  it("이력을 실으면 마지막 답변에 이어지는 질문을 만든다", async () => {
    // 근거는 매 턴 전량이 다시 실리고 질문과 답변이 자리로 갈려 들어갑니다.
    let received: { role: string; content: string }[] = [];
    const history = [
      { role: "question", text: "왜 이 구조를 골랐나요?" },
      { role: "answer", text: "재시도 비용을 줄이려고요." },
    ];
    const response = await handleInterviewQuestionStream(request({ snapshot, history }), {
      generate: (prompt) => {
        received = toInterviewQuestionMessages(prompt);
        return (async function* () {
          yield "다음 질문";
        })();
      },
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(3);
    expect(received[0].content).toContain(snapshot.candidateSha);
    expect(received.slice(1)).toEqual([
      { role: "assistant", content: history[0].text },
      { role: "user", content: history[1].text },
    ]);
  });

  it("history 없는 요청은 첫 질문 경로 그대로 동작한다", async () => {
    let received: { role: string; content: string }[] = [];
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: (prompt) => {
        received = toInterviewQuestionMessages(prompt);
        return (async function* () {
          yield "첫 질문";
        })();
      },
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].role).toBe("user");
  });

  it("답변 없이 끝나는 이력을 422 invalid_request로 거절한다", async () => {
    // 그대로 실으면 모델이 자기 질문에 이어 또 질문을 만듭니다.
    const response = await handleInterviewQuestionStream(
      request({ snapshot, history: [{ role: "question", text: "왜 이 구조를 골랐나요?" }] }),
      { generate: chunks("질문") }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("이력이 상한을 넘으면 413 history_too_large로 거절한다", async () => {
    // 본문 상한과 갈라 둡니다. 대화를 줄이면 풀리는 실패라 안내가 다릅니다.
    const tooMany = Array.from({ length: INTERVIEW_HISTORY_MAX_ITEMS / 2 + 1 }, (_, index) => [
      { role: "question", text: `질문 ${index}` },
      { role: "answer", text: `답변 ${index}` },
    ]).flat();
    const tooLong = [
      { role: "question", text: "질문 0" },
      { role: "answer", text: "a".repeat(INTERVIEW_HISTORY_ITEM_MAX_BYTES + 1) },
    ];

    for (const history of [tooMany, tooLong]) {
      const response = await handleInterviewQuestionStream(request({ snapshot, history }), {
        generate: chunks("질문"),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { kind: "history_too_large" },
      });
    }
  });

  it("Last-Event-ID가 오면 이어받기를 지원하지 않는다고 거절한다", async () => {
    // 조용히 무시하면 클라이언트가 이어받았다고 믿고 앞부분에 새 생성 결과를 덧붙입니다.
    const response = await handleInterviewQuestionStream(
      request({ snapshot }, { headers: { "Last-Event-ID": "3" } }),
      { generate: chunks("질문") }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("첫 조각 전의 한도 초과는 503과 분류를 본문에 실어 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: () =>
        (async function* () {
          throw new APICallError({
            message: "rate limit",
            url: "https://api.groq.com",
            requestBodyValues: {},
            statusCode: 429,
          });
        })(),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "llm_rate_limit" } });
  });

  it("첫 조각 전의 인증 실패는 502와 llm_auth로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: () =>
        (async function* () {
          throw new APICallError({
            message: "invalid key",
            url: "https://api.groq.com",
            requestBodyValues: {},
            statusCode: 401,
          });
        })(),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "llm_auth" } });
  });

  // Gemini는 잘못된 키를 401이 아니라 400 `INVALID_ARGUMENT`로 돌려줍니다(2026-09-01 실측). 본문으로
  // 갈라 두지 않으면 이 실패가 `llm_request`로 가고, 화면이 "근거가 크기를 넘었습니다"를 띄웁니다.
  it("잘못된 키의 400도 502와 llm_auth로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: () =>
        (async function* () {
          throw new APICallError({
            message: "API key not valid. Please pass a valid API key.",
            url: "https://generativelanguage.googleapis.com",
            requestBodyValues: {},
            statusCode: 400,
            responseBody:
              '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",' +
              '"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",' +
              '"reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}',
          });
        })(),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "llm_auth" } });
  });

  it("청크 없이 끝난 생성은 502 generation_empty로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: chunks(),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "generation_empty" } });
  });

  // 5xx는 Gemini에서 모델 과부하(503 `UNAVAILABLE`)와 내부 오류(500 `INTERNAL`)로 옵니다. 기다리면
  // 풀리는 실패이므로 재시도 가능한 `llm_failure`로 두고 문구로 일시 장애를 밝힙니다.
  it.each([500, 503])("첫 조각 뒤의 %i은 스트림 안의 error 이벤트로 보낸다", async (statusCode) => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: () =>
        (async function* () {
          yield "첫 질문";
          throw new APICallError({
            message: "server error",
            url: "https://generativelanguage.googleapis.com",
            requestBodyValues: {},
            statusCode,
          });
        })(),
    });

    expect(response.status).toBe(200);
    await expect(readEvents(response)).resolves.toEqual([
      { type: "chunk", seq: 1, text: "첫 질문" },
      {
        type: "error",
        kind: "llm_failure",
        message: "질문 생성 서비스가 일시적으로 응답하지 못했습니다.",
      },
    ]);
  });
});
