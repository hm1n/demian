import type { NextRequest } from "next/server";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { GitHubFetchError } from "@/lib/github/errors";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import type {
  StageACandidate,
  StageACandidateOutput,
  StageAChunkOutput,
} from "@/features/experience-candidates/types";
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
    /**
     * 병합 결과를 요청 상한까지 자릅니다.
     *
     * 호출 하나하나는 `selectStageACandidates`가 상한을 강제하지만 부분 응답과 복구 응답을
     * 합치는 지점은 아무도 세지 않았습니다. 복구에 넘기는 상한에 `Math.max(1, ...)` 바닥이
     * 있어 부분 응답이 이미 상한을 채웠어도 복구가 최소 하나를 더 얹습니다. 실측에서 상한 5에
     * 후보 6개, 상한 2에 후보 3개가 나왔습니다.
     *
     * 바닥을 0으로 내리는 대신 병합 지점에서 자릅니다. 복구에 "최대 0개"를 요구하면 모델이 하나만
     * 줘도 청크 전체가 복구 불가능한 422로 죽습니다. 요구는 그대로 두고 결과만 정리합니다.
     *
     * 기여 항목에 맞은 후보를 먼저 남깁니다. 명시적으로 맞은 것이 모델 재량 추천보다 근거가
     * 강합니다. 같으면 입력 순서로 끊어 같은 입력이 같은 결과를 내게 합니다.
     *
     * 잘린 후보는 버리지 않고 미분류로 내립니다. 개수가 맞지 않으면 뒤에서 추적이 안 됩니다.
     */
    const trimToLimit = (
      candidates: readonly StageACandidate[],
      limit: number
    ): { kept: StageACandidate[]; demoted: string[] } => {
      if (candidates.length <= limit) return { kept: [...candidates], demoted: [] };
      const ranked = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => {
          const priority = (item: { candidate: StageACandidate }) =>
            item.candidate.source === "contribution_match" ? 0 : 1;
          return priority(left) - priority(right) || left.index - right.index;
        });
      return {
        kept: ranked.slice(0, limit).sort((l, r) => l.index - r.index).map(({ candidate }) => candidate),
        demoted: ranked.slice(limit).map(({ candidate }) => candidate.sha),
      };
    };

    /**
     * 끝내 판단을 받지 못한 묶음을 `unjudgedShas`로 내리고 나머지를 살립니다.
     *
     * 이전에는 여기서 예외를 던졌습니다. `andbread` 실측에서 청크 하나가 복구를 소진하자 이미
     * 끝난 다섯 청크의 결과까지 버려지고 Stage A 전체가 실패했습니다. 묶음 63개가 정상이었는데
     * 3개 때문에 전부 사라졌습니다.
     */
    const degrade = (
      partial: StageACandidateOutput,
      unjudgedShas: readonly string[]
    ): StageAChunkOutput => ({
      candidates: partial.candidates,
      unclassifiedShas: partial.unclassifiedShas,
      unjudgedShas: [...unjudgedShas],
      rateLimit: null,
    });

    const selectWithRecovery = async (
      input: StageAInput,
      attemptsLeft = 2
    ): Promise<StageAChunkOutput> => {
      try {
        return await selectStageACandidates(input, generate, timeoutMs);
      } catch (error) {
        // 모델이 형식에 맞는 응답 자체를 만들지 못한 경우입니다. 살릴 부분 응답이 없으므로 같은
        // 입력을 그대로 다시 보냅니다. 실측에서 같은 입력이 시도마다 다른 출력을 냈습니다.
        if (
          error instanceof ExperienceCandidateOutputError &&
          error.kind === "schema_validation" &&
          !error.partialOutput &&
          attemptsLeft > 0
        ) {
          return await selectWithRecovery(input, attemptsLeft - 1);
        }
        if (
          !(error instanceof ExperienceCandidateOutputError) ||
          !error.missingShas?.length || !error.partialOutput
        ) {
          throw error;
        }
        const partial = error.partialOutput;
        const missingShas = error.missingShas;
        if (attemptsLeft === 0) return degrade(partial, missingShas);

        const missing = new Set(missingShas);
        let recovered: StageAChunkOutput;
        try {
          recovered = await selectWithRecovery({
            ...input,
            units: input.units.filter(({ representativeSha }) => missing.has(representativeSha)),
            candidateLimit: Math.max(1, input.candidateLimit - partial.candidates.length),
          }, attemptsLeft - 1);
        } catch {
          // 복구 호출이 어떤 이유로 실패하든 이미 받은 부분 응답은 살립니다. 실측에서 모델이
          // 스키마를 못 맞춰 제공자가 400을 돌려주는 경우가 간헐적으로 있었고, 그때마다 정상
          // 판단된 묶음까지 함께 버려졌습니다.
          return degrade(partial, missingShas);
        }
        const { kept, demoted } = trimToLimit(
          [...partial.candidates, ...recovered.candidates],
          input.candidateLimit
        );
        return {
          candidates: kept,
          unclassifiedShas: [...partial.unclassifiedShas, ...recovered.unclassifiedShas, ...demoted],
          unjudgedShas: recovered.unjudgedShas,
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
