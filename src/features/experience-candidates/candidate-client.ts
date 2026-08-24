import type {
  CandidateDiff,
  ExperienceCandidateSource,
  StageACandidate,
  StageACheckpoint,
  StageAChunkOutput,
  StageACandidateOutput,
  StageAProgress,
  StageBCandidateResult,
} from "./types";
import { validateExperienceCandidateOutput } from "./schema";
import type { ReadonlyCommitDetail, RepositoryRef } from "@/lib/github/types";
import {
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  STAGE_A_CHUNK_MAX_BYTES,
  STAGE_A_CHUNK_MAX_FILES,
  STAGE_A_CHUNK_SIZE,
  STAGE_A_RESET_SAFETY_MS,
  STAGE_A_TOKEN_RESERVE,
} from "./stage-a";

export type CandidateStage = "stage_a" | "stage_b";

/**
 * 후보 생성 라우트가 반환하는 오류 kind에 클라이언트 전용 kind 2개를 더한 집합입니다.
 * `fetch_network`는 서버 응답을 받기 전의 전송 실패, `invalid_response`는 성공 응답의 형식 위반입니다.
 */
export type CandidateRequestErrorKind =
  | "unauthorized"
  | "invalid_json"
  | "invalid_request"
  | "body_too_large"
  | "json_parse"
  | "schema_validation"
  | "unknown_sha"
  | "unrelated_sha"
  | "unknown_file_path"
  | "llm_network"
  | "llm_auth"
  | "llm_rate_limit"
  | "llm_timeout"
  | "llm_configuration"
  | "llm_request"
  | "llm_failure"
  | "auth_revoked"
  | "repo_not_found"
  | "rate_limit"
  | "network"
  | "server_error"
  | "partial_failure"
  | "fetch_network"
  | "invalid_response";

const KNOWN_ERROR_KINDS: readonly CandidateRequestErrorKind[] = [
  "unauthorized", "invalid_json", "invalid_request", "body_too_large",
  "json_parse", "schema_validation", "unknown_sha", "unrelated_sha", "unknown_file_path",
  "llm_network", "llm_auth", "llm_rate_limit", "llm_timeout", "llm_configuration", "llm_request", "llm_failure",
  "auth_revoked", "repo_not_found", "rate_limit", "network", "server_error", "partial_failure",
];

export class CandidateRequestError extends Error {
  constructor(
    readonly stage: CandidateStage,
    readonly kind: CandidateRequestErrorKind,
    message: string,
    options?: ErrorOptions & { checkpoint?: StageACheckpoint; retryable?: boolean }
  ) {
    super(message, options);
    this.name = "CandidateRequestError";
    this.checkpoint = options?.checkpoint;
    this.retryable = options?.retryable ?? true;
  }
  readonly checkpoint?: StageACheckpoint;
  readonly retryable: boolean;
}

async function postCandidateApi(stage: CandidateStage, url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new CandidateRequestError(stage, "fetch_network", "후보 생성 서버에 연결하지 못했습니다.", { cause });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new CandidateRequestError(stage, "invalid_response", "후보 생성 응답을 해석하지 못했습니다.", { cause });
  }
  if (response.ok) return payload;
  const error =
    typeof payload === "object" && payload !== null && "error" in payload &&
    typeof payload.error === "object" && payload.error !== null
      ? (payload.error as { kind?: unknown; message?: unknown; retryable?: unknown })
      : undefined;
  const kind =
    typeof error?.kind === "string" && (KNOWN_ERROR_KINDS as readonly string[]).includes(error.kind)
      ? (error.kind as CandidateRequestErrorKind)
      : "server_error";
  const message = typeof error?.message === "string" ? error.message : "후보 생성 요청에 실패했습니다.";
  throw new CandidateRequestError(stage, kind, message, { retryable: error?.retryable !== false });
}

/** Stage A 계약이 허용하는 경량 필드만 남깁니다. patch는 입력 계약 위반(422)이라 전송하지 않습니다. */
export function toStageARequest(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[],
  mode: "initial" | "reduce" = "initial",
  candidateLimit?: number
) {
  return {
    mode,
    commits: commits.map(({ sha, message, additions, deletions, changedFiles, files }) => ({
      sha,
      message,
      additions,
      deletions,
      changedFiles,
      files: files.map(({ path, status, additions: added, deletions: deleted, changes }) => ({
        path,
        status,
        additions: added,
        deletions: deleted,
        changes,
      })),
    })),
    contributionItems: [...contributionItems],
    ...(candidateLimit === undefined ? {} : { candidateLimit }),
  };
}

