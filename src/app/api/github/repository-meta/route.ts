import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/github/api-contract";
import { fetchRepositoryMetadata } from "@/lib/github/contributions";
import { GitHubFetchError } from "@/lib/github/errors";
import { readGitHubRouteRequest } from "@/lib/github/route-request";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { body, auth } = await readGitHubRouteRequest(request);
    if (typeof body.repositoryHasCommits !== "boolean") {
      throw new GitHubFetchError("server_error", "repositoryHasCommits가 필요합니다.");
    }
    return Response.json(await fetchRepositoryMetadata(auth, body.repositoryHasCommits));
  } catch (error) {
    return errorResponse(error);
  }
}
