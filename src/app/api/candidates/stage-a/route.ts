import type { NextRequest } from "next/server";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import type { StageAChunkOutput } from "@/features/experience-candidates/types";
import {
  STAGE_A_CHUNK_MAX_BYTES,
  STAGE_A_CHUNK_MAX_REQUEST_BYTES,
  STAGE_A_CHUNK_MAX_UNITS,
  buildStageAPayload,
  selectStageACandidates,
  type GenerateStageA,
  type StageAInput,
} from "@/features/experience-candidates/stage-a";

export const runtime = "nodejs";
export const maxDuration = 60;
export const MAX_STAGE_A_BODY_BYTES = 4.5 * 1024 * 1024;

function isStageAInput(value: unknown): value is StageAInput {
  const isCount = (item: unknown) => Number.isInteger(item) && (item as number) >= 0;
  const isStringArray = (item: unknown) =>
    Array.isArray(item) && item.every((entry) => typeof entry === "string");
  // Stage A는 patch를 받지 않습니다. 묶음 요약에는 patch가 들어갈 자리가 없지만, 클라이언트가
  // 임의 필드를 덧붙여 보내는 경로를 막기 위해 요약 필드 수를 고정합니다.
  const isSummary = (item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const summary = item as Record<string, unknown>;
    return (
      Object.keys(summary).length === 9 &&
      Number.isInteger(summary.pullRequestNumber) &&
      typeof summary.pullRequestTitle === "string" &&
      isCount(summary.commitCount) &&
      (summary.commitCount as number) >= 1 &&
      isCount(summary.spanDays) &&
      isCount(summary.additions) &&
      isCount(summary.deletions) &&
      isStringArray(summary.commitTitles) &&
      isCount(summary.changedFilePathCount) &&
      isStringArray(summary.topFilePaths)
    );
  };
  const isUnit = (item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    Number.isInteger((item as { pullRequestNumber?: unknown }).pullRequestNumber) &&
    typeof (item as { representativeSha?: unknown }).representativeSha === "string" &&
    /^[0-9a-f]{40}$/.test((item as { representativeSha: string }).representativeSha) &&
    isSummary((item as { summary?: unknown }).summary) &&
    (item as { summary: { pullRequestNumber: number } }).summary.pullRequestNumber ===
      (item as { pullRequestNumber: number }).pullRequestNumber;

  const input = value as StageAInput;
  if (typeof value !== "object" || value === null) return false;
  if (!Array.isArray(input.units) || !input.units.every(isUnit)) return false;
  if (input.units.length === 0 || input.units.length > STAGE_A_CHUNK_MAX_UNITS) return false;
  // 같은 묶음을 두 번 보내면 전수 응답 계약이 성립하지 않습니다.
  const numbers = input.units.map(({ pullRequestNumber }) => pullRequestNumber);
  if (new Set(numbers).size !== numbers.length) return false;
  if (!Array.isArray(input.contributionItems)) return false;
  if (!input.contributionItems.every((item) => typeof item === "string" && item.length > 0)) {
    return false;
  }
  return (
    Number.isInteger(input.candidateLimit) &&
    input.candidateLimit >= 1 &&
    input.candidateLimit <= input.units.length
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
        ? `${error.message} ${error.missingShas.length}개 작업 묶음을 3회 판단했지만 완료하지 못했습니다.`
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
      new TextEncoder().encode(text).byteLength > STAGE_A_CHUNK_MAX_REQUEST_BYTES
    ) {
      return Response.json({ error: { kind: "invalid_request", message: "Stage A 입력 형식이 올바르지 않습니다." } }, { status: 422 });
    }
    // 모델에 실제로 실리는 프롬프트를 서버에서 접어 보고 상한을 확인합니다. 요청 본문 크기만
    // 재면 클라이언트가 긴 커밋 제목을 담아 프롬프트만 키우는 경로가 열립니다.
    const promptBytes = new TextEncoder().encode(
      buildStageAPayload(body).units.map(({ summary }) => summary).join("\n")
    ).byteLength;
    if (promptBytes > STAGE_A_CHUNK_MAX_BYTES) {
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
              "단일 작업 묶음을 세 번 판단했지만 모델이 판단 결과를 반환하지 못했습니다. 같은 입력을 다시 보내도 해결된다고 보장할 수 없습니다.",
              { missingShas: error.missingShas, partialOutput: error.partialOutput, cause: error }
            );
          }
          throw error;
        }
        const missing = new Set(error.missingShas);
        const recovered = await selectWithRecovery({
          ...input,
          units: input.units.filter(({ representativeSha }) => missing.has(representativeSha)),
          candidateLimit: Math.max(
            1,
            input.candidateLimit - error.partialOutput.candidates.length
          ),
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
