import { apiFetch } from "./api-contract";
import { GitHubFetchError, RepositoryContributionFetchError } from "./errors";
import type {
  CommitDetailWithoutPatch,
  CommitSummary,
  ContributionFetchProgress,
  GitHubAuth,
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

export async function fetchAuthoredCommitsFromApi(auth: GitHubAuth) {
  const commits: CommitSummary[] = [];
  let cursor: string | null | undefined;
  let repositoryHasCommits = true;
  try {
    do {
      const result = await apiFetch<{
        commits: CommitSummary[];
        repositoryHasCommits: boolean;
        cursor: string | null;
      }>("/api/github/commits", jsonRequest({ owner: auth.owner, repo: auth.repo, ...(cursor ? { cursor } : {}) }));
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
  auth: GitHubAuth,
  commits: readonly CommitSummary[],
  onProgress: (progress: ContributionFetchProgress) => void
): Promise<RepositoryContributionData> {
  const details: CommitDetailWithoutPatch[] = [];
  onProgress({ phase: "commit_details", completed: 0, total: commits.length });
  try {
    for (let start = 0; start < commits.length; start += 20) {
      const result = await apiFetch<{ commits: CommitDetailWithoutPatch[] }>(
        "/api/github/commit-details",
        jsonRequest({ owner: auth.owner, repo: auth.repo, commits: commits.slice(start, start + 20) }),
        true
      );
      if (!Array.isArray(result.commits)) invalidResponse();
      details.push(...result.commits);
      onProgress({ phase: "commit_details", completed: details.length, total: commits.length });
    }
    onProgress({ phase: "repository_metadata" });
    const metadata = await apiFetch<Omit<RepositoryContributionData, "commits">>(
      "/api/github/repository-meta",
      jsonRequest({ owner: auth.owner, repo: auth.repo, repositoryHasCommits: true }),
      true
    );
    if (!metadata || !Array.isArray(metadata.tree) || typeof metadata.treeTruncated !== "boolean" || typeof metadata.languages !== "object") invalidResponse();
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
