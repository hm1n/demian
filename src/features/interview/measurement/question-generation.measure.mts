/**
 * 첫 질문 생성의 Provider·모델·프롬프트를 실측합니다. 이슈 #63의 "측정이 구현보다 먼저"를 위한
 * 수동 실행 스크립트이고 vitest 스위트에는 포함되지 않습니다.
 *
 * 실행:
 *   GITHUB_TOKEN=$(gh auth token) npx tsx --env-file=<.env 경로> \
 *     src/features/interview/measurement/question-generation.measure.mts --pr=61 --pr=56
 *
 * 옵션:
 *   --owner=<소유자>       기본 hm1n
 *   --repo=<저장소>        기본 demian
 *   --pr=<번호>            근거로 쓸 Pull Request. 여러 번 지정하면 크기가 다른 입력을 함께 잽니다.
 *   --max-commits=<N>      PR에서 가져올 커밋 수 상한. 기본 6
 *   --skip-gemini          Gemini 호출을 건너뜁니다. 무료 등급 일일 20건을 Stage B와 공유합니다.
 *   --skip-groq            Groq 호출을 건너뜁니다. 일일 토큰 한도가 소진됐을 때 씁니다.
 *   --skip-deepinfra       DeepInfra 호출을 건너뜁니다. 선불 잔액을 아낄 때 씁니다.
 *   --model=<id>           이 모델만 잽니다. 분당 토큰 한도 때문에 호출을 나눠 돌릴 때 씁니다.
 *   --provider=<groq|google|deepinfra>  이 provider만 잽니다.
 *   --variant=<merged|split>  이 프롬프트 변형만 잽니다.
 *   --max-input-tokens=<N> 근거 입력 상한을 바꿔 patch 몫이 질문 품질에 미치는 영향을 봅니다.
 *   --reasoning-format=<parsed|raw|hidden>  Groq 추론 모델의 사고 과정 처리 방식입니다. 지정하지
 *                          않으면 provider 기본값이고, 추론 모델은 사고 과정을 본문에 그대로 흘립니다.
 *   --first-chunk-timeout=<ms>  첫 청크 시한. 기본 20000
 *   --total-timeout=<ms>   생성 전체 시한. 기본 55000
 *   --check-errors         인증·모델 설정 실패의 오류 분류를 확인합니다. 정상 호출을 쓰지 않습니다.
 *   --sse-route            SSE route 전 구간을 실제 provider로 통과시킵니다. 프롬프트 가드와 이벤트
 *                          계약, seq 번호까지 프로덕션 코드로 확인합니다.
 *   --metadata-breakdown   근거 예산을 항목별 바이트로 쪼개 봅니다. LLM을 호출하지 않습니다.
 *
 * 재는 것:
 *   - 첫 청크 지연, 총 지연, 청크 수, 출력 길이
 *   - 입출력 토큰과 응답 헤더의 잔여 한도(문서가 아니라 헤더로 확인합니다)
 *   - 프롬프트 변형(한 문단 / 문단 분리)별 질문 품질 비교용 원문
 *   - 근거 스냅샷의 추정 토큰과 실제 입력 토큰의 관계. 크기가 다른 입력 두 건 이상이면
 *     바이트당 토큰과 고정 프롬프트 토큰을 선형으로 분리합니다.
 *
 * 출력에는 수치와 질문 원문만 담습니다. 토큰·키를 출력하지 않습니다.
 *
 * 측정 결과와 그에 따른 결정은
 * `llm-wiki/wiki/2026-08-25-첫-질문-생성-provider-실측과-재개-방침.md`에 있습니다.
 */