const SOURCES: readonly ExperienceCandidateSource[] = ["contribution_match", "automatic_recommendation"];

function isStageACandidate(value: unknown): value is StageACandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StageACandidate>;
  return (
    typeof candidate.sha === "string" &&
    SOURCES.includes(candidate.source as ExperienceCandidateSource) &&
    (candidate.contributionItem === null || typeof candidate.contributionItem === "string")
  );
}

export async function fetchStageACandidatesFromApi(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[],
  onProgress: (progress: StageAProgress) => void = () => undefined,
  checkpoint?: StageACheckpoint,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<StageACandidateOutput> {
  const processed = new Set(checkpoint?.processedShas ?? []);
  let candidates = [...(checkpoint?.candidates ?? [])];
  const unclassifiedShas = [...(checkpoint?.unclassifiedShas ?? [])];
  const pending = commits.filter(({ sha }) => !processed.has(sha));
  const splitCommits = (items: readonly ReadonlyCommitDetail[]) => {
    const result: ReadonlyCommitDetail[][] = [];
    for (const commit of items) {
      const current = result.at(-1) ?? [];
      const proposed = [...current, commit];
      const bytes = new TextEncoder().encode(JSON.stringify(toStageARequest(proposed, contributionItems))).length;
      const files = proposed.reduce((sum, item) => sum + item.files.length, 0);
      if (
        current.length > 0 &&
        (proposed.length > STAGE_A_CHUNK_SIZE || bytes > STAGE_A_CHUNK_MAX_BYTES || files > STAGE_A_CHUNK_MAX_FILES)
      ) {
        result.push([commit]);
      } else if (result.length === 0 || current.length === 0) {
        result.push(proposed);
      } else {
        result[result.length - 1] = proposed;
      }
    }
    return result;
  };
  const chunks = splitCommits(pending);

  const requestChunk = async (
    chunk: readonly ReadonlyCommitDetail[],
    mode: "initial" | "reduce",
    limit?: number
  ) => {
    const payload = await postCandidateApi(
      "stage_a", "/api/candidates/stage-a", toStageARequest(chunk, contributionItems, mode, limit)
    );
    const output = payload as Partial<StageAChunkOutput>;
    if (!isStageAChunkOutput(payload)) {
      throw new CandidateRequestError("stage_a", "invalid_response", "Stage A 응답 형식이 올바르지 않습니다.");
    }
    return output as StageAChunkOutput;
  };

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const output = await requestChunk(chunk, "initial");
      candidates.push(...output.candidates);
      unclassifiedShas.push(...output.unclassifiedShas);
      chunk.forEach(({ sha }) => processed.add(sha));
      onProgress({ completed: processed.size, total: commits.length, waitingForRateLimit: false });
      const moreRequests = index + 1 < chunks.length || candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT;
      if (moreRequests && !output.rateLimit) {
        throw new CandidateRequestError("stage_a", "invalid_response", "LLM 토큰 한도 메타데이터가 없습니다.");
      }
      if (moreRequests && output.rateLimit && output.rateLimit.remainingTokens < STAGE_A_TOKEN_RESERVE) {
        onProgress({ completed: processed.size, total: commits.length, waitingForRateLimit: true });
        await wait(output.rateLimit.resetAfterMs + STAGE_A_RESET_SAFETY_MS);
      }
    }

    for (let round = 0; candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT && round < 6; round += 1) {
      const next: StageACandidate[] = [];
      let lastRateLimit: StageAChunkOutput["rateLimit"] = null;
      const candidateBySha = new Map(candidates.map((candidate) => [candidate.sha, candidate]));
      const reductionChunks = splitCommits(
        commits.filter(({ sha }) => candidateBySha.has(sha))
      );
      for (let index = 0; index < reductionChunks.length; index += 1) {
        const chunk = reductionChunks[index];
        const group = chunk.map(({ sha }) => candidateBySha.get(sha)!);
        if (group.length === 1) {
          next.push(group[0]);
          continue;
        }
        const output = await requestChunk(chunk, "reduce", Math.max(1, Math.floor(group.length / 2)));
        next.push(...output.candidates);
        unclassifiedShas.push(...output.unclassifiedShas);
        lastRateLimit = output.rateLimit;
        if (index + 1 < reductionChunks.length && !output.rateLimit) {
          throw new CandidateRequestError("stage_a", "invalid_response", "LLM 토큰 한도 메타데이터가 없습니다.");
        }
        if (
          index + 1 < reductionChunks.length &&
          output.rateLimit &&
          output.rateLimit.remainingTokens < STAGE_A_TOKEN_RESERVE
        ) {
          onProgress({ completed: commits.length, total: commits.length, waitingForRateLimit: true });
          await wait(output.rateLimit.resetAfterMs + STAGE_A_RESET_SAFETY_MS);
        }
      }
      candidates = next;
      if (candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT) {
        if (!lastRateLimit) {
          throw new CandidateRequestError("stage_a", "invalid_response", "LLM 토큰 한도 메타데이터가 없습니다.");
        }
        if (lastRateLimit.remainingTokens < STAGE_A_TOKEN_RESERVE) {
          onProgress({ completed: commits.length, total: commits.length, waitingForRateLimit: true });
          await wait(lastRateLimit.resetAfterMs + STAGE_A_RESET_SAFETY_MS);
        }
      }
    }
  } catch (cause) {
    if (cause instanceof CandidateRequestError) {
      throw new CandidateRequestError(cause.stage, cause.kind, cause.message, {
        cause,
        retryable: cause.retryable,
        checkpoint: { candidates, unclassifiedShas, processedShas: [...processed] },
      });
    }
    throw cause;
  }

  if (candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT) {
    throw new CandidateRequestError(
      "stage_a", "schema_validation",
      `재판단 6회 뒤에도 후보 ${candidates.length}개가 남아 상한 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개로 줄지 않았습니다.`,
      { checkpoint: { candidates, unclassifiedShas, processedShas: [...processed] } }
    );
  }
  return { candidates, unclassifiedShas };
}

