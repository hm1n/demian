import { APICallError, generateObject, LoadAPIKeyError, NoObjectGeneratedError, RetryError } from "ai";
import {
  ExperienceCandidateOutputError,
  isAuthFailureResponseBody,
  isModelOutputFailureResponseBody,
  isRateLimitResponseBody,
} from "./errors";
import {
  createStageBModel,
  isLocalLlm,
  judgmentSamplingOptions,
  LLM_MAX_RETRIES,
  resolveLlmTimeoutMs,
  resolveStageBMaxTotalPatchChars,
} from "./llm-provider";
import { assertCandidateEvidence, experienceCandidateOutputSchema, validateExperienceCandidateOutput } from "./schema";
import type { ExperienceCandidateOutput, StageACandidate } from "./types";
import type { CommitDetail } from "@/lib/github/types";

// 2026-09-01에 `gemini-3.7-flash`에서 옮겼습니다. 그 모델은 실데이터에서 55,016밀리초로
// `STAGE_B_TOTAL_BUDGET_MS`를 넘겨 `llm_timeout`으로 실패했습니다. 이 모델은 같은 입력에서
// 4,190밀리초이며 예산의 7.6%입니다. 인용 파일을 후보마다 5~9개 끌어와 `gemini-3.1-flash-lite`의
// 2개 고정보다 근거가 풍부했고, 그 차이에 회당 0.005달러를 지불하는 것이 이 선택의 내용입니다.
// 유료 등급 한도는 RPM 4,000, 분당 입력 토큰 4,000,000, RPD 150,000이고 프로젝트별이면서
// 모델별입니다. 근거는 `llm-wiki/wiki/2026-09-01-네-경로-LLM-모델-확정.md`에 있습니다.
export const STAGE_B_MODEL = "gemini-3.5-flash-lite";
/**
 * Stage B 입력 커밋 수 상한입니다.
 *
 * 이 값은 후보 수가 아니라 커밋 수입니다. Stage A가 PR 묶음을 판단하도록 바뀌면서 후보 하나가
 * 커밋 여러 개로 펼쳐지기 때문입니다. 이름도 `STAGE_B_MAX_CANDIDATES`에서 바꿨습니다.
 *
 * 30으로 정한 근거는 두 가지 실측 한도입니다.
 * - 상세 재조회가 커밋당 868밀리초입니다. 라우트 전체 예산 55초에서 최소 LLM 예산 20초를 빼면
 *   조회에 쓸 수 있는 시간이 35초이므로 약 40커밋이 한계입니다. 30커밋은 약 26초입니다.
 * - patch 전체 예산 60,000자를 30으로 나누면 커밋당 2,000자입니다. 파일별 patch 중앙값이
 *   1,257자이므로 커밋마다 최소 한 파일은 온전히 실립니다.
 *
 * 상한을 두지 않으면 `andbread` 후보 14묶음이 커밋 148개로 펼쳐져 조회 128초에 커밋당 405자가
 * 됩니다. 시간도 넘고 근거도 무의미해집니다. 근거는
 * `llm-wiki/wiki/2026-08-24-경험-판단단위-PR-묶음-전환-검토.md`에 있습니다.
 *
 * 이슈 #19 실측으로 확정한 균등 배분은 그대로 둡니다. 선착순 배분이던 시절에는 앞쪽 9개가
 * 예산을 다 써서 11개가 diff 없이 판단됐고, `buildStageBPayload`의 균등 배분으로 해소했습니다.
 */
export const STAGE_B_MAX_INPUT_COMMITS = 30;
// 이슈 #19 실측으로 확정: 파일별 patch는 중앙 1,257자, p90 5,235자, 최대 44,013자였고
// 4,000자는 279개 파일 중 40개(14%)만 절단합니다.
export const STAGE_B_MAX_PATCH_CHARS = 4_000;
export const STAGE_B_MAX_TOTAL_PATCH_CHARS = 60_000;
// 이슈 #19 실측으로 확정: 성공 호출은 5.4~19.9초, 재시도까지 포함한 실패는 46.4초였습니다.
export const STAGE_B_TOTAL_BUDGET_MS = 55_000;
// 이슈 #19 실측으로 확정: 성공한 LLM 호출이 최대 19.9초 걸렸습니다. 잔여 10초로 호출을 시작하면
// 완주하지 못할 가능성이 높아, 관측된 최대 성공 시간을 담을 수 있는 20초로 올립니다.
export const STAGE_B_MIN_LLM_BUDGET_MS = 20_000;

export type GenerateStageB = (payload: unknown, abortSignal: AbortSignal) => Promise<unknown>;

