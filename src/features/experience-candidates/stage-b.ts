import { createGoogle } from "@ai-sdk/google";
import { APICallError, generateObject, LoadAPIKeyError, NoObjectGeneratedError, RetryError } from "ai";
import {
  ExperienceCandidateOutputError,
  isModelOutputFailureResponseBody,
  isRateLimitResponseBody,
} from "./errors";
import { assertCandidateEvidence, experienceCandidateOutputSchema, validateExperienceCandidateOutput } from "./schema";
import type { ExperienceCandidateOutput, StageACandidate } from "./types";
import type { CommitDetail } from "@/lib/github/types";

// 이슈 #19 실측(2026-08-24)으로 유효성 확인: Google 모델 목록에 존재하며 정상 응답합니다.
// 무료 등급 일일 한도가 하루 20요청(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`)이고
// 모델별로 따로 걸립니다. 측정에서 관측된 낮은 성공률은 모델의 일시적 과부하가 아니라 이 일일
// 쿼터 소진이 주 원인이었습니다. 근거는 위키 측정 문서에 있습니다.
export const STAGE_B_MODEL = "gemini-3.7-flash";
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
export function buildStageBPayload(commits: readonly CommitDetail[], candidates: readonly StageACandidate[]) {
  const share =
    commits.length === 0 ? 0 : Math.floor(STAGE_B_MAX_TOTAL_PATCH_CHARS / commits.length);
  let carried = 0;
  const candidateBySha = new Map(candidates.map((candidate) => [candidate.sha, candidate]));
  return {
    commits: commits.map((commit) => {
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
        pullRequests: commit.pullRequests.map(
          ({ number, title, state, baseBranch, headBranch }) => ({
            number,
            title,
            state,
            baseBranch,
            headBranch,
          })
        ),
        files,
      };
    }),
  };
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
    if (error.statusCode === 401 || error.statusCode === 403) {
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

/** 모델 ID를 주입할 수 있게 열어 둡니다. 이슈 #19의 측정 스크립트가 후보 모델을 비교할 때 씁니다. */
export function createStageBGenerate(model: string = STAGE_B_MODEL): GenerateStageB {
  return async (payload, abortSignal) => {
    const { object } = await generateObject({
      model: createGoogle()(model),
      schema: experienceCandidateOutputSchema,
      system:
        "실제 diff와 PR 소속만 근거로 최대 3개의 개발 경험 후보를 고르세요. " +
        "관련 커밋은 대표 커밋과 같은 PR에 속한 입력 SHA만 사용하세요. " +
        "억지로 3개를 채우지 말고, evidence에는 대표 선정 이유와 관련 커밋이 근거가 되는 이유를 함께 쓰세요. " +
        "citedFilePaths는 제공된 diff 경로만 사용하세요. " +
        "절단 표시가 있으면 전체 diff를 본 것으로 단정하지 마세요. 한국어로 답하세요.",
      prompt: JSON.stringify(payload),
      abortSignal,
    });
    return object;
  };
}

const generateWithGemini: GenerateStageB = createStageBGenerate();

export async function selectStageBCandidates(
  commits: readonly CommitDetail[],
  candidates: readonly StageACandidate[],
  generate: GenerateStageB = generateWithGemini,
  timeoutMs = STAGE_B_TOTAL_BUDGET_MS
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
    const sources = new Map(candidates.map(({ sha, source }) => [sha, source]));
    return {
      ...output,
      candidates: output.candidates.map((candidate) => ({
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
