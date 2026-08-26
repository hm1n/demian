import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import { InterviewStreamError } from "./errors";
import { evidenceSnapshotFixture } from "./question-fixture";
import {
  buildInterviewQuestionPrompt,
  interviewQuestionPromptBytes,
  startInterviewQuestionStream,
  toThrowingTextStream,
  type GenerateInterviewQuestion,
} from "./question-generation";

const snapshot = evidenceSnapshotFixture();

function chunks(...texts: string[]): GenerateInterviewQuestion {
  return () =>
    (async function* () {
      for (const text of texts) yield text;
    })();
}

function failsWith(error: unknown, ...before: string[]): GenerateInterviewQuestion {
  return () =>
    (async function* () {
      for (const text of before) yield text;
      throw error;
    })();
}

async function collect(stream: { firstText: string; next: () => Promise<string | null> }) {
  const texts = [stream.firstText];
  for (;;) {
    const text = await stream.next();
    if (text === null) return texts;
    texts.push(text);
  }
}

describe("startInterviewQuestionStream", () => {
  it("첫 조각을 받은 뒤에 스트림을 돌려준다", async () => {
    const stream = await startInterviewQuestionStream(snapshot, {
      generate: chunks("첫 조각", " 둘째 조각"),
    });

    expect(stream.firstText).toBe("첫 조각");
    await expect(collect(stream)).resolves.toEqual(["첫 조각", " 둘째 조각"]);
  });

  it("빈 조각은 건너뛴다", async () => {
    // provider가 빈 텍스트 델타를 보내면 그대로 흘려 `seq`만 늘고 화면에 붙는 내용이 없는 청크가
    // 생깁니다. `done`의 마지막 `seq` 검증은 통과하는데 질문은 그만큼 비어 보입니다.
    const stream = await startInterviewQuestionStream(snapshot, {
      generate: chunks("", "첫 조각", "", "둘째 조각"),
    });

    await expect(collect(stream)).resolves.toEqual(["첫 조각", "둘째 조각"]);
  });

  it("조각이 하나도 없으면 generation_empty로 알린다", async () => {
    await expect(
      startInterviewQuestionStream(snapshot, { generate: chunks("", "") })
    ).rejects.toMatchObject({ kind: "generation_empty" });
  });

  it("첫 조각 전의 provider 실패는 분류를 실어 던진다", async () => {
    const apiError = new APICallError({
      message: "rate limit",
      url: "https://api.groq.com",
      requestBodyValues: {},
      statusCode: 429,
    });

    await expect(
      startInterviewQuestionStream(snapshot, { generate: failsWith(apiError) })
    ).rejects.toMatchObject({ kind: "llm_rate_limit" });
  });

  it("첫 조각 뒤의 실패는 스트림을 소비할 때 던진다", async () => {
    const apiError = new APICallError({
      message: "server error",
      url: "https://api.groq.com",
      requestBodyValues: {},
      statusCode: 500,
    });
    const stream = await startInterviewQuestionStream(snapshot, {
      generate: failsWith(apiError, "첫 조각"),
    });

    expect(stream.firstText).toBe("첫 조각");
    await expect(stream.next()).rejects.toMatchObject({ kind: "llm_failure" });
  });

  it("첫 조각이 시한 안에 오지 않으면 llm_timeout으로 알린다", async () => {
    const generate: GenerateInterviewQuestion = (_prompt, abortSignal) =>
      (async function* () {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          });
        });
        yield "늦은 조각";
      })();

    await expect(
      startInterviewQuestionStream(snapshot, { generate, firstChunkTimeoutMs: 10 })
    ).rejects.toMatchObject({ kind: "llm_timeout" });
  });

  it("이미 중단된 signal을 받으면 provider 호출을 시작하기 전에 끊는다", async () => {
    // route가 본문을 읽고 프롬프트를 접는 동안 클라이언트가 끊으면 이 지점에서 signal이 이미
    // aborted입니다. `addEventListener`는 이미 발생한 abort에 대해 불리지 않으므로, 상태를 먼저
    // 보지 않으면 받을 사람이 없는 응답을 위해 provider 호출이 무료 등급 일일 토큰을 씁니다.
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const generate: GenerateInterviewQuestion = () => {
      called = true;
      return (async function* () {
        yield "호출되면 안 되는 조각";
      })();
    };

    await expect(
      startInterviewQuestionStream(snapshot, { generate, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "llm_timeout" });
    expect(called).toBe(false);
  });

  it("중단된 스트림이 조용히 끝나도 generation_empty로 뭉개지 않는다", async () => {
    // provider가 중단을 예외가 아니라 정상 종료로 알리는 경우입니다. 실측에서 `textStream`이 실제로
    // 이렇게 동작했습니다. 시간 초과가 "질문을 만들지 못했습니다"로 뭉개지면 안 됩니다.
    const generate: GenerateInterviewQuestion = (_prompt, abortSignal) =>
      (async function* () {
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve()));
      })();

    await expect(
      startInterviewQuestionStream(snapshot, { generate, firstChunkTimeoutMs: 10 })
    ).rejects.toMatchObject({ kind: "llm_timeout" });
  });
});