import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { streamText } from "ai";
import {
  buildExperienceEvidenceSnapshot,
  estimateEvidenceTokens,
} from "../../experience-candidates/evidence-snapshot";
import type {
  CandidateDiff,
  ExperienceCandidateListItem,
  ExperienceEvidenceSnapshot,
  StageBCandidateResult,
} from "../../experience-candidates/types";
import { NextRequest } from "next/server";
import {
  INTERVIEW_QUESTION_MAX_PROMPT_BYTES,
  INTERVIEW_QUESTION_MAX_RETRIES,
  buildInterviewQuestionPrompt,
  interviewQuestionPromptBytes,
  startInterviewQuestionStream,
  toThrowingTextStream,
  type GenerateInterviewQuestion,
} from "../question-generation";
import { renderInterviewEvidencePrompt, type InterviewPromptVariant } from "../question-prompt";
import { createSseEventParser, type InterviewStreamEvent } from "../sse";
import { handleInterviewQuestionStream } from "../../../app/api/interview/stream/route";
import { encryptGitHubToken, GITHUB_SESSION_COOKIE } from "../../../lib/github/auth-session";
import { GITHUB_API_BASE, githubFetch, parseJson } from "../../../lib/github/commits";
import { fetchCommitDetailBySha, withoutPatch } from "../../../lib/github/contributions";
import type { CandidateDataOutput, CommitDetail } from "../../../lib/github/types";

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const owner = flag("owner", "hm1n");
const repo = flag("repo", "demian");
const maxCommits = Number(flag("max-commits", "6"));
const pullRequestNumbers = args
  .filter((arg) => arg.startsWith("--pr="))
  .map((arg) => Number(arg.split("=")[1]));
const skipGemini = args.includes("--skip-gemini");
const skipGroq = args.includes("--skip-groq");
const skipDeepinfra = args.includes("--skip-deepinfra");
const providerFilter = flag("provider", "");
const metadataBreakdown = args.includes("--metadata-breakdown");
const maxInputTokens = Number(flag("max-input-tokens", "0")) || undefined;
const variantFilter = flag("variant", "");
const modelFilter = flag("model", "");
const reasoningFormat = flag("reasoning-format", "");
const firstChunkTimeoutMs = Number(flag("first-chunk-timeout", "20000"));
const totalTimeoutMs = Number(flag("total-timeout", "55000"));
const checkErrors = args.includes("--check-errors");
const sseRoute = args.includes("--sse-route");

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.error("GITHUB_TOKEN이 필요합니다. GITHUB_TOKEN=$(gh auth token) 형태로 넘겨 주세요.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 근거 스냅샷 조립
// ---------------------------------------------------------------------------
// 실제 GitHub 응답으로 스냅샷을 만듭니다. 합성 diff로는 patch 예산과 실제 토큰의 관계를 잴 수
// 없습니다. Stage A·B가 만드는 값 가운데 이 스크립트가 대신 채우는 것은 두 개입니다. LLM 해석
// 문장과 인용 파일 경로입니다. 둘 다 확인 수준이 `AI가 고른 값`으로 실리므로 프롬프트에서 차지하는
// 자리는 실제와 같습니다.

async function fetchPullRequestCommitShas(pullRequestNumber: number): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullRequestNumber}/commits?per_page=100`;
  const response = await githubFetch(url, githubToken!);
  if (!response.ok) {
    throw new Error(`PR #${pullRequestNumber} 커밋 목록 조회 실패: ${response.status}`);
  }
  const commits = await parseJson<{ sha: string }[]>(response, "PR 커밋 목록");
  return commits.map(({ sha }) => sha);
}

function toDiff(detail: CommitDetail): CandidateDiff {
  return {
    sha: detail.sha,
    files: detail.files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      // GitHub 응답의 patch는 절단 여부를 알려주지 않습니다. Stage B가 자르는 몫은 여기서
      // 재현하지 않고, 이 스냅샷의 상한 절단만 `buildExperienceEvidenceSnapshot`이 표시합니다.
      ...(file.patch === undefined ? {} : { patch: file.patch }),
    })),
  };
}

