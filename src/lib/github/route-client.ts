import { apiFetch, GITHUB_BATCH_LIMITS } from "./api-contract";
import { GitHubFetchError, RepositoryContributionFetchError } from "./errors";
import type {
  CommitDetailWithoutPatch,
  CommitSummary,
  ContributionFetchProgress,
  RepositoryRef,
  RepositoryContributionData,
} from "./types";

const jsonRequest = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function invalidResponse(): never {
  throw new GitHubFetchError("server_error", "서버 응답 형식이 올바르지 않습니다.");
}

export async function fetchAuthoredCommitsFromApi(repository: RepositoryRef) {
  const commits: CommitSummary[] = [];
  let cursor: string | null | undefined;
  let repositoryHasCommits = true;
  try {
    do {
      const result = await apiFetch<{
        commits: CommitSummary[];
        repositoryHasCommits: boolean;
        cursor: string | null;
      }>("/api/github/commits", jsonRequest({ ...repository, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result.commits) || typeof result.repositoryHasCommits !== "boolean" || (result.cursor !== null && typeof result.cursor !== "string")) invalidResponse();
      commits.push(...result.commits);
      repositoryHasCommits = result.repositoryHasCommits;
      cursor = result.cursor;
    } while (cursor !== null);
    return { commits, repositoryHasCommits };
  } catch (error) {
    if (commits.length === 0) throw error;
    throw new GitHubFetchError("partial_failure", (error as Error).message, commits, { cause: error });
  }
}

export async function fetchContributionsFromApi(
  repository: RepositoryRef,
  commits: readonly CommitSummary[],
  onProgress: (progress: ContributionFetchProgress) => void
): Promise<RepositoryContributionData> {
  const details: CommitDetailWithoutPatch[] = [];
  onProgress({ phase: "commit_details", completed: 0, total: commits.length });
  try {
    for (let start = 0; start < commits.length; start += GITHUB_BATCH_LIMITS.commitDetails) {
      const result = await apiFetch<{ commits: CommitDetailWithoutPatch[] }>(
        "/api/github/commit-details",
        jsonRequest({ ...repository, commits: commits.slice(start, start + GITHUB_BATCH_LIMITS.commitDetails) }),
        true
      );
      if (!Array.isArray(result.commits)) invalidResponse();
      details.push(...result.commits);
      onProgress({ phase: "commit_details", completed: details.length, total: commits.length });
    }
    onProgress({ phase: "repository_metadata" });
    const metadata = await apiFetch<Omit<RepositoryContributionData, "commits">>(
      "/api/github/repository-meta",
      jsonRequest(repository),
      true
    );
    if (!metadata || !Array.isArray(metadata.tree) || typeof metadata.treeTruncated !== "boolean" || metadata.languages === null || typeof metadata.languages !== "object") invalidResponse();
    return { commits: details, ...metadata };
  } catch (error) {
    const partial = [
      ...details,
      ...((error instanceof GitHubFetchError ? error.partialCommits : undefined) ?? []),
    ] as CommitDetailWithoutPatch[];
    if (partial.length === 0) throw error;
    throw new RepositoryContributionFetchError("partial_failure", (error as Error).message, partial, { cause: error });
  }
}
