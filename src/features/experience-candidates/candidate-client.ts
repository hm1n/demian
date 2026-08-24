import type {
  CandidateDiff,
  ExperienceCandidateSource,
  StageACandidate,
  StageACandidateOutput,
  StageBCandidateResult,
} from "./types";
import { validateExperienceCandidateOutput } from "./schema";
import type { ReadonlyCommitDetail, RepositoryRef } from "@/lib/github/types";

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
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CandidateRequestError";
  }
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
      ? (payload.error as { kind?: unknown; message?: unknown })
      : undefined;
  const kind =
    typeof error?.kind === "string" && (KNOWN_ERROR_KINDS as readonly string[]).includes(error.kind)
      ? (error.kind as CandidateRequestErrorKind)
      : "server_error";
  const message = typeof error?.message === "string" ? error.message : "후보 생성 요청에 실패했습니다.";
  throw new CandidateRequestError(stage, kind, message);
}

/** Stage A 계약이 허용하는 경량 필드만 남깁니다. patch는 입력 계약 위반(422)이라 전송하지 않습니다. */
export function toStageARequest(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[]
) {
  return {
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
  contributionItems: readonly string[]
): Promise<StageACandidateOutput> {
  const payload = await postCandidateApi(
    "stage_a",
    "/api/candidates/stage-a",
    toStageARequest(commits, contributionItems)
  );
  const output = payload as Partial<StageACandidateOutput>;
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray(output.candidates) || !output.candidates.every(isStageACandidate) ||
    !Array.isArray(output.unclassifiedShas) ||
    !output.unclassifiedShas.every((sha) => typeof sha === "string")
  ) {
    throw new CandidateRequestError("stage_a", "invalid_response", "Stage A 응답 형식이 올바르지 않습니다.");
  }
  return { candidates: output.candidates, unclassifiedShas: output.unclassifiedShas };
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