async function buildSnapshot(pullRequestNumber: number): Promise<ExperienceEvidenceSnapshot> {
  const shas = (await fetchPullRequestCommitShas(pullRequestNumber)).slice(0, maxCommits);
  if (shas.length === 0) throw new Error(`PR #${pullRequestNumber}에 커밋이 없습니다.`);

  const details: CommitDetail[] = [];
  for (const sha of shas) {
    details.push(await fetchCommitDetailBySha({ owner, repo, token: githubToken! }, sha));
  }

  const [representative, ...related] = details;
  const citedFilePaths = representative.files
    .slice()
    .sort((left, right) => right.changes - left.changes)
    .slice(0, 2)
    .map(({ path }) => path);
  const candidate = {
    sha: representative.sha,
    relatedShas: related.map(({ sha }) => sha),
    evidence: `Pull Request #${pullRequestNumber}의 커밋 ${details.length}개가 같은 문제를 함께 다뤘고, 변경 파일과 diff에서 판단 근거를 확인할 수 있습니다.`,
    citedFilePaths,
    source: "automatic_recommendation" as const,
  };

  const item: ExperienceCandidateListItem = {
    candidate,
    commit: withoutPatch(representative),
    origin: "repository",
    normalizedRelatedShas: candidate.relatedShas,
    normalizedCitedFilePaths: citedFilePaths,
  };
  // 커밋 제목·메시지·PR·변경 파일 목록은 patch가 벗겨진 상태로 오고 patch 본문은 diff에만 있습니다.
  // 운영 경로와 같은 출처 분기를 그대로 재현합니다.
  const data: CandidateDataOutput = {
    allCommits: [],
    includedCommits: details.map(withoutPatch),
    repository: { fileTree: [], treeTruncated: false, languages: {} },
  };
  const candidates: StageBCandidateResult = {
    candidates: [candidate],
    insufficientCandidatesReason: null,
    diffs: details.map(toDiff),
  };

  // 프로덕션과 같은 방식으로 재야 patch 몫이 같습니다. `confirmExperienceSelection`이 넘기는 것과
  // 같은 렌더러를 넘깁니다.
  const result = buildExperienceEvidenceSnapshot(
    item,
    data,
    candidates,
    maxInputTokens,
    renderInterviewEvidencePrompt
  );
  if (!result.ok) throw new Error(`PR #${pullRequestNumber} 스냅샷 조립 실패: ${result.reason}`);
  return result.snapshot;
}

// ---------------------------------------------------------------------------
// 측정용 provider 호출
// ---------------------------------------------------------------------------
// 프롬프트와 스트림 소비는 운영 코드(`buildInterviewQuestionPrompt`, `startInterviewQuestionStream`)를
// 그대로 씁니다. 여기서 다시 만드는 것은 provider 선택과 메타데이터 수집뿐입니다. 프롬프트를
// 손으로 다시 접으면 재는 대상과 배포되는 대상이 갈립니다.

interface CallMetadata {
  inputTokens: number | null;
  outputTokens: number | null;
  /** 사고 토큰입니다. 첫 청크 전에 소비되므로 첫 청크 지연의 직접 원인입니다. */
  reasoningTokens: number | null;
  rateLimitHeaders: Record<string, string>;
}

type ProviderId = "groq" | "google" | "deepinfra";

// DeepInfra는 OpenAI 호환 엔드포인트만 냅니다. 새 의존성을 넣지 않고 `llm-provider.ts`의
// `requireLocalModel`과 같은 방식으로 Groq 클라이언트의 baseURL을 갈아 씁니다. 즉 여기서 재는 배선
// 비용이 실제 전환 비용과 같습니다.
const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

function resolveModel(provider: ProviderId, model: string) {
  if (provider === "google") return createGoogle()(model);
  if (provider === "deepinfra") {
    const apiKey = process.env.DEEPINFRA_API_KEY;
    if (!apiKey) throw new Error("DEEPINFRA_API_KEY가 필요합니다.");
    return createGroq({ baseURL: DEEPINFRA_BASE_URL, apiKey })(model);
  }
  return createGroq()(model);
}


