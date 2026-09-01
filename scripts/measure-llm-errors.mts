/**
 * Gemini의 실패 응답을 실측해 오류 분류가 맞는지 확인합니다.
 *
 * 배경입니다. `llm-error.ts`와 `stage-a.ts`·`stage-b.ts`의 오류 분류는 Groq 응답을 기준으로
 * 배선됐습니다. 413 판별에 쓰는 문자열 `rate_limit_exceeded`와 400 판별에 쓰는
 * `json_validate_failed`가 둘 다 Groq 본문 규약입니다. 2026-09-01에 네 경로를 Gemini로 옮겼으므로
 * 같은 상태 코드가 같은 뜻인지 다시 재야 합니다.
 *
 * 실행:
 *   npx tsx --env-file=.env scripts/measure-llm-errors.mts
 *
 * 옵션:
 *   --model=<id>       프로브에 쓸 모델. 기본 gemini-3.1-flash-lite
 *   --skip-ok          정상 호출 대조를 건너뜁니다.
 *
 * 재는 것:
 *   - 실패의 오류 클래스와 상태 코드
 *   - 응답 본문의 오류 코드·status 문자열(키가 섞이지 않게 걸러 출력합니다)
 *   - 같은 실패를 세 사본이 각각 어떤 kind로 옮기는지
 *
 * 출력에는 상태 코드와 본문의 분류 문자열만 담습니다. API 키는 출력하지 않습니다.
 */

import { createGoogle } from "@ai-sdk/google";
import { generateObject, streamText } from "ai";
import { z } from "zod";
import { mapInterviewLlmError } from "../src/features/interview/llm-error";
import { toThrowingTextStream } from "../src/features/interview/question-generation";
import { selectStageACandidates } from "../src/features/experience-candidates/stage-a";
import { selectStageBCandidates } from "../src/features/experience-candidates/stage-b";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const probeModel = flag("model", "gemini-3.1-flash-lite");
const skipOk = args.includes("--skip-ok");

const KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
if (!process.env[KEY_ENV]) {
  console.error(`${KEY_ENV}가 필요합니다. --env-file=.env 형태로 넘겨 주세요.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 출력 위생
// ---------------------------------------------------------------------------
// 실패 본문에는 키가 실리지 않지만, 실린 경우에도 새지 않게 한 번 더 지웁니다.

const KEY_SHAPES = [/AIza[0-9A-Za-z_-]{10,}/g, /invalid-key-for-measurement/g];

function redact(value: string): string {
  return KEY_SHAPES.reduce((text, shape) => text.replace(shape, "[키]"), value);
}

/** 본문에서 분류에 쓰이는 필드만 꺼냅니다. 사람이 읽는 message는 길이만 셉니다. */
function summarizeBody(body: string | undefined): string {
  if (!body) return "본문 없음";
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: number; status?: string; message?: string; details?: unknown[] };
    };
    const error = parsed.error ?? {};
    const details = (error.details ?? []) as { "@type"?: string; reason?: string }[];
    const detailTypes = details.map((detail) => detail["@type"] ?? "?").join(", ");
    // `reason`은 google.rpc.ErrorInfo가 싣는 기계 판독용 분류입니다. 상태 코드로 갈리지 않는 실패를
    // 여기서 갈라야 하므로 값을 그대로 남깁니다. 키가 아닌 분류 문자열입니다.
    const reasons = details
      .map((detail) => detail.reason)
      .filter((reason): reason is string => reason !== undefined)
      .join(", ");
    return [
      `code=${error.code ?? "-"}`,
      `status=${error.status ?? "-"}`,
      `message=${error.message?.length ?? 0}자`,
      detailTypes.length > 0 ? `details=[${detailTypes}]` : "details=없음",
      reasons.length > 0 ? `reason=[${reasons}]` : "reason=없음",
    ].join(" ");
  } catch {
    return `JSON 아님 ${redact(body).slice(0, 120)}`;
  }
}

/** 재시도 안내에 쓸 수 있는 헤더만 남깁니다. */
function retryHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "헤더 없음";
  const kept = Object.entries(headers).filter(([name]) =>
    ["retry-after", "x-ratelimit", "quota"].some((prefix) => name.toLowerCase().includes(prefix))
  );
  return kept.length === 0 ? "재시도 헤더 없음" : JSON.stringify(Object.fromEntries(kept));
}

// ---------------------------------------------------------------------------
// 분류 사본 세 개를 같은 오류에 통과시킵니다
// ---------------------------------------------------------------------------
// stage-a.ts와 stage-b.ts의 mapLlmError는 내보내지 않습니다. 측정을 위해 export를 늘리지 않고
// 프로덕션 진입점에 던지는 generate를 주입해 같은 경로를 밟습니다.

async function kindFromStageA(error: unknown): Promise<string> {
  try {
    await selectStageACandidates({ units: [], contributionItems: [], candidateLimit: 1 }, () =>
      Promise.reject(error)
    );
    return "오류 없음";
  } catch (mapped) {
    return (mapped as { kind?: string }).kind ?? (mapped as Error).name;
  }
}

async function kindFromStageB(error: unknown): Promise<string> {
  try {
    await selectStageBCandidates([], [], () => Promise.reject(error));
    return "오류 없음";
  } catch (mapped) {
    return (mapped as { kind?: string }).kind ?? (mapped as Error).name;
  }
}

function kindFromInterview(error: unknown): string {
  return mapInterviewLlmError(error, "질문 생성").kind;
}

// ---------------------------------------------------------------------------
// 프로브
// ---------------------------------------------------------------------------
// 같은 실패를 스트리밍과 구조화 출력 양쪽으로 냅니다. 첫 질문 경로는 streamText, Stage A·B는
// generateObject라 SDK가 오류를 감싸는 지점이 다를 수 있습니다.

type Shape = "stream" | "object";

interface Probe {
  readonly name: string;
  /** 이 프로브가 어떤 실패를 노리는지 적습니다. */
  readonly expects: string;
  readonly run: (shape: Shape) => Promise<void>;
}

const objectSchema = z.object({ answer: z.string() });

interface CallOptions {
  apiKey?: string;
  model?: string;
  prompt?: string;
  temperature?: number;
  abortAfterMs?: number;
}

async function callGemini(shape: Shape, options: CallOptions = {}): Promise<void> {
  const provider =
    options.apiKey === undefined ? createGoogle() : createGoogle({ apiKey: options.apiKey });
  const model = provider(options.model ?? probeModel);
  const controller = new AbortController();
  if (options.abortAfterMs !== undefined) {
    setTimeout(
      () => controller.abort(new DOMException("probe timeout", "TimeoutError")),
      options.abortAfterMs
    );
  }
  const shared = {
    model,
    prompt: options.prompt ?? "1 더하기 1은?",
    abortSignal: controller.signal,
    maxRetries: 0,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  };
  if (shape === "object") {
    await generateObject({ ...shared, schema: objectSchema });
    return;
  }
  // `textStream`이 아니라 프로덕션과 같은 `toThrowingTextStream`을 씁니다. 첫 측정에서 `textStream`을
  // 돌렸더니 모든 실패가 `NoOutputGeneratedError`로 뭉개져 상태 코드가 사라졌습니다. 프로덕션은
  // `fullStream`의 error 조각을 다시 던지므로 provider 오류가 그대로 올라옵니다. 프로브가 프로덕션과
  // 다른 소비 방식을 쓰면 존재하지 않는 결함을 관측하게 됩니다.
  for await (const chunk of toThrowingTextStream(streamText(shared))) {
    void chunk;
  }
}

/** 키 환경변수를 지운 채로 호출합니다. SDK가 키 없음을 자체 오류로 내는지 봅니다. */
async function callWithoutKey(shape: Shape): Promise<void> {
  const saved = process.env[KEY_ENV];
  delete process.env[KEY_ENV];
  try {
    await callGemini(shape);
  } finally {
    process.env[KEY_ENV] = saved;
  }
}

const probes: Probe[] = [
  {
    name: "키 없음",
    expects: "SDK의 LoadAPIKeyError. llm_configuration이어야 합니다",
    run: (shape) => callWithoutKey(shape),
  },
  {
    name: "잘못된 키",
    expects: "Groq는 401입니다. Gemini가 400을 내면 llm_auth가 아니라 llm_request로 갑니다",
    run: (shape) => callGemini(shape, { apiKey: "invalid-key-for-measurement" }),
  },
  {
    name: "없는 모델",
    expects: "404. llm_configuration이어야 합니다",
    run: (shape) => callGemini(shape, { model: "gemini-model-that-does-not-exist" }),
  },
  {
    name: "범위 밖 temperature",
    expects: "400 INVALID_ARGUMENT. 요청 오류이므로 llm_request가 맞습니다",
    run: (shape) => callGemini(shape, { temperature: 99 }),
  },
  {
    name: "첫 응답 전 중단",
    expects: "TimeoutError DOMException. llm_timeout이어야 합니다",
    run: (shape) => callGemini(shape, { abortAfterMs: 1 }),
  },
];

async function measure(probe: Probe, shape: Shape): Promise<void> {
  let caught: unknown;
  try {
    await probe.run(shape);
    console.log(`- ${probe.name} / ${shape}: 오류가 발생하지 않았습니다.`);
    return;
  } catch (error) {
    caught = error;
  }
  const raw = caught as {
    name?: string;
    statusCode?: number;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
    constructor?: { name?: string };
  };
  const [stageA, stageB] = await Promise.all([kindFromStageA(caught), kindFromStageB(caught)]);
  console.log(
    [
      `- ${probe.name} / ${shape}`,
      `    클래스 ${raw.constructor?.name ?? raw.name ?? "?"} 상태 ${raw.statusCode ?? "-"}`,
      `    본문 ${summarizeBody(raw.responseBody)}`,
      `    ${retryHeaders(raw.responseHeaders)}`,
      `    kind 첫질문=${kindFromInterview(caught)} StageA=${stageA} StageB=${stageB}`,
      `    노린 것: ${probe.expects}`,
    ].join("\n")
  );
}

async function main(): Promise<void> {
  console.log(`# Gemini 오류 분류 실측\n\n프로브 모델 ${probeModel}\n`);
  if (!skipOk) {
    console.log("## 정상 호출 대조\n");
    for (const shape of ["stream", "object"] as const) {
      try {
        await callGemini(shape);
        console.log(`- 정상 호출 / ${shape}: 성공`);
      } catch (error) {
        console.log(`- 정상 호출 / ${shape}: 실패 ${redact((error as Error).message)}`);
      }
    }
    console.log("");
  }
  console.log("## 실패 프로브\n");
  for (const probe of probes) {
    for (const shape of ["stream", "object"] as const) {
      await measure(probe, shape);
    }
  }
}

await main();
