import { createGroq } from "@ai-sdk/groq";
import { streamText } from "ai";
import { generationEmptyError } from "./errors";
import { mapInterviewLlmError } from "./llm-error";
import {
  INTERVIEW_QUESTION_PROMPT_VARIANT,
  renderInterviewEvidencePrompt,
  renderInterviewQuestionSystemPrompt,
  type InterviewPromptVariant,
} from "./question-prompt";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";

/**
 * 첫 질문 생성 모델입니다.
 *
 * Groq를 씁니다. Stage B가 쓰는 Gemini 무료 등급은 하루 요청 20건을 프로젝트 전체가 공유하므로
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) 인터뷰 시작마다 1건을 쓰면 후보 생성이
 * 먼저 막힙니다. 순서상 뒤 단계가 앞 단계의 할당량을 먹어서는 안 됩니다.
 *
 * Groq 안에서 Stage A와 다른 모델을 쓰는 이유는 **일일 토큰 한도가 모델별**이기 때문입니다. Stage
 * A가 `openai/gpt-oss-120b`를 쓰고, 측정하던 날 그 모델의 일일 200,000토큰이 소진되어 질문 생성을
 * 한 번도 호출할 수 없었습니다. 창은 24시간 롤링이라 40분 동안 잔여가 896토큰만 늘었습니다. 같은
 * 모델을 쓰면 후보 생성을 몇 번 돌린 날에는 인터뷰를 시작할 수 없습니다.
 *
 * `openai/gpt-oss-20b`는 근거에 없는 사실을 만드는 것이 관측되었습니다. 남은 문제이고 위키의
 * `확인 필요`에 있습니다. 지연·토큰 실측과 품질 비교는
 * `llm-wiki/wiki/2026-08-25-첫-질문-생성-provider-실측과-재개-방침.md`에 있습니다.
 */
export const INTERVIEW_QUESTION_MODEL = "openai/gpt-oss-20b";

/**
 * 첫 청크가 오기까지 기다리는 시한입니다.
 *
 * 이 시한이 따로 있는 이유는 첫 청크 전과 후의 실패가 사용자에게 다르게 보이기 때문입니다. 첫
 * 청크 전이면 HTTP 상태와 본문으로 분류를 실어 보낼 수 있고 화면에는 아무것도 남지 않습니다.
 * 첫 청크 후에는 이미 표시된 내용이 있어 되돌릴 수 없습니다. 그래서 첫 청크는 짧게 끊고 총
 * 시간은 넉넉히 둡니다.
 */
export const INTERVIEW_QUESTION_FIRST_CHUNK_TIMEOUT_MS = 20_000;

/**
 * 생성 전체 시한입니다. route `maxDuration` 60초보다 먼저 오류 계약을 반환하도록 55초에 끊습니다.
 * Stage A·B와 같은 값이고 같은 이유입니다(`wiki/2026-08-21-stage-a-선별-계약.md`).
 */
export const INTERVIEW_QUESTION_TOTAL_TIMEOUT_MS = 55_000;

/**
 * 모델에 실제로 실리는 프롬프트(시스템 + 근거)의 바이트 상한입니다.
 *
 * 근거 스냅샷 자체는 `evidence-snapshot.ts`가 이미 추정 토큰으로 묶습니다. 그런데 그 상한은
 * 스냅샷을 만드는 쪽에서만 걸리고, 이 route는 클라이언트가 보낸 스냅샷을 그대로 받습니다.
 * 상한을 넘긴 스냅샷을 보내면 Groq 분당 토큰 한도를 넘겨 413을 받게 되므로 실제 프롬프트를
 * 서버에서 접어 보고 한 번 더 확인합니다. Stage A route가 같은 이유로 같은 가드를 둡니다.
 *
 * 값의 근거는 실측입니다(2026-08-25). 근거 상한 3,500토큰을 꽉 채운 스냅샷의 실제 프롬프트가
 * 10,446~10,797바이트였고 바이트당 토큰은 3.64~3.67이었습니다. 14,000바이트는 약 3,840토큰이고
 * 관측된 최대 응답 1,678토큰을 더해도 분당 한도 8,000의 69%입니다. 정상 입력보다 30% 위에 두어
 * 정상 요청을 막지 않으면서 한도를 넘기는 요청은 걸러냅니다.
 */
export const INTERVIEW_QUESTION_MAX_PROMPT_BYTES = 14_000;

export interface InterviewQuestionPrompt {
  readonly system: string;
  readonly evidence: string;
}

/** provider 호출을 주입할 수 있게 열어 둡니다. 테스트와 측정 스크립트가 같은 자리에 들어옵니다. */
export type GenerateInterviewQuestion = (
  prompt: InterviewQuestionPrompt,
  abortSignal: AbortSignal
) => AsyncIterable<string>;