function createMeasuredGenerate(
  provider: ProviderId,
  model: string,
  onMetadata: (metadata: CallMetadata) => void
): GenerateInterviewQuestion {
  return ({ system, evidence }, abortSignal) => {
    const result = streamText({
      model: resolveModel(provider, model),
      system,
      prompt: evidence,
      abortSignal,
      maxRetries: INTERVIEW_QUESTION_MAX_RETRIES,
      // 추론 모델은 사고 과정을 본문에 그대로 흘립니다. Groq는 그 처리 방식을 요청 단위로 받습니다.
      ...(provider === "groq" && reasoningFormat !== ""
        ? { providerOptions: { groq: { reasoningFormat } } }
        : {}),
    });
    return (async function* () {
      yield* toThrowingTextStream(result);
      const [usage, response, providerMetadata] = await Promise.all([
        result.usage,
        result.response,
        result.providerMetadata,
      ]);
      // 사고 토큰의 자리는 provider마다 다릅니다. SDK의 공통 usage에 없으면 Google 메타데이터에서
      // 찾습니다. 첫 청크 전에 소비되는 토큰이라 첫 청크 지연을 설명하는 값입니다.
      const usageRecord = usage as unknown as Record<string, unknown>;
      const googleMetadata = (providerMetadata?.google ?? {}) as Record<string, unknown>;
      const reasoningTokens =
        typeof usageRecord.reasoningTokens === "number"
          ? usageRecord.reasoningTokens
          : typeof googleMetadata.thoughtsTokenCount === "number"
            ? googleMetadata.thoughtsTokenCount
            : null;
      onMetadata({
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        reasoningTokens,
        rateLimitHeaders: Object.fromEntries(
          Object.entries(response.headers ?? {}).filter(([name]) =>
            name.toLowerCase().startsWith("x-ratelimit-")
          )
        ),
      });
    })();
  };
}

/**
 * 실패 응답의 한도 헤더를 꺼냅니다. 무료 등급 한도는 문서가 아니라 응답 헤더로 확인합니다.
 * 매핑된 오류의 `cause`가 provider의 `APICallError`입니다.
 */
function failureRateLimitHeaders(error: unknown): Record<string, string> {
  const headers = (error as { cause?: { responseHeaders?: Record<string, string> } }).cause
    ?.responseHeaders;
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith("x-ratelimit-"))
  );
}

interface RunResult {
  label: string;
  provider: ProviderId;
  model: string;
  variant: InterviewPromptVariant;
  pullRequestNumber: number;
  promptBytes: number;
  estimatedTokens: number;
  firstChunkMs: number | null;
  totalMs: number;
  chunkCount: number;
  questionChars: number;
  question: string;
  metadata: CallMetadata | null;
  errorKind: string | null;
}

async function run(
  provider: ProviderId,
  model: string,
  variant: InterviewPromptVariant,
  pullRequestNumber: number,
  snapshot: ExperienceEvidenceSnapshot
): Promise<RunResult> {
  const prompt = buildInterviewQuestionPrompt(snapshot, variant);
  const base = {
    label: `${provider}/${model} ${variant}`,
    provider,
    model,
    variant,
    pullRequestNumber,
    promptBytes: interviewQuestionPromptBytes(prompt),
    estimatedTokens: estimateEvidenceTokens(snapshot),
  };

  let metadata: CallMetadata | null = null;
  const generate = createMeasuredGenerate(provider, model, (value) => {
    metadata = value;
  });

  const startedAt = performance.now();
  let firstChunkMs: number | null = null;
  let chunkCount = 0;
  let question = "";
  try {
    const stream = await startInterviewQuestionStream(snapshot, {
      generate,
      variant,
      firstChunkTimeoutMs,
      totalTimeoutMs,
    });
    firstChunkMs = performance.now() - startedAt;
    question = stream.firstText;
    chunkCount = 1;
    for (;;) {
      const text = await stream.next();
      if (text === null) break;
      question += text;
      chunkCount += 1;
    }
    await stream.close();
  } catch (error) {
    const headers = failureRateLimitHeaders(error);
    console.log(
      `  실패 상태 ${(error as { cause?: { statusCode?: number } }).cause?.statusCode ?? "-"} / ${(error as Error).message}`
    );
    if (Object.keys(headers).length > 0) {
      console.log(`  실패 응답 한도 헤더: ${JSON.stringify(headers)}`);
    }
    return {
      ...base,
      firstChunkMs,
      totalMs: performance.now() - startedAt,
      chunkCount,
      questionChars: question.length,
      question,
      metadata,
      errorKind: (error as { kind?: string }).kind ?? (error as Error).name,
    };
  }

  return {
    ...base,
    firstChunkMs,
    totalMs: performance.now() - startedAt,
    chunkCount,
    questionChars: question.length,
    question,
    metadata,
    errorKind: null,
  };
}

// ---------------------------------------------------------------------------
// 오류 분류 확인
// ---------------------------------------------------------------------------
// 방어 코드가 실제로 도달하는지 확인합니다. 잘못된 키와 없는 모델을 일부러 보내 분류를 봅니다.