/**
 * patch 예산을 후보별로 균등 배분합니다. 선착순으로 나눠주면 앞쪽 후보가 예산을 다 써서 뒤쪽
 * 후보는 diff 없이 판단됩니다. 이슈 #19 실측에서 후보 20개 중 11개가 patch를 한 글자도 받지
 * 못했고, 그 상태에서 모델이 **patch를 못 받은 후보를 실제로 최종 선정했습니다**(20개 중 9번과
 * 17번). "실제 diff와 PR 소속만 근거로" 고르라는 지시를 주면서 근거를 주지 않은 셈입니다.
 *
 * 배분 규칙입니다.
 * - 후보별 몫은 `STAGE_B_MAX_TOTAL_PATCH_CHARS`를 후보 수로 나눈 내림값입니다.
 * - 파일별 `STAGE_B_MAX_PATCH_CHARS` 상한은 후보의 몫 안에서 적용합니다. 몫이 파일 상한보다
 *   작으면 몫이 실질 상한이 됩니다.
 * - 몫을 다 쓰지 않은 후보의 잔액은 뒤 후보로 이월합니다. 이월은 앞에서 뒤로만 흐르므로 어떤
 *   후보도 자기 몫보다 적게 받지 않습니다.
 */
function mapPullRequest(pullRequest: CommitDetail["pullRequests"][number]) {
  const { number, title, state, baseBranch, headBranch } = pullRequest;
  return { number, title, state, baseBranch, headBranch };
}

/**
 * 커밋이 속한 Pull Request 중 대표 하나를 고릅니다. 번호가 가장 작은 것을 대표로 삼습니다.
 * `work-unit.ts`의 `resolvePullRequest`와 같은 규칙입니다. 커밋 하나가 PR 여러 개에 걸치는
 * 경우에도 항상 같은 대표를 골라야 묶음 키가 안정적입니다.
 */
function pickRepresentativePullRequest(
  pullRequests: readonly CommitDetail["pullRequests"][number][]
): CommitDetail["pullRequests"][number] | null {
  return pullRequests.reduce<CommitDetail["pullRequests"][number] | null>(
    (selected, pullRequest) =>
      selected === null || pullRequest.number < selected.number ? pullRequest : selected,
    null
  );
}

/**
 * 같은 Pull Request에 속한 커밋을 한 작업 묶음으로 묶는 키입니다. PR이 없는 커밋은 자기 SHA로
 * 자기 자신만의 묶음을 이룹니다. PR 없는 커밋은 원래 Stage A 그룹핑(`work-unit.ts`의
 * `no_pull_request` 제외)에서 걸러지므로 여기까지 오지 않는 게 정상이지만, 방어적으로 처리합니다.
 */
function resolveWorkUnitKey(commit: CommitDetail): string {
  const representative = pickRepresentativePullRequest(commit.pullRequests);
  return representative ? `pr:${representative.number}` : `commit:${commit.sha}`;
}

/**
 * Stage B 입력을 Pull Request 단위 묶음(`workUnits`)으로 구성합니다.
 *
 * 이전에는 커밋이 최상위 배열이라 같은 PR의 커밋들이 서로 독립인 항목처럼 보였습니다. 모델이
 * 그중 둘 이상을 최종 후보로 고르면 최종 후보 3개가 실제로는 경험 1개일 수 있었습니다
 * (Codex 리뷰 P1-1). 같은 PR의 커밋을 한 항목 안에 모아 모델이 "이건 한 경험"으로 읽게 합니다.
 *
 * patch 예산 배분은 그대로 커밋 전체 수를 분모로 씁니다. 묶음으로 감싸는 건 표현 방식일 뿐
 * 배분 로직과는 무관해야 하기 때문입니다.
 */
