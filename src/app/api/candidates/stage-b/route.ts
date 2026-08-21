import type { NextRequest } from "next/server";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import { buildStageBPayload, selectStageBCandidates, STAGE_B_MAX_CANDIDATES, type GenerateStageB } from "@/features/experience-candidates/stage-b";
import type { StageACandidate } from "@/features/experience-candidates/types";
import { errorResponse as githubErrorResponse, GitHubRouteRequestError } from "@/lib/github/api-contract";
import { fetchCommitDetailBySha } from "@/lib/github/contributions";
import { GitHubFetchError } from "@/lib/github/errors";
import { readGitHubRouteRequest } from "@/lib/github/route-request";
import type { CommitDetail, GitHubAuth } from "@/lib/github/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const MAX_STAGE_B_BODY_BYTES = 4.5 * 1024 * 1024;

type FetchDetail = (auth: GitHubAuth, sha: string) => Promise<CommitDetail>;

function isCandidate(value: unknown): value is StageACandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StageACandidate>;
  return typeof candidate.sha === "string" && candidate.sha.length > 0 &&
    ["contribution_match", "automatic_recommendation"].includes(candidate.source ?? "") &&
    (candidate.contributionItem === null || typeof candidate.contributionItem === "string");
}

function llmErrorResponse(error: ExperienceCandidateOutputError) {
  const status = { schema_validation: 502, unknown_sha: 502, json_parse: 502, unrelated_sha: 502, unknown_file_path: 502, llm_network: 502, llm_auth: 502, llm_rate_limit: 503, llm_timeout: 504, llm_configuration: 500, llm_request: 502, llm_failure: 502 }[error.kind];
  return Response.json({ error: { kind: error.kind, message: error.message } }, { status });
}

export async function handleStageB(request: NextRequest, generate?: GenerateStageB, timeoutMs?: number, fetchDetail: FetchDetail = fetchCommitDetailBySha): Promise<Response> {
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (declaredLength > MAX_STAGE_B_BODY_BYTES) return Response.json({ error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } }, { status: 413 });
    if (new TextEncoder().encode(await request.clone().text()).byteLength > MAX_STAGE_B_BODY_BYTES) return Response.json({ error: { kind: "body_too_large", message: "요청 본문은 4.5MB 이하여야 합니다." } }, { status: 413 });
    const { body, auth } = await readGitHubRouteRequest(request);
    const candidates = body.candidates;
    if (!Array.isArray(candidates) || !candidates.every(isCandidate) || candidates.length > STAGE_B_MAX_CANDIDATES || new Set(candidates.map(({ sha }) => sha)).size !== candidates.length) {
      return Response.json({ error: { kind: "invalid_request", message: "Stage B 입력 형식이 올바르지 않습니다." } }, { status: 422 });
    }
    if (candidates.length === 0) return Response.json({ candidates: [], insufficientCandidatesReason: "Stage A에서 선별된 후보가 없습니다.", diffs: [] });
    const commits: CommitDetail[] = [];
    for (const candidate of candidates) commits.push(await fetchDetail(auth, candidate.sha));
    const output = await selectStageBCandidates(commits, candidates, generate, timeoutMs);
    const selected = new Set(output.candidates.flatMap(({ sha, relatedShas }) => [sha, ...relatedShas]));
    const bounded = buildStageBPayload(commits, candidates).commits;
    return Response.json({ ...output, diffs: bounded.filter(({ sha }) => selected.has(sha)).map(({ sha, files }) => ({ sha, files: files.map(({ path, status, additions, deletions, changes, patch }) => ({ path, status, additions, deletions, changes, ...(patch === undefined ? {} : { patch }) })) })) });
  } catch (error) {
    if (error instanceof ExperienceCandidateOutputError) return llmErrorResponse(error);
    if (error instanceof GitHubRouteRequestError || error instanceof GitHubFetchError) return githubErrorResponse(error);
    return Response.json({ error: { kind: "server_error", message: "Stage B 분석에 실패했습니다." } }, { status: 500 });
  }
}

export function POST(request: NextRequest): Promise<Response> { return handleStageB(request); }