async function checkErrorClassification(snapshot: ExperienceEvidenceSnapshot): Promise<void> {
  const cases: { name: string; generate: GenerateInterviewQuestion }[] = [
    {
      name: "잘못된 API 키",
      generate: ({ system, evidence }, abortSignal) =>
        toThrowingTextStream(
          streamText({
            model: createGroq({ apiKey: "invalid-key-for-measurement" })("openai/gpt-oss-120b"),
            system,
            prompt: evidence,
            abortSignal,
          })
        ),
    },
    {
      name: "없는 모델",
      generate: ({ system, evidence }, abortSignal) =>
        toThrowingTextStream(
          streamText({
            model: createGroq()("model-that-does-not-exist"),
            system,
            prompt: evidence,
            abortSignal,
          })
        ),
    },
    {
      name: "첫 청크 시한 초과",
      generate: (_prompt, abortSignal) =>
        (async function* () {
          // 중단 신호를 관측하는 스트림입니다. 실제 provider 스트림은 abortSignal에 반응합니다.
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            abortSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(abortSignal.reason ?? new DOMException("aborted", "AbortError"));
            });
          });
          yield "늦은 청크";
        })(),
    },
    {
      name: "청크 없이 끝난 생성",
      generate: () =>
        (async function* () {
          // 빈 조각만 보내고 끝냅니다. 안전 필터나 즉시 중단으로 본문이 없는 경우와 같은 모양입니다.
          yield "";
        })(),
    },
  ];

  console.log("\n## 오류 분류 확인\n");
  for (const { name, generate } of cases) {
    try {
      const stream = await startInterviewQuestionStream(snapshot, {
        generate,
        firstChunkTimeoutMs: name === "첫 청크 시한 초과" ? 500 : 20_000,
      });
      await stream.close();
      console.log(`- ${name}: 오류가 발생하지 않았습니다. 첫 청크 ${stream.firstText.length}자`);
    } catch (error) {
      const kind = (error as { kind?: string }).kind ?? (error as Error).name;
      const status = (error as { cause?: { statusCode?: number } }).cause?.statusCode ?? "-";
      const headers = failureRateLimitHeaders(error);
      console.log(
        `- ${name}: kind=${kind} status=${status} message=${(error as Error).message}` +
          (Object.keys(headers).length > 0 ? ` headers=${JSON.stringify(headers)}` : "")
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SSE route 전 구간
// ---------------------------------------------------------------------------
// 모델과 프롬프트는 위 경로로 확인했지만 route를 통과하는 전 구간은 확인하지 않았습니다. 여기서
// 확인하는 것은 provider 응답이 아니라 **그 사이의 배선**입니다. 세션 쿠키 검사, 본문 스키마 검사,
// 프롬프트 바이트 가드, 첫 조각 시한, SSE 이벤트 계약과 seq 번호입니다. `generate`를 주입하지
// 않으므로 route가 프로덕션 기본값을 그대로 씁니다.

async function measureSseRoute(
  pullRequestNumber: number,
  snapshot: ExperienceEvidenceSnapshot
): Promise<void> {
  const promptBytes = interviewQuestionPromptBytes(buildInterviewQuestionPrompt(snapshot));
  console.log(
    `
## SSE route 전 구간 / PR #${pullRequestNumber}

` +
      `- 프롬프트 ${promptBytes}바이트 대 가드 ${INTERVIEW_QUESTION_MAX_PROMPT_BYTES}바이트`
  );

  // 세션 쿠키는 route가 실제로 검사하는 값입니다. 토큰 문자열은 이 경로에서 쓰이지 않으므로
  // 자리만 채웁니다. 암호화 키는 `.env`의 운영 키를 그대로 씁니다.
  const request = new NextRequest("https://example.com/api/interview/stream", {
    method: "POST",
    headers: { cookie: `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("measurement-placeholder")}` },
    body: JSON.stringify({ snapshot }),
  });

  const startedAt = performance.now();
  const response = await handleInterviewQuestionStream(request);
  const headerMs = performance.now() - startedAt;
  console.log(
    `- 상태 ${response.status} / Content-Type ${response.headers.get("Content-Type")} / 헤더까지 ${formatMs(headerMs)}`
  );
  if (response.status !== 200 || response.body === null) {
    const body = await response.text();
    console.log(`- 본문 ${body.slice(0, 200)}`);
    return;
  }

  const parser = createSseEventParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events: InterviewStreamEvent[] = [];
  let firstEventMs: number | null = null;
  let questionChars = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      if (firstEventMs === null) firstEventMs = performance.now() - startedAt;
      events.push(event);
      if (event.type === "chunk") questionChars += event.text.length;
    }
  }

  const chunkEvents = events.filter((event) => event.type === "chunk");
  const lastEvent = events.at(-1);
  const seqs = chunkEvents.map((event) => (event.type === "chunk" ? event.seq : 0));
  const seqContiguous = seqs.every((seq, index) => seq === index + 1);
  console.log(`- 첫 이벤트 ${formatMs(firstEventMs)} / 전체 ${formatMs(performance.now() - startedAt)}`);
  console.log(`- chunk ${chunkEvents.length}개 / 질문 ${questionChars}자 / seq 연속 ${seqContiguous}`);
  console.log(
    `- 마지막 이벤트 ${lastEvent?.type ?? "없음"}` +
      (lastEvent?.type === "done" ? ` seq=${lastEvent.seq}` : "") +
      (lastEvent?.type === "error" ? ` kind=${lastEvent.kind}` : "")
  );
  console.log(
    `- done의 seq와 마지막 chunk의 seq 일치 ` +
      `${lastEvent?.type === "done" && lastEvent.seq === seqs.at(-1)}`
  );
  // 질문 원문도 남깁니다. 이 경로가 실제 route를 통과하므로, 사용자가 화면에서 읽을 문장과 같습니다.
  // 수치만 남기면 배선은 확인되지만 질문이 근거에 붙어 있는지는 사람이 볼 수 없습니다.
  const question = chunkEvents
    .map((event) => (event.type === "chunk" ? event.text : ""))
    .join("");
  console.log("  --- 질문 ---");
  console.log(question);
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function formatMs(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const numbers = pullRequestNumbers.length > 0 ? pullRequestNumbers : [61];
  const snapshots = new Map<number, ExperienceEvidenceSnapshot>();
  for (const number of numbers) {
    const snapshot = await buildSnapshot(number);
    snapshots.set(number, snapshot);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    console.log(
      [
        `PR #${number} 스냅샷: 커밋 ${1 + snapshot.relatedCommits.length}개`,
        `직렬화 ${serializedBytes}바이트`,
        `추정 토큰 ${estimateEvidenceTokens(snapshot)}`,
        `metadataTokens ${snapshot.patchBudget.metadataTokens}`,
        `patchBytes ${snapshot.patchBudget.patchBytes}/${snapshot.patchBudget.maxPatchBytes}`,
        `절단 ${snapshot.patchBudget.truncatedByBudget}`,
      ].join(" / ")
    );
  }

  if (metadataBreakdown) {
    // 메타데이터가 근거 예산을 어디서 먹는지 항목별로 잽니다. 예산은 JSON 직렬화 바이트로 걸리므로
    // 각 항목을 같은 방식으로 재야 비교됩니다. 내용은 출력하지 않고 바이트와 토큰만 냅니다.
    for (const number of numbers) {
      const snapshot = snapshots.get(number)!;
      const bytesOf = (value: unknown) =>
        new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
      const commits = [snapshot.representativeCommit, ...snapshot.relatedCommits];
      const sum = (pick: (commit: (typeof commits)[number]) => unknown) =>
        commits.reduce((total, commit) => total + bytesOf(pick(commit)), 0);
      const filesWithoutPatch = commits.reduce(
        (total, commit) =>
          total +
          commit.files.reduce(
            (fileTotal, file) =>
              fileTotal +
              bytesOf({
                path: file.path,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patchTruncated: file.patchTruncated,
                patchOmittedReason: file.patchOmittedReason,
              }),
            0
          ),
        0
      );
      const patchBytes = commits.reduce(
        (total, commit) =>
          total + commit.files.reduce((fileTotal, file) => fileTotal + bytesOf(file.patch), 0),
        0
      );
      const rows: [string, number][] = [
        ["커밋 sha", sum((commit) => commit.sha)],
        ["커밋 role·indexed", sum((commit) => ({ role: commit.role, indexed: commit.indexed }))],
        ["커밋 title", sum((commit) => commit.title)],
        ["커밋 message", sum((commit) => commit.message)],
        ["커밋 pullRequests", sum((commit) => commit.pullRequests)],
        ["커밋 verifiability", sum((commit) => commit.verifiability)],
        ["파일 목록(patch 제외)", filesWithoutPatch],
        ["patch 본문", patchBytes],
        ["evidence(해석 문장)", bytesOf(snapshot.evidence)],
        ["citedFilePaths", bytesOf(snapshot.citedFilePaths)],
        ["unverifiableItems", bytesOf(snapshot.unverifiableItems)],
        ["patchBudget", bytesOf(snapshot.patchBudget)],
        ["candidateSha·source·origin", bytesOf({
          candidateSha: snapshot.candidateSha,
          source: snapshot.source,
          origin: snapshot.origin,
        })],
      ];
      const total = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
      // 예산이 재는 대상은 렌더된 프롬프트입니다. 실제 상한 준수를 여기서도 확인합니다.
      const promptBytes = interviewQuestionPromptBytes(
        buildInterviewQuestionPrompt(snapshot, "split")
      );
      const promptTokens = estimateEvidenceTokens(renderInterviewEvidencePrompt(snapshot));
      const fileCount = commits.reduce((count, commit) => count + commit.files.length, 0);
      console.log(
        `
[PR #${number}] 커밋 ${commits.length}개 / 파일 ${fileCount}개 / 직렬화 ${total}바이트 / ` +
          `metadataTokens ${snapshot.patchBudget.metadataTokens}` +
          ` / 프롬프트 ${promptBytes}바이트 / 근거 추정 ${promptTokens}토큰 대 상한 ${snapshot.patchBudget.maxInputTokens}`
      );
      for (const [label, bytes] of rows.sort((left, right) => right[1] - left[1])) {
        const share = ((bytes / total) * 100).toFixed(1);
        console.log(`  ${label}: ${bytes}바이트 (${share}%) / 추정 ${Math.ceil(bytes / 3)}토큰`);
      }
    }
    return;
  }

  if (checkErrors) {
    await checkErrorClassification(snapshots.get(numbers[0])!);
    return;
  }

  if (sseRoute) {
    for (const number of numbers) {
      await measureSseRoute(number, snapshots.get(number)!);
    }
    return;
  }

  // 모델과 프롬프트 변형의 교차입니다. 전부 한 번에 돌리면 Groq 분당 토큰 한도(8,000)를 넘습니다.
  // 한 호출이 입력 약 2,900 + 출력 약 1,400 토큰이라 한 번에 두 호출까지입니다. `--model`과
  // `--variant`로 나눠 돌리고 사이에 창이 초기화될 시간을 둡니다.
  const models: { provider: ProviderId; model: string }[] = [
    ...(skipGroq
      ? []
      : [
          { provider: "groq" as const, model: "openai/gpt-oss-120b" },
          { provider: "groq" as const, model: "openai/gpt-oss-20b" },
          // Stage A의 `openai/gpt-oss-120b`와 일일 토큰 한도를 공유하지 않는 후보입니다. Groq
          // `/models` 응답(2026-08-25)에서 서빙 중인 범용 생성 모델 가운데 이 조건을 만족하는 것은
          // 이 모델뿐입니다. `groq/compound` 계열은 내장 도구로 외부 정보를 끌어와 근거 밖 사실을
          // 만들 통로가 생기므로 후보에서 뺐습니다. `openai/gpt-oss-safeguard-20b`는 분류 모델이고
          // `allam-2-7b`는 컨텍스트가 4,096으로 이 프롬프트를 담지 못합니다.
          { provider: "groq" as const, model: "qwen/qwen3.6-27b" },
          // 내장 도구로 저장소 밖 정보를 끌어올 수 있어 근거 밖 사실이 들어올 통로가 있습니다.
          // 그래도 후보에서 말로만 빼지 않고 한 번 재봅니다.
          { provider: "groq" as const, model: "groq/compound-mini" },
        ]),
    ...(skipGemini
      ? []
      : [
          { provider: "google" as const, model: "gemini-3.6-flash" },
          // Stage A·B 확정 모델입니다. 배치에서 사고 토큰을 쓰지 않아 첫 청크가 빠를 수 있으나
          // 자유 텍스트 품질은 이 경로에서 재본 적이 없습니다.
          { provider: "google" as const, model: "gemini-3.1-flash-lite" },
          { provider: "google" as const, model: "gemini-3.5-flash-lite" },
        ]),
    // Groq 유료 전환이 막혀 있어 같은 모델을 다른 곳에서 서빙할 때의 값이 필요합니다.
    ...(skipDeepinfra
      ? []
      : [
          { provider: "deepinfra" as const, model: "openai/gpt-oss-120b" },
          { provider: "deepinfra" as const, model: "openai/gpt-oss-20b" },
        ]),
  ];
  const variants: InterviewPromptVariant[] = ["split", "merged"];
  const configs = models
    .flatMap((model) => variants.map((variant) => ({ ...model, variant })))
    .filter(
      (config) =>
        (variantFilter === "" || config.variant === variantFilter) &&
        (modelFilter === "" || config.model === modelFilter) &&
        (providerFilter === "" || config.provider === providerFilter)
    );

  const results: RunResult[] = [];
  for (const number of numbers) {
    for (const config of configs) {
      const result = await run(
        config.provider,
        config.model,
        config.variant,
        number,
        snapshots.get(number)!
      );
      results.push(result);
      console.log(
        [
          `\n[PR #${number}] ${result.label}`,
          `프롬프트 ${result.promptBytes}바이트`,
          `첫 청크 ${formatMs(result.firstChunkMs)}`,
          `총 ${formatMs(result.totalMs)}`,
          `청크 ${result.chunkCount}개`,
          `출력 ${result.questionChars}자`,
          `입력 토큰 ${result.metadata?.inputTokens ?? "-"}`,
          `출력 토큰 ${result.metadata?.outputTokens ?? "-"}`,
          `사고 토큰 ${result.metadata?.reasoningTokens ?? "-"}`,
          result.errorKind ? `오류 ${result.errorKind}` : "",
        ]
          .filter((part) => part !== "")
          .join(" / ")
      );
      if (result.metadata && Object.keys(result.metadata.rateLimitHeaders).length > 0) {
        console.log(`  한도 헤더: ${JSON.stringify(result.metadata.rateLimitHeaders)}`);
      }
      if (result.question !== "") {
        console.log("  --- 질문 ---");
        console.log(
          result.question
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")
        );
      }
    }
  }

  // 토큰 환산식 교정용 선형 분리입니다. 입력 토큰은 고정 프롬프트 토큰과 근거 바이트에 비례하는
  // 몫의 합으로 봅니다. 같은 모델·같은 변형의 서로 다른 크기 두 건을 짝지어야 기울기가 근거
  // 바이트의 몫만 담습니다.
  console.log("\n## 토큰 환산 실측\n");
  const measured = results.filter(
    (result) => result.metadata?.inputTokens != null && result.errorKind === null
  );
  for (const result of measured) {
    const bytesPerToken = result.promptBytes / result.metadata!.inputTokens!;
    console.log(
      `- ${result.label} PR #${result.pullRequestNumber}: 프롬프트 ${result.promptBytes}바이트 / 입력 ${result.metadata!.inputTokens}토큰 = 바이트당 ${bytesPerToken.toFixed(3)}`
    );
  }
  const byModel = new Map<string, RunResult[]>();
  for (const result of measured) {
    const key = `${result.provider}/${result.model} ${result.variant}`;
    byModel.set(key, [...(byModel.get(key) ?? []), result]);
  }
  for (const [key, group] of byModel) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((left, right) => left.promptBytes - right.promptBytes);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    const deltaBytes = high.promptBytes - low.promptBytes;
    const deltaTokens = high.metadata!.inputTokens! - low.metadata!.inputTokens!;
    if (deltaBytes === 0 || deltaTokens === 0) continue;
    const marginalBytesPerToken = deltaBytes / deltaTokens;
    const fixedTokens = low.metadata!.inputTokens! - low.promptBytes / marginalBytesPerToken;
    console.log(
      `- ${key}: 한계 바이트당 ${marginalBytesPerToken.toFixed(3)}토큰분, 고정 프롬프트 ${fixedTokens.toFixed(0)}토큰`
    );
  }
}

await main();
