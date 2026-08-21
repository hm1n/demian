import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/github/api-contract";
import { fetchRepositoryMetadata } from "@/lib/github/contributions";
import { readGitHubRouteRequest } from "@/lib/github/route-request";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { auth } = await readGitHubRouteRequest(request);
    return Response.json(await fetchRepositoryMetadata(auth));
  } catch (error) {
    return errorResponse(error);
  }
}
