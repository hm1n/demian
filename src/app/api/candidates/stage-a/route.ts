import type { NextRequest } from "next/server";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import {
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

  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as StageAInput).commits) &&
    (value as StageAInput).commits.every(isCommit) &&
    Array.isArray((value as StageAInput).contributionItems) &&
    (value as StageAInput).contributionItems.every(
      (item) => typeof item === "string" && item.length > 0
    )
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
    return Response.json({ error: { kind: error.kind, message: error.message } }, { status });
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
    if (!isStageAInput(body)) {
      return Response.json({ error: { kind: "invalid_request", message: "Stage A 입력 형식이 올바르지 않습니다." } }, { status: 422 });
    }
    return Response.json(await selectStageACandidates(body, generate, timeoutMs));
  } catch (error) {
    return errorResponse(error);
  }
}

export function POST(request: NextRequest): Promise<Response> {
  return handleStageA(request);
}