export function buildStageBPayload(commits: readonly CommitDetail[], candidates: readonly StageACandidate[]) {
  // 로컬 제공자로 시연할 때만 총량이 줄어듭니다. 환경변수를 설정하지 않으면 프로덕션 예산입니다.
  const totalPatchChars = resolveStageBMaxTotalPatchChars(STAGE_B_MAX_TOTAL_PATCH_CHARS);
  const share = commits.length === 0 ? 0 : Math.floor(totalPatchChars / commits.length);
  let carried = 0;
  const candidateBySha = new Map(candidates.map((candidate) => [candidate.sha, candidate]));

  const payloadCommits = commits.map((commit) => {
    let available = share + carried;
    const files = commit.files.map((file) => {
      const patch = file.patch?.slice(0, Math.min(STAGE_B_MAX_PATCH_CHARS, available));
      available -= patch?.length ?? 0;
      return {
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(patch ? { patch } : {}),
        ...(file.patch !== undefined && patch?.length !== file.patch.length ? { patchTruncated: true } : {}),
      };
    });
    carried = available;
    return {
      sha: commit.sha,
      message: commit.message,
      additions: commit.additions,
      deletions: commit.deletions,
      changedFiles: commit.changedFiles,
      source: candidateBySha.get(commit.sha)!.source,
      contributionItem: candidateBySha.get(commit.sha)!.contributionItem,
      pullRequests: commit.pullRequests.map(mapPullRequest),
      files,
    };
  });
  type PayloadCommit = (typeof payloadCommits)[number];

  const workUnits: { pullRequest: ReturnType<typeof mapPullRequest> | null; commits: PayloadCommit[] }[] = [];
  const groupIndexByKey = new Map<string, number>();

  commits.forEach((commit, index) => {
    const key = resolveWorkUnitKey(commit);
    let groupIndex = groupIndexByKey.get(key);
    if (groupIndex === undefined) {
      groupIndex = workUnits.length;
      groupIndexByKey.set(key, groupIndex);
      const representative = pickRepresentativePullRequest(commit.pullRequests);
      workUnits.push({ pullRequest: representative ? mapPullRequest(representative) : null, commits: [] });
    }
    workUnits[groupIndex].commits.push(payloadCommits[index]);
  });

  return { workUnits };
}

function mapLlmError(error: unknown): ExperienceCandidateOutputError {
  if (error instanceof ExperienceCandidateOutputError) return error;
  // SDK가 재시도한 실패는 `RetryError`로 감싸져 옵니다. `RetryError`는 `APICallError`가 아니므로
  // 벗기지 않으면 429·413 같은 한도와 재시도 대상 서버 오류가 전부 llm_failure로 뭉개집니다.
  // 이슈 #19 실측에서 Gemini 한도 초과와 과부하가 실제로 llm_failure로 보고됐습니다.
  if (RetryError.isInstance(error)) return mapLlmError(error.lastError);
  if (NoObjectGeneratedError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage B 구조화 응답이 출력 스키마와 일치하지 않습니다.",
      { cause: error }
    );
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "llm_configuration",
      "LLM API 키가 설정되지 않았습니다.",
      { cause: error }
    );
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new ExperienceCandidateOutputError(
      "llm_timeout",
      "Stage B 분석 시간이 초과되었습니다.",
      { cause: error }
    );
  }
  if (APICallError.isInstance(error)) {
    // Gemini는 잘못된 키를 401이 아니라 400 `INVALID_ARGUMENT`로 돌려줍니다. 본문의
    // `reason=API_KEY_INVALID`로 갈라야 요청 형식 오류와 섞이지 않습니다. 판별은 `errors.ts`에
    // 실측 근거와 함께 있습니다.
    if (
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      (error.statusCode === 400 && isAuthFailureResponseBody(error.responseBody))
    ) {
      return new ExperienceCandidateOutputError("llm_auth", "LLM 인증에 실패했습니다.", {
        cause: error,
      });
    }
    // 413도 한도일 수 있다. 이슈 #19 실측에서 Groq는 분당 토큰(TPM) 한도 초과를 429가 아니라
    // 413 `rate_limit_exceeded`로 반환했다. Stage B의 provider는 다르지만 같은 계약을 유지한다.
    // 상태 코드만으로 한도로 단정하면 페이로드가 실제로 너무 큰 413에도 재시도 안내가 나가므로
    // 본문으로 갈라 본다. Stage B는 diff를 싣기 때문에 요청 과대 413이 실제로 가능하다.
    if (
      error.statusCode === 429 ||
      (error.statusCode === 413 && isRateLimitResponseBody(error.responseBody))
    ) {
      return new ExperienceCandidateOutputError(
        "llm_rate_limit",
        "LLM 호출 한도에 도달했습니다.",
        { cause: error }
      );
    }
    // 한도가 아닌 413은 같은 입력으로 재시도해도 풀리지 않는다. 재시도 대상이 아닌 요청 오류다.
    if (error.statusCode === 413) {
      return new ExperienceCandidateOutputError(
        "llm_request",
        "Stage B 입력이 LLM이 받을 수 있는 크기를 넘었습니다.",
        { cause: error }
      );
    }
    if (error.statusCode === 408 || error.statusCode === 504) {
      return new ExperienceCandidateOutputError(
        "llm_timeout",
        "Stage B 분석 시간이 초과되었습니다.",
        { cause: error }
      );
    }
    if (error.statusCode === 404) {
      return new ExperienceCandidateOutputError(
        "llm_configuration",
        "LLM 모델 설정이 올바르지 않습니다.",
        { cause: error }
      );
    }
    // Gemini는 모델 과부하를 503 `UNAVAILABLE`로, 내부 오류를 500 `INTERNAL`로 돌려줍니다. Groq
    // 기준으로 배선했을 때는 이 갈래가 없어도 됐지만 flash 계열에서는 가장 흔한 일시 실패입니다.
    // 기다리면 풀리는 실패이므로 재시도 가능한 `llm_failure`로 두고, 문구에서 원인이 일시 장애임을
    // 밝힙니다. 504는 위에서 이미 시간 초과로 갈라 두었습니다.
    if ((error.statusCode ?? 0) >= 500) {
      return new ExperienceCandidateOutputError("llm_failure", "LLM 서비스가 일시적으로 응답하지 못했습니다.", {
        cause: error,
      });
    }
    // 400이라도 본문에 `json_validate_failed`가 있으면 요청이 아니라 모델 출력이 실패한 것이다.
    // 같은 입력을 다시 보내면 다른 출력이 나오므로 스키마 검증 실패로 분류해 재시도에 맡긴다.
    if (error.statusCode === 400 && isModelOutputFailureResponseBody(error.responseBody)) {
      return new ExperienceCandidateOutputError(
        "schema_validation",
        "LLM이 형식에 맞는 응답을 만들지 못했습니다.",
        { cause: error }
      );
    }
    if ([400, 409, 422].includes(error.statusCode ?? 0)) {
      return new ExperienceCandidateOutputError("llm_request", "LLM이 요청을 거부했습니다.", {
        cause: error,
      });
    }
    return new ExperienceCandidateOutputError("llm_failure", "Stage B 분석에 실패했습니다.", { cause: error });
  }
  if (error instanceof TypeError) {
    return new ExperienceCandidateOutputError("llm_network", "LLM에 연결하지 못했습니다.", {
      cause: error,
    });
  }
  return new ExperienceCandidateOutputError("llm_failure", "Stage B 분석에 실패했습니다.", { cause: error });
}

