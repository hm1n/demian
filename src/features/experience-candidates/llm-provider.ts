import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { ExperienceCandidateOutputError } from "./errors";

/**
 * Stage A·Stage B가 쓰는 LLM 제공자를 한 곳에서 결정합니다.
 *
 * 이슈 #66 배경입니다. 2026-08-26 발표 시연에 파이프라인 1회 완주가 필요한데 두 단계 모두
 * 외부 제공자 한도에 막혔습니다. Stage A는 Groq 무료 등급 분당 토큰 한도(TPM 8,000)에 정상 호출
 * 하나가 약 7,100 토큰을 써서 복구 호출이 곧바로 한도를 넘겼고, Stage B는 `gemini-3.7-flash`가
 * `"say hi"` 두 토큰 출력에 16.0~119.2초를 써서 예산 55초 안에 끝나지 않았습니다.
 *
 * 그래서 환경변수가 있을 때만 로컬 OpenAI 호환 엔드포인트(Ollama)로 갈아탑니다. `createGroq()`가
 * `baseURL`을 받으므로 의존성을 추가하지 않습니다. Gemini API는 OpenAI 호환이 아니라서 로컬에서는
 * Stage B도 같은 OpenAI 호환 경로를 탑니다.
 *
 * 로컬 실행 결과는 계약 준수율이나 후보 품질의 근거로 쓰지 않습니다. 프로덕션 판단 품질의 근거는
 * 이슈 #69 실측입니다. 로컬은 파이프라인이 끝까지 돌아가는지만 봅니다.
 *
 * 2026-09-01에 두 단계의 프로덕션 제공자를 Google Gemini 유료 등급으로 모았습니다. Stage A는
 * `gemini-3.1-flash-lite`, Stage B는 `gemini-3.5-flash-lite`입니다. 근거와 탈락 사유는
 * `llm-wiki/wiki/2026-09-01-네-경로-LLM-모델-확정.md`에 있습니다.
 *
 * 환경변수를 읽는 시점을 함수 호출 시점으로 미룹니다. `candidate-client.ts`가 `stage-b.ts`를
 * import하므로 이 모듈은 클라이언트 번들에도 실립니다. 모듈 최상단에서 읽으면 서버 전용 값을
 * 번들 시점에 고정하게 됩니다.
 *
 * 스위치가 `NEXT_PUBLIC_` 접두사를 쓰는 이유입니다. 로컬 전환 여부를 브라우저도 알아야 합니다.
 * Stage B 입력 커밋 수 상한을 `candidate-client.ts`가 브라우저에서 적용하므로, 스위치가 서버
 * 전용이면 그 상한을 로컬 여부로 가를 수 없습니다. 접속 주소는 비밀이 아니라 클라이언트 번들에
 * 실려도 무해합니다. 인증 키는 서버 전용으로 남깁니다.
 */
export interface LocalLlmConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly stageAModel: string | null;
  readonly stageBModel: string | null;
}

/**
 * `NEXT_PUBLIC_LLM_BASE_URL`이 없으면 null입니다. 그때는 프로덕션 경로(Stage A·Stage B 모두 Google)가
 * 그대로 동작합니다. 이 함수 하나가 로컬 전환의 유일한 스위치입니다.
 */
export function resolveLocalLlm(): LocalLlmConfig | null {
  const baseURL = process.env.NEXT_PUBLIC_LLM_BASE_URL?.trim();
  if (!baseURL) return null;
  return {
    baseURL,
    // Ollama의 OpenAI 호환 계층은 키를 검사하지 않지만 `@ai-sdk/groq`는 키가 없으면 요청 전에
    // `LoadAPIKeyError`를 던집니다. 로컬에서 키를 따로 설정하지 않아도 되게 자리값을 채웁니다.
    apiKey: process.env.LLM_API_KEY?.trim() || "ollama",
    stageAModel: process.env.STAGE_A_MODEL?.trim() || null,
    stageBModel: process.env.STAGE_B_MODEL?.trim() || null,
  };
}

export function isLocalLlm(): boolean {
  return resolveLocalLlm() !== null;
}

function requireLocalModel(config: LocalLlmConfig, model: string | null, envName: string) {
  if (!model) {
    // 프로덕션 모델 ID를 로컬 엔드포인트에 그대로 보내면 404가 되고, 그 404는 `mapLlmError`에서
    // 모델 설정 오류로 뭉개져 원인이 환경변수 누락이라는 사실이 드러나지 않습니다.
    throw new ExperienceCandidateOutputError(
      "llm_configuration",
      `NEXT_PUBLIC_LLM_BASE_URL을 설정했으면 ${envName}도 설정해야 합니다.`
    );
  }
  return createGroq({ baseURL: config.baseURL, apiKey: config.apiKey })(model);
}

/**
 * 모델 ID 환경변수는 `NEXT_PUBLIC_LLM_BASE_URL`이 설정된 경우에만 적용합니다. 프로덕션 기본 동작을 바꾸지
 * 않아야 하므로 로컬 전환 없이 모델만 갈아타는 경로는 열지 않습니다.
 */
