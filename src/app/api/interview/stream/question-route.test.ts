import { APICallError } from "ai";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceSnapshotFixture } from "@/features/interview/question-fixture";
import {
  INTERVIEW_QUESTION_MAX_PROMPT_BYTES,
  type GenerateInterviewQuestion,
} from "@/features/interview/question-generation";
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
    const longMessage = "가".repeat(INTERVIEW_QUESTION_MAX_PROMPT_BYTES);
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

  it("청크 없이 끝난 생성은 502 generation_empty로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: chunks(),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "generation_empty" } });
  });

  it("첫 조각 뒤의 실패는 스트림 안의 error 이벤트로 보낸다", async () => {
    const response = await handleInterviewQuestionStream(request({ snapshot }), {
      generate: () =>
        (async function* () {
          yield "첫 질문";
          throw new APICallError({
            message: "server error",
            url: "https://api.groq.com",
            requestBodyValues: {},
            statusCode: 500,
          });
        })(),
    });

    expect(response.status).toBe(200);
    await expect(readEvents(response)).resolves.toEqual([
      { type: "chunk", seq: 1, text: "첫 질문" },
      { type: "error", kind: "llm_failure", message: "질문 생성에 실패했습니다." },
    ]);
  });
});