/**
 * 로컬 모델에만 붙이는 출력 계약 안내입니다. 프로덕션 프롬프트는 그대로 둡니다.
 *
 * `validateExperienceCandidateOutput`은 후보가 3개 미만이면 `insufficientCandidatesReason`을
 * 요구하지만 프로덕션 시스템 프롬프트는 그 규칙을 말하지 않습니다. Gemini는 스키마만 보고
 * 지켰고, 로컬 모델은 2026-08-25 실측에서 `qwen2.5:7b`와 `llama3.1:8b` 모두 이 규칙을 어겨
 * 같은 `schema_validation`으로 끝났습니다.
 */
const LOCAL_OUTPUT_CONTRACT_HINT_TEXT =
  "후보를 3개 미만으로 고르면 insufficientCandidatesReason에 부족한 이유를 반드시 채우세요. " +
  "후보가 정확히 3개면 insufficientCandidatesReason은 null이어야 합니다. " +
  "sha와 relatedShas는 입력 workUnits 안의 commits[].sha 값을 그대로 복사하세요. relatedShas에는 " +
  "대표 커밋과 같은 workUnits 항목에 있는 sha만 넣고, 넣을 것이 없으면 빈 배열로 두세요. " +
  "citedFilePaths는 그 후보에 속한 커밋의 files[].path 값을 그대로 복사하세요. 입력에 없는 경로를 " +
  "기억이나 추측으로 쓰지 마세요. ";

function localOutputContractHint(): string {
  // 모듈 최상단에서 한 번 계산하면 환경변수를 나중에 바꾼 실행과 테스트가 낡은 값을 봅니다.
  return isLocalLlm() ? LOCAL_OUTPUT_CONTRACT_HINT_TEXT : "";
}

/** 모델 ID를 주입할 수 있게 열어 둡니다. 이슈 #19의 측정 스크립트가 후보 모델을 비교할 때 씁니다. */
export function createStageBGenerate(model: string = STAGE_B_MODEL): GenerateStageB {
  return async (payload, abortSignal) => {
    const { object } = await generateObject({
      model: createStageBModel(model),
      schema: experienceCandidateOutputSchema,
      system:
        localOutputContractHint() +
        "실제 diff와 PR 소속만 근거로 최대 3개의 개발 경험 후보를 고르세요. " +
        "입력 commits는 Pull Request 단위 묶음(workUnits)으로 그룹돼 있습니다. 최종 후보 3개는 " +
        "서로 다른 workUnits 항목에서 하나씩만 고르세요. 같은 workUnits 항목에서 대표 커밋을 " +
        "둘 이상 최종 후보로 고르지 마세요. " +
        "관련 커밋은 대표 커밋과 같은 PR에 속한 입력 SHA만 사용하세요. " +
        "억지로 3개를 채우지 말고, evidence에는 대표 선정 이유와 관련 커밋이 근거가 되는 이유를 함께 쓰세요. " +
        "citedFilePaths는 제공된 diff 경로만 사용하세요. " +
        "절단 표시가 있으면 전체 diff를 본 것으로 단정하지 마세요. 한국어로 답하세요.",
      prompt: JSON.stringify(payload),
      abortSignal,
      maxRetries: LLM_MAX_RETRIES,
      ...judgmentSamplingOptions(),
    });
    return object;
  };
}