export function buildInterviewQuestionPrompt(
  snapshot: ExperienceEvidenceSnapshot,
  variant: InterviewPromptVariant = INTERVIEW_QUESTION_PROMPT_VARIANT
): InterviewQuestionPrompt {
  return {
    system: renderInterviewQuestionSystemPrompt(variant),
    evidence: renderInterviewEvidencePrompt(snapshot),
  };
}

/** 프롬프트 전체의 UTF-8 바이트입니다. route 가드와 측정이 같은 값을 보게 합니다. */
export function interviewQuestionPromptBytes(prompt: InterviewQuestionPrompt): number {
  return new TextEncoder().encode(`${prompt.system}\n\n${prompt.evidence}`).byteLength;
}

/** `streamText` 결과에서 우리가 실제로 쓰는 부분만 봅니다. provider 종류에 묶이지 않게 둡니다. */
export interface InterviewQuestionCallResult {
  readonly fullStream: AsyncIterable<{
    readonly type: string;
    readonly text?: string;
    readonly error?: unknown;
    readonly reason?: string;
  }>;
  readonly usage: PromiseLike<unknown>;
  readonly response: PromiseLike<unknown>;
  readonly text: PromiseLike<unknown>;
}

/**
 * `streamText` 결과를 오류가 실제로 던져지는 텍스트 스트림으로 바꿉니다.
 *
 * `textStream`을 쓰지 않는 이유는 실측입니다(2026-08-25). provider 호출이 실패해도 `textStream`은
 * 던지지 않고 조용히 끝납니다. 잘못된 키(401)와 없는 모델(404)을 넣었더니 둘 다 청크 0개로 정상
 * 종료해 `generation_empty`로 분류됐습니다. 인증 실패에 "질문을 만들지 못했습니다"라는 안내가
 * 나가면 사용자는 풀리지 않는 재시도만 반복합니다. `fullStream`의 `error` 부분을 던져야 분류가
 * 살아납니다.
 *
 * 부수 프로미스도 함께 소비합니다. 호출이 실패하면 `usage`·`response`·`text`가 함께 거절되고,
 * 우리가 스트림만 읽으면 아무도 받지 않는 거절이 되어 Node가 프로세스를 끝냅니다. 실측에서 Groq
 * 일일 토큰 한도 초과가 실제로 이 경로를 밟았습니다.
 */
export async function* toThrowingTextStream(
  result: InterviewQuestionCallResult
): AsyncIterable<string> {
  for (const settled of [result.usage, result.response, result.text]) {
    void Promise.resolve(settled).catch(() => {});
  }
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      if (part.text !== undefined && part.text !== "") yield part.text;
      continue;
    }
    if (part.type === "error") throw part.error;
    if (part.type === "abort") {
      throw new DOMException(part.reason ?? "aborted", "AbortError");
    }
  }
}

/**
 * provider 호출 재시도 횟수입니다.
 *
 * SDK 기본값 2(총 3회)를 1(총 2회)로 낮췄습니다. 실측에서 Groq 일일 토큰 한도 초과가 세 번 모두
 * 같은 429로 끝나 6.5초를 버렸습니다. 응답에 `x-should-retry: false`가 붙어 있었는데도 SDK는
 * 재시도했습니다. 한도 초과는 기다려야 풀리므로 그 시간은 첫 청크 시한만 갉아먹습니다. 재시도를
 * 0으로 두지 않는 이유는 일시적인 5xx는 한 번 더 보내면 풀리기 때문입니다.
 */
export const INTERVIEW_QUESTION_MAX_RETRIES = 1;

export function createInterviewQuestionGenerate(
  model: string = INTERVIEW_QUESTION_MODEL
): GenerateInterviewQuestion {
  return ({ system, evidence }, abortSignal) =>
    toThrowingTextStream(
      streamText({
        model: createGroq()(model),
        system,
        prompt: evidence,
        abortSignal,
        maxRetries: INTERVIEW_QUESTION_MAX_RETRIES,
      })
    );
}

const generateWithGroq: GenerateInterviewQuestion = createInterviewQuestionGenerate();

/**
 * 첫 조각이 도착한 뒤의 생성 스트림입니다.
 *
 * `firstText`가 값으로 들어 있는 것이 핵심입니다. 이 값을 얻기 전에는 응답을 시작하지 않으므로,
 * 첫 조각 전에 난 실패는 HTTP 상태와 JSON 본문에 분류를 실어 보낼 수 있습니다. 수신부가 비2xx
 * 본문의 `error.kind`를 읽어 안내를 가르는 설계가 이 순서에 의존합니다
 * (`wiki/2026-08-25-스트리밍-렌더링-측정과-전송-계약.md`).
 */
