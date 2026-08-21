import type { NextRequest } from "next/server";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import {
  buildStageBPayload,
  selectStageBCandidates,
  STAGE_B_MAX_CANDIDATES,
  STAGE_B_MIN_LLM_BUDGET_MS,
  STAGE_B_TOTAL_BUDGET_MS,
  type GenerateStageB,
} from "@/features/experience-candidates/stage-b";
import type { StageACandidate } from "@/features/experience-candidates/types";
import { errorResponse as githubErrorResponse, GitHubRouteRequestError } from "@/lib/github/api-contract";
import { getGitHubTokenFromRequest } from "@/lib/github/auth-session";
import { fetchCommitDetailBySha } from "@/lib/github/contributions";
import { GitHubFetchError } from "@/lib/github/errors";
import { readGitHubRouteRequest } from "@/lib/github/route-request";
import type { CommitDetail, GitHubAuth } from "@/lib/github/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const MAX_STAGE_B_BODY_BYTES = 4.5 * 1024 * 1024;

type FetchDetail = (auth: GitHubAuth, sha: string) => Promise<CommitDetail>;

// Stage A가 내는 후보 SHA는 GitHub commits API의 40자 소문자 hex다. 브랜치명·태그 같은 이동 가능한 ref를
// 받으면 페이지네이션 중 파일 목록이 중복·누락되고 응답의 SHA 자리에 ref가 새어 나가므로 형식을 고정한다.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function isCandidate(value: unknown): value is StageACandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StageACandidate>;
  return typeof candidate.sha === "string" && COMMIT_SHA_PATTERN.test(candidate.sha) &&
    ["contribution_match", "automatic_recommendation"].includes(candidate.source ?? "") &&
    (candidate.contributionItem === null || typeof candidate.contributionItem === "string");
}

function llmErrorResponse(error: ExperienceCandidateOutputError) {
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

export async function handleStageB(
  request: NextRequest,
  generate?: GenerateStageB,
  timeoutMs?: number,
  fetchDetail: FetchDetail = fetchCommitDetailBySha
): Promise<Response> {
  const startedAt = Date.now();
  const totalBudgetMs = timeoutMs ?? STAGE_B_TOTAL_BUDGET_MS;
  try {
    getGitHubTokenFromRequest(request);
    const declaredLength = Number(request.headers.get("content-length"));
    if (declaredLength > MAX_STAGE_B_BODY_BYTES) {
      return Response.json(
        { error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } },
        { status: 413 }
      );
    }
    const actualLength = new TextEncoder().encode(await request.clone().text()).byteLength;
    if (actualLength > MAX_STAGE_B_BODY_BYTES) {
      return Response.json(
        { error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } },
        { status: 413 }
      );
    }
    const { body, auth } = await readGitHubRouteRequest(request);
    const candidates = body.candidates;
    if (
      !Array.isArray(candidates) ||
      !candidates.every(isCandidate) ||
      candidates.length > STAGE_B_MAX_CANDIDATES ||
      new Set(candidates.map(({ sha }) => sha)).size !== candidates.length
    ) {
      return Response.json(
        { error: { kind: "invalid_request", message: "Stage B 입력 형식이 올바르지 않습니다." } },
        { status: 422 }
      );
    }
    if (candidates.length === 0) {
      return Response.json({
        candidates: [],
        insufficientCandidatesReason: "Stage A에서 선별된 후보가 없습니다.",
        diffs: [],
      });
    }
    const remaining = () => totalBudgetMs - (Date.now() - startedAt);
    const assertBudget = () => {
      if (remaining() < STAGE_B_MIN_LLM_BUDGET_MS) {
        throw new ExperienceCandidateOutputError(
          "llm_timeout",
          "Stage B 실행 시간 예산이 초과되었습니다."
        );
      }
    };
    const commits: CommitDetail[] = [];
    // ponytail: 요청 하나는 끝날 때까지 예산을 넘길 수 있습니다. 필요해지면 조회 계층에 AbortSignal을 배선합니다.
    for (const candidate of candidates) {
      assertBudget();
      commits.push(await fetchDetail(auth, candidate.sha));
    }
    assertBudget();
    const output = await selectStageBCandidates(commits, candidates, generate, remaining());
    const selected = new Set(
      output.candidates.flatMap(({ sha, relatedShas }) => [sha, ...relatedShas])
    );
    // ponytail: payload 조립은 결정론적이라 재사용합니다. 비용이 커지면 한 번 만든 payload를 판단과 응답에 전달합니다.
    const bounded = buildStageBPayload(commits, candidates).commits;
    return Response.json({
      ...output,
      diffs: bounded
        .filter(({ sha }) => selected.has(sha))
        .map(({ sha, files }) => ({
          sha,
          files: files.map(
            ({ path, status, additions, deletions, changes, patch, patchTruncated }) => ({
              path,
              status,
              additions,
              deletions,
              changes,
              ...(patch === undefined ? {} : { patch }),
              ...(patchTruncated === undefined ? {} : { patchTruncated }),
            })
          ),
        })),
    });
  } catch (error) {
    if (error instanceof ExperienceCandidateOutputError) return llmErrorResponse(error);
    if (error instanceof GitHubRouteRequestError || error instanceof GitHubFetchError) {
      return githubErrorResponse(error);
    }
    return Response.json(
      { error: { kind: "server_error", message: "Stage B 분석에 실패했습니다." } },
      { status: 500 }
    );
  }
}

export function POST(request: NextRequest): Promise<Response> {
  return handleStageB(request);
}
