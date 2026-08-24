import { createGoogle } from "@ai-sdk/google";
import { APICallError, generateObject, LoadAPIKeyError, NoObjectGeneratedError } from "ai";
import { ExperienceCandidateOutputError } from "./errors";
import { assertCandidateEvidence, experienceCandidateOutputSchema, validateExperienceCandidateOutput } from "./schema";
import type { ExperienceCandidateOutput, StageACandidate } from "./types";
import type { CommitDetail } from "@/lib/github/types";

export const STAGE_B_MODEL = "gemini-3.7-flash";
// 확인 필요: 이슈 #19에서 실제 실행 시간과 토큰 사용량을 측정한 뒤 확정합니다.
// Stage A 후보 전체가 입력되므로 INITIAL_STAGE_A_CANDIDATE_LIMIT과 같아야 정상 흐름이 422로 막히지 않습니다.
export const STAGE_B_MAX_CANDIDATES = 20;
export const STAGE_B_MAX_PATCH_CHARS = 4_000;
export const STAGE_B_MAX_TOTAL_PATCH_CHARS = 60_000;
export const STAGE_B_TOTAL_BUDGET_MS = 55_000;
// 확인 필요: 이슈 #19에서 실제 LLM 완주 시간을 측정한 뒤 확정합니다.
export const STAGE_B_MIN_LLM_BUDGET_MS = 10_000;

export type GenerateStageB = (payload: unknown, abortSignal: AbortSignal) => Promise<unknown>;

export function buildStageBPayload(commits: readonly CommitDetail[], candidates: readonly StageACandidate[]) {
  let used = 0;
  const candidateBySha = new Map(candidates.map((candidate) => [candidate.sha, candidate]));
  return {
    commits: commits.map((commit) => ({
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
      files: commit.files.map((file) => {
        const available = Math.max(0, STAGE_B_MAX_TOTAL_PATCH_CHARS - used);
        const patch = file.patch?.slice(0, Math.min(STAGE_B_MAX_PATCH_CHARS, available));
        used += patch?.length ?? 0;
        return {
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          ...(patch ? { patch } : {}),
          ...(file.patch !== undefined && patch?.length !== file.patch.length ? { patchTruncated: true } : {}),
        };
      }),
    })),
  };
}

function mapLlmError(error: unknown) {
  if (error instanceof ExperienceCandidateOutputError) return error;
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
    if (error.statusCode === 429) {
      return new ExperienceCandidateOutputError(
        "llm_rate_limit",
        "LLM 호출 한도에 도달했습니다.",
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