describe("toThrowingTextStream", () => {
  it("error 부분을 던진다", async () => {
    const failure = new Error("provider failed");
    const iterate = async () => {
      const texts: string[] = [];
      for await (const text of toThrowingTextStream({
        fullStream: (async function* () {
          yield { type: "text-delta" as const, text: "앞부분" };
          yield { type: "error" as const, error: failure };
        })(),
        usage: Promise.resolve(null),
        response: Promise.resolve(null),
        text: Promise.resolve(null),
      })) {
        texts.push(text);
      }
      return texts;
    };

    await expect(iterate()).rejects.toBe(failure);
  });

  it("abort 부분을 중단 예외로 던진다", async () => {
    const iterate = async () => {
      const texts: string[] = [];
      for await (const text of toThrowingTextStream({
        fullStream: (async function* () {
          yield { type: "abort" as const, reason: "client closed" };
        })(),
        usage: Promise.resolve(null),
        response: Promise.resolve(null),
        text: Promise.resolve(null),
      })) {
        texts.push(text);
      }
      return texts;
    };

    await expect(iterate()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("계약에 없는 부분은 무시한다", async () => {
    const texts: string[] = [];
    for await (const text of toThrowingTextStream({
      fullStream: (async function* () {
        yield { type: "start" as const };
        yield { type: "text-start" as const };
        yield { type: "text-delta" as const, text: "본문" };
        yield { type: "finish" as const };
      })(),
      usage: Promise.resolve(null),
      response: Promise.resolve(null),
      text: Promise.resolve(null),
    })) {
      texts.push(text);
    }

    expect(texts).toEqual(["본문"]);
  });
});

describe("오류 종류", () => {
  it("generation_empty는 전송 오류가 아니라 인터뷰 스트림 오류다", async () => {
    const error = await startInterviewQuestionStream(snapshot, { generate: chunks() }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(InterviewStreamError);
    expect(error).not.toBeInstanceOf(ExperienceCandidateOutputError);
  });
});

describe("interviewQuestionPromptBytes", () => {
  it("시스템 프롬프트와 근거를 함께 잰다", () => {
    const prompt = buildInterviewQuestionPrompt(snapshot);

    expect(interviewQuestionPromptBytes(prompt)).toBe(
      new TextEncoder().encode(`${prompt.system}\n\n${prompt.evidence}`).byteLength
    );
    // 근거만 재면 시스템 프롬프트가 상한 밖에 남습니다. Stage A가 기여 항목을 빠뜨려 같은 결함을
    // 겪은 적이 있습니다.
    expect(interviewQuestionPromptBytes(prompt)).toBeGreaterThan(
      new TextEncoder().encode(prompt.evidence).byteLength
    );
  });
});