// 제공자 이름을 붙이지 않습니다. 로컬 전환에서는 OpenAI 호환 엔드포인트로 갑니다.
const defaultGenerate: GenerateStageB = createStageBGenerate();

/**
 * 같은 Pull Request(작업 묶음)에서 나온 최종 후보가 여럿이면 입력 순서상 첫 번째만 남기고
 * 나머지를 버립니다. 프롬프트로 규칙을 알려도 모델이 어길 수 있으니 그 경우의 마지막 방어선입니다.
 *
 * 502로 거부하지 않습니다(핸드오프 2-1). 같은 PR 중복은 조작이 아니라 실제 커밋·실제 diff 중
 * 고른 결과이고, 지금까지 프롬프트가 "다른 PR에서 골라라"를 명시한 적이 없었기 때문입니다.
 * 대신 조용히 정리하고 그만큼 `insufficientCandidatesReason`을 채워 화면에 알립니다.
 */
function dedupeCandidatesByWorkUnit(
  output: ExperienceCandidateOutput,
  commits: readonly CommitDetail[]
): ExperienceCandidateOutput {
  const commitsBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const seenWorkUnitKeys = new Set<string>();
  const deduped = output.candidates.filter((candidate) => {
    // assertCandidateEvidence가 입력 밖 SHA를 이미 거부했으므로 대표 커밋은 항상 존재합니다.
    const key = resolveWorkUnitKey(commitsBySha.get(candidate.sha)!);
    if (seenWorkUnitKeys.has(key)) return false;
    seenWorkUnitKeys.add(key);
    return true;
  });

  if (deduped.length === output.candidates.length) return output;

  // 묶음마다 첫 후보는 항상 남으므로 입력 후보가 있었다면 출력도 있어야 합니다. 여기 걸리면
  // 이 함수 자체의 버그입니다.
  if (deduped.length === 0) {
    throw new Error("Stage B 최종 후보 정리 후 후보가 모두 사라졌습니다.");
  }

  // 모델이 이미 부족 사유를 준 경우(원래 3개 미만)라도 정리 사유로 덮어씁니다. 정리가 최종
  // 개수를 바꾼 직접 원인이므로, 정리를 언급하지 않는 기존 사유를 남기면 화면 설명이 실제
  // 결과와 어긋납니다.
  return {
    candidates: deduped,
    insufficientCandidatesReason: `같은 Pull Request에서 나온 후보를 하나로 합쳐 ${deduped.length}개가 되었습니다.`,
  };
}

export async function selectStageBCandidates(
  commits: readonly CommitDetail[],
  candidates: readonly StageACandidate[],
  generate: GenerateStageB = defaultGenerate,
  // 로컬 제공자일 때만 `LLM_TIMEOUT_MS`가 이 기본값을 대신합니다.
  timeoutMs = resolveLlmTimeoutMs(STAGE_B_TOTAL_BUDGET_MS)
): Promise<ExperienceCandidateOutput> {
  const payload = buildStageBPayload(commits, candidates);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Stage B timeout", "TimeoutError")),
    timeoutMs
  );
  try {
    const output = validateExperienceCandidateOutput(await generate(payload, controller.signal));
    // ponytail: 인용은 입력 diff 경로로 제한합니다. 이슈 #32가 전체 트리 근거를 요구하면 fileTree를 입력에 추가합니다.
    assertCandidateEvidence(output, { commits, fileTree: [] });
    const deduped = dedupeCandidatesByWorkUnit(output, commits);
    const sources = new Map(candidates.map(({ sha, source }) => [sha, source]));
    return {
      ...deduped,
      candidates: deduped.candidates.map((candidate) => ({
        ...candidate,
        // assertCandidateEvidence가 입력 밖 SHA를 이미 거부했으므로 source는 항상 존재합니다.
        source: sources.get(candidate.sha)!,
      })),
    };
  } catch (error) {
    throw mapLlmError(error);
  } finally {
    clearTimeout(timeout);
  }
}