function isStageAChunkOutput(payload: unknown): payload is StageAChunkOutput {
  const output = payload as Partial<StageAChunkOutput>;
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray(output.candidates) || !output.candidates.every(isStageACandidate) ||
    !Array.isArray(output.unclassifiedShas) ||
    !output.unclassifiedShas.every((sha) => typeof sha === "string") ||
    !(output.rateLimit === null || (
      typeof output.rateLimit === "object" && output.rateLimit !== null &&
      typeof output.rateLimit.remainingTokens === "number" &&
      typeof output.rateLimit.resetAfterMs === "number" &&
      typeof output.rateLimit.usedTokens === "number"
    ))
  ) {
    return false;
  }
  return true;
}

function isCandidateDiff(value: unknown): value is CandidateDiff {
  if (typeof value !== "object" || value === null) return false;
  const diff = value as Partial<CandidateDiff>;
  return (
    typeof diff.sha === "string" &&
    Array.isArray(diff.files) &&
    diff.files.every(
      (file) => typeof file === "object" && file !== null && typeof (file as { path?: unknown }).path === "string"
    )
  );
}

export async function fetchStageBCandidatesFromApi(
  repository: RepositoryRef,
  candidates: readonly StageACandidate[]
): Promise<StageBCandidateResult> {
  const payload = await postCandidateApi("stage_b", "/api/candidates/stage-b", {
    owner: repository.owner,
    repo: repository.repo,
    candidates,
  });
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray((payload as { diffs?: unknown }).diffs) ||
    !(payload as { diffs: unknown[] }).diffs.every(isCandidateDiff)
  ) {
    throw new CandidateRequestError("stage_b", "invalid_response", "Stage B 응답 형식이 올바르지 않습니다.");
  }
  const { diffs, ...output } = payload as { diffs: CandidateDiff[] } & Record<string, unknown>;
  try {
    return { ...validateExperienceCandidateOutput(output), diffs };
  } catch (cause) {
    // 서버가 이미 검증한 응답이므로 형식 위반은 LLM 스키마 위반이 아니라 전송 계층 문제로 다룹니다.
    throw new CandidateRequestError("stage_b", "invalid_response", "Stage B 응답 형식이 올바르지 않습니다.", { cause });
  }
}