export function createStageAModel(model: string) {
  const local = resolveLocalLlm();
  // 2026-09-01에 Groq에서 Google로 옮겼습니다. 근거는
  // `llm-wiki/wiki/2026-09-01-네-경로-LLM-모델-확정.md`입니다. Groq는 유료 전환이 막혀 있고 무료
  // 등급 분당 8,000토큰이 이 단계의 입력을 받지 못합니다.
  if (!local) return createGoogle()(model);
  return requireLocalModel(local, local.stageAModel, "STAGE_A_MODEL");
}

export function createStageBModel(model: string) {
  const local = resolveLocalLlm();
  if (!local) return createGoogle()(model);
  return requireLocalModel(local, local.stageBModel, "STAGE_B_MODEL");
}

/**
 * 로컬 컨텍스트에 맞춰 Stage B 입력을 줄이는 개발 환경 전용 값입니다.
 *
 * 2026-08-25 실측입니다. 프로덕션 입력(커밋 30개, patch 총 60,000자)은 직렬화 145KB이고
 * 토큰 환산으로 6만 토큰을 넘습니다. RTX 4070 Laptop(VRAM 8,188MiB)에서 `qwen2.5:7b`를 100% GPU로
 * 유지할 수 있는 컨텍스트는 16,384 토큰이고, 커밋 8개·patch 12,000자가 12,329 토큰이라 이 조합이
 * GPU 안에서 완주합니다. 커밋 12개·patch 20,000자는 18,136 토큰으로 컨텍스트를 넘습니다.
 *
 * 두 값 모두 `NEXT_PUBLIC_` 접두사를 씁니다. 입력 커밋 수 상한은 `candidate-client.ts`가
 * 브라우저에서 적용하므로 서버 전용 환경변수로는 읽을 수 없습니다.
 *
 * 로컬 전환이 아니면 두 값을 무시합니다. 이 게이트가 없으면 축소값을 남겨 둔 채 스위치만 끈
 * 상태에서 프로덕션 Stage B가 시연용 축소 입력을 그대로 받습니다. 커밋 30개가 4개로 줄어
 * 근거의 대부분이 사라지는데 화면에는 정상으로 보입니다(Codex 리뷰 P2). 이슈 #66의 제약이
 * "환경변수 미설정 시 기존 Groq·Gemini 동작이 바뀌지 않아야 합니다"이므로 제약 위반입니다.
 *
 * 프로덕션 상수보다 크게는 만들지 못합니다. 이 값은 로컬 사정으로 입력을 줄이는 용도이고,
 * 프로덕션 예산은 이슈 #19 실측(상세 조회 커밋당 868밀리초, 파일별 patch 중앙 1,257자)에
 * 묶여 있습니다. 잘못 설정한 환경변수가 프로덕션 예산을 늘리는 경로를 열지 않습니다.
 */
function resolveShrunkLimit(raw: string | undefined, fallback: number): number {
  if (!isLocalLlm()) return fallback;
  const value = Number(raw?.trim());
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, fallback);
}

export function resolveStageBMaxInputCommits(fallback: number): number {
  return resolveShrunkLimit(process.env.NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS, fallback);
}

export function resolveStageBMaxTotalPatchChars(fallback: number): number {
  return resolveShrunkLimit(process.env.NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS, fallback);
}

/**
 * 로컬 실행에서만 쓰는 시한입니다. 로컬 전환이 아니면 프로덕션 시한을 그대로 돌려줍니다.
 *
 * 프로덕션 시한은 이슈 #19 실측에 묶여 있습니다. Stage A 55초는 route maxDuration 60초보다 먼저
 * JSON 오류를 반환하기 위한 값이고, Stage B 55초도 같은 근거입니다. 로컬 모델이 느린 사정으로
 * 이 값을 바꾸면 프로덕션이 배포 한도 안에서 끝난다는 보장이 깨집니다.
 *
 * 2026-08-25 실측입니다. `qwen2.5:7b`로 Stage B 한 번이 54.2초라 55초 예산과 사실상 같습니다.
 * 로컬 시연에서는 이 값을 늘려 완주시키고, 프로덕션 상수는 건드리지 않습니다.
 */
export function resolveLlmTimeoutMs(fallback: number): number {
  if (!isLocalLlm()) return fallback;
  const value = Number(process.env.LLM_TIMEOUT_MS?.trim());
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

/**
 * 로컬 모델에만 주는 샘플링 설정입니다.
 *
 * 프로덕션은 제공자 기본값을 그대로 씁니다. 이슈 #19 실측이 그 조건에서 나왔습니다.
 *
 * 2026-08-25 실측입니다. 기본 샘플링으로 화면 경로에서 Stage A를 4회 연속 돌렸을 때 모델이
 * 입력에 없는 PR 번호를 답해 4회 모두 `unknown_sha`로 끝났습니다. 입력 요약에 담긴 커밋 제목의
 * `Merge pull request #35` 같은 문구를 판단 대상으로 끌어오는 형태였습니다.
 */
export function localSamplingOptions(): { temperature?: number } {
  if (!isLocalLlm()) return {};
  // 빈 문자열을 먼저 걸러야 합니다. `Number("")`는 0이고 0은 유효한 온도라서, 값을 지운 환경변수가
  // 온도를 0으로 고정하는 설정과 구별되지 않습니다.
  const raw = process.env.LLM_TEMPERATURE?.trim();
  if (!raw) return {};
  const temperature = Number(raw);
  return Number.isFinite(temperature) && temperature >= 0 ? { temperature } : {};
}
