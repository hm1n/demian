import type { NextRequest } from "next/server";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import type { StageAChunkOutput } from "@/features/experience-candidates/types";
import {
  STAGE_A_CHUNK_SIZE,
  STAGE_A_CHUNK_MAX_BYTES,
  STAGE_A_CHUNK_MAX_FILES,
  selectStageACandidates,
  type GenerateStageA,
  type StageAInput,
} from "@/features/experience-candidates/stage-a";

export const runtime = "nodejs";
export const maxDuration = 60;
export const MAX_STAGE_A_BODY_BYTES = 4.5 * 1024 * 1024;

function isStageAInput(value: unknown): value is StageAInput {
  const isNumber = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  const isFile = (item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    !("patch" in item) &&
    typeof (item as { path?: unknown }).path === "string" &&
    typeof (item as { status?: unknown }).status === "string" &&
    isNumber((item as { additions?: unknown }).additions) &&
    isNumber((item as { deletions?: unknown }).deletions) &&
    isNumber((item as { changes?: unknown }).changes);
  const isCommit = (item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    typeof (item as { sha?: unknown }).sha === "string" &&
    typeof (item as { message?: unknown }).message === "string" &&
    isNumber((item as { additions?: unknown }).additions) &&
    isNumber((item as { deletions?: unknown }).deletions) &&
    isNumber((item as { changedFiles?: unknown }).changedFiles) &&
    Array.isArray((item as { files?: unknown }).files) &&
    (item as { files: unknown[] }).files.every(isFile);

  const input = value as StageAInput;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as StageAInput).commits) &&
    input.commits.every(isCommit) &&
    input.commits.length <= STAGE_A_CHUNK_SIZE &&
    Array.isArray((value as StageAInput).contributionItems) &&
    input.contributionItems.every(
      (item) => typeof item === "string" && item.length > 0
    ) &&
    (input.mode === "initial" || input.mode === "reduce") &&
    (input.mode !== "reduce" ||
      (Number.isInteger(input.candidateLimit) && input.candidateLimit! >= 1 &&
        input.candidateLimit! < input.commits.length))
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof GitHubFetchError && error.kind === "auth_revoked") {
    return Response.json({ error: { kind: "unauthorized", message: "GitHub 인증 세션이 필요합니다." } }, { status: 401 });
  }
  if (error instanceof ExperienceCandidateOutputError) {
    const status = {
      schema_validation: 502,
      unknown_sha: 502,
      json_parse: 502,
      unrelated_sha: 502,
      unknown_file_path: 502,
      llm_network: 502,
      llm_auth: 502,
      llm_rate_limit: 503,
      llm_timeout: 504,
      llm_configuration: 500,
      llm_request: 502,
      llm_failure: 502,
    }[error.kind];
    return Response.json({ error: {
      kind: error.kind,
      message: error.missingShas
        ? `${error.message} ${error.missingShas.length}개 커밋을 3회 판단했지만 완료하지 못했습니다.`
        : error.message,
      ...(error.missingShas ? { failedCount: error.missingShas.length } : {}),
      ...(error.missingShas?.length === 1 ? { retryable: false } : {}),
    } }, { status });
  }
  return Response.json({ error: { kind: "server_error", message: "Stage A 분석에 실패했습니다." } }, { status: 500 });
}

export async function handleStageA(
  request: NextRequest,
  generate?: GenerateStageA,
  timeoutMs?: number
): Promise<Response> {
  try {
    getGitHubTokenFromRequest(request);
    const declaredLength = Number(request.headers.get("content-length"));
    if (declaredLength > MAX_STAGE_A_BODY_BYTES) {
      return Response.json({ error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } }, { status: 413 });
    }

    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_STAGE_A_BODY_BYTES) {
      return Response.json({ error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: { kind: "invalid_json", message: "요청 본문은 JSON이어야 합니다." } }, { status: 400 });
    }
    if (
      !isStageAInput(body) ||
      new TextEncoder().encode(text).byteLength > STAGE_A_CHUNK_MAX_BYTES ||
      body.commits.reduce((sum, commit) => sum + commit.files.length, 0) > STAGE_A_CHUNK_MAX_FILES
    ) {
      return Response.json({ error: { kind: "invalid_request", message: "Stage A 입력 형식이 올바르지 않습니다." } }, { status: 422 });
    }
    const selectWithRecovery = async (
      input: StageAInput,
      attemptsLeft = 2
    ): Promise<StageAChunkOutput> => {
      try {
        return await selectStageACandidates(input, generate, timeoutMs);
      } catch (error) {
        if (
          !(error instanceof ExperienceCandidateOutputError) ||
          !error.missingShas?.length || !error.partialOutput || attemptsLeft === 0
        ) {
          if (error instanceof ExperienceCandidateOutputError && error.missingShas?.length === 1) {
            throw new ExperienceCandidateOutputError(
              error.kind,
              "단일 커밋을 세 번 판단했지만 모델이 판단 결과를 반환하지 못했습니다. 같은 입력을 다시 보내도 해결된다고 보장할 수 없습니다.",
              { missingShas: error.missingShas, partialOutput: error.partialOutput, cause: error }
            );
          }
          throw error;
        }
        const missing = new Set(error.missingShas);
        const recovered = await selectWithRecovery({
          ...input,
          commits: input.commits.filter(({ sha }) => missing.has(sha)),
          ...(input.candidateLimit === undefined
            ? {}
            : { candidateLimit: Math.max(1, input.candidateLimit - error.partialOutput.candidates.length) }),
        }, attemptsLeft - 1);
        return {
          candidates: [...error.partialOutput.candidates, ...recovered.candidates],
          unclassifiedShas: [...error.partialOutput.unclassifiedShas, ...recovered.unclassifiedShas],
          rateLimit: recovered.rateLimit,
        };
      }
    };
    return Response.json(await selectWithRecovery(body));
  } catch (error) {
    return errorResponse(error);
  }
}

export function POST(request: NextRequest): Promise<Response> {
  return handleStageA(request);
}