export interface InterviewQuestionStream {
  readonly firstText: string;
  /** 다음 조각입니다. 스트림이 끝나면 null입니다. 소비 중 실패는 매핑된 오류로 던집니다. */
  next(): Promise<string | null>;
  /** 타이머와 provider 스트림을 정리합니다. 여러 번 불러도 안전합니다. */
  close(): Promise<void>;
}

export interface StartInterviewQuestionStreamOptions {
  generate?: GenerateInterviewQuestion;
  variant?: InterviewPromptVariant;
  firstChunkTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** 클라이언트가 연결을 끊으면 provider 호출도 함께 끊습니다. */
  signal?: AbortSignal;
}

export async function startInterviewQuestionStream(
  snapshot: ExperienceEvidenceSnapshot,
  {
    generate = generateWithGroq,
    variant,
    firstChunkTimeoutMs = INTERVIEW_QUESTION_FIRST_CHUNK_TIMEOUT_MS,
    totalTimeoutMs = INTERVIEW_QUESTION_TOTAL_TIMEOUT_MS,
    signal,
  }: StartInterviewQuestionStreamOptions = {}
): Promise<InterviewQuestionStream> {
  const controller = new AbortController();
  const abortAfterTimeout = (message: string) =>
    controller.abort(new DOMException(message, "TimeoutError"));
  const totalTimer = setTimeout(() => abortAfterTimeout("interview question timeout"), totalTimeoutMs);
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => abortAfterTimeout("interview question first chunk timeout"),
    firstChunkTimeoutMs
  );
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(totalTimer);
    if (firstChunkTimer !== null) clearTimeout(firstChunkTimer);
    firstChunkTimer = null;
    signal?.removeEventListener("abort", forwardAbort);
  };

  /**
   * 이미 중단된 요청은 provider를 부르지 않고 끝냅니다.
   *
   * `addEventListener`는 이미 발생한 abort에 대해 불리지 않습니다. route가 본문을 읽고 프롬프트를
   * 접는 동안 클라이언트가 끊으면 이 지점에서 이미 aborted이고, 리스너만 걸어 두면 받을 사람이 없는
   * 응답을 위해 호출이 나갑니다. 무료 등급 일일 토큰 한도를 쓰는 구조에서 실제 비용입니다.
   *
   * 내부 `controller`로 옮기는 것만으로는 부족합니다. 중단 신호를 관측하지 않는 스트림은 그대로
   * 조각을 내놓습니다. 호출 자체를 만들지 않아야 확실합니다.
   */
  if (signal?.aborted === true) {
    cleanup();
    throw mapInterviewLlmError(
      signal.reason ?? new DOMException("aborted", "AbortError"),
      "질문 생성"
    );
  }

  const prompt = buildInterviewQuestionPrompt(snapshot, variant);
  const iterator = generate(prompt, controller.signal)[Symbol.asyncIterator]();

  /**
   * 다음 조각을 가져옵니다. 빈 문자열 조각은 건너뜁니다.
   *
   * provider는 빈 텍스트 델타를 보낼 수 있고, 그대로 흘리면 `seq`만 늘고 화면에 붙는 내용이 없는
   * 청크가 생깁니다. 그러면 `done`의 마지막 `seq` 검증은 통과하지만 사용자가 보는 질문은 그
   * 청크만큼 비어 있게 됩니다. 여기서 걸러 `seq`가 실제 내용과 1:1로 맞게 둡니다.
   *
   * 스트림이 끝났을 때 중단 여부를 먼저 봅니다. 시한 초과나 클라이언트 연결 종료로 끊긴 스트림은
   * provider에 따라 예외가 아니라 정상 종료로 보일 수 있고, 그대로 두면 시간 초과가 "질문을 만들지
   * 못했습니다"로 뭉개집니다.
   */
  const pull = async (): Promise<string | null> => {
    try {
      for (;;) {
        const { done, value } = await iterator.next();
        if (done === true) {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new DOMException("aborted", "AbortError");
          }
          return null;
        }
        if (value !== "") return value;
      }
    } catch (error) {
      cleanup();
      throw mapInterviewLlmError(error, "질문 생성");
    }
  };

  const firstText = await pull();
  if (firstChunkTimer !== null) {
    clearTimeout(firstChunkTimer);
    firstChunkTimer = null;
  }
  if (firstText === null) {
    cleanup();
    throw generationEmptyError();
  }

  return {
    firstText,
    async next() {
      const text = await pull();
      if (text === null) cleanup();
      return text;
    },
    async close() {
      cleanup();
      await iterator.return?.();
    },
  };
}
