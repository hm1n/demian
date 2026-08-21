import type { NextRequest } from "next/server";
import { errorResponse, GITHUB_BATCH_LIMITS, GitHubRouteRequestError } from "@/lib/github/api-contract";
import { fetchCommitDetailsBatch, withoutPatch } from "@/lib/github/contributions";
import { RepositoryContributionFetchError } from "@/lib/github/errors";
import { readGitHubRouteRequest } from "@/lib/github/route-request";
import type { CommitSummary } from "@/lib/github/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function isCommitSummary(value: unknown): value is CommitSummary {
  return typeof value === "object" && value !== null &&
    ["sha", "title", "author", "date"].every((key) => typeof (value as Record<string, unknown>)[key] === "string") &&
    Number.isInteger((value as Record<string, unknown>).parentCount);
}

export async function POST(request: NextRequest): Promise<Response> {
  let total: number | undefined;
  try {
    const { body, auth } = await readGitHubRouteRequest(request);
    if (!Array.isArray(body.commits) || !body.commits.every(isCommitSummary) || body.commits.length > GITHUB_BATCH_LIMITS.commitDetails) {
      throw new GitHubRouteRequestError("invalid_request", `commits는 최대 ${GITHUB_BATCH_LIMITS.commitDetails}개여야 합니다.`, 422);
    }
    total = body.commits.length;
    const commits = await fetchCommitDetailsBatch(auth, body.commits);
    return Response.json({ commits: commits.map(withoutPatch), completed: commits.length, total });
  } catch (error) {
    if (error instanceof RepositoryContributionFetchError && error.partialCommits) {
      return errorResponse(
        new RepositoryContributionFetchError(error.kind, error.message, error.partialCommits.map(withoutPatch), { cause: error.cause }),
        total
      );
    }
    return errorResponse(error, total);
  }
}
