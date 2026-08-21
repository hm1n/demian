import type { NextRequest } from "next/server";
import { errorResponse, GITHUB_BATCH_LIMITS, GitHubRouteRequestError } from "@/lib/github/api-contract";
import { fetchAuthoredCommitsBatch } from "@/lib/github/commits";
import { decodeCommitCursor, encodeCommitCursor } from "@/lib/github/cursor";
import { readGitHubRouteRequest } from "@/lib/github/route-request";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { body, auth } = await readGitHubRouteRequest(request);
    let cursor;
    try {
      cursor = decodeCommitCursor(body.cursor);
    } catch {
      throw new GitHubRouteRequestError("invalid_request", "커서가 손상되었거나 유효하지 않습니다.", 422);
    }
    const result = await fetchAuthoredCommitsBatch(auth, cursor, GITHUB_BATCH_LIMITS.commitPages);
    return Response.json({
      commits: result.commits,
      repositoryHasCommits: result.repositoryHasCommits,
      cursor: result.cursor === null ? null : encodeCommitCursor(result.cursor),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
