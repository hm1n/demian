import {
  classifyErrorResponse,
  fetchRepoInfo,
  githubFetch,
  parseJson,
  parseNextLink,
} from "./commits";
import { GitHubFetchError } from "./errors";
import type {
  CommitDetail,
  CommitSummary,
  ContributionFetchProgress,
  GitHubAuth,
  PullRequestReference,
  RepositoryContributionData,
  RepositoryTreeEntry,
} from "./types";

const GITHUB_API_BASE = "https://api.github.com";

interface RawCommitDetail {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
  stats?: { additions: number; deletions: number };
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>;
}

interface RawPullRequest {
  number: number;
  title: string;
  state: string;
  html_url: string;
  base: { ref: string };
  head: { ref: string };
}

interface RawTree {
  truncated: boolean;
  tree: Array<{
    path: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
  }>;
}

async function requestJson<T>(url: string, token: string, context: string): Promise<T> {
  const response = await githubFetch(url, token);
  if (!response.ok) {
    throw new GitHubFetchError(
      await classifyErrorResponse(response),
      `${context} (${response.status})`
    );
  }
  return parseJson<T>(response, `${context} 응답을 해석하지 못했습니다`);
}

async function requestPage<T>(
  url: string,
  token: string,
  context: string
): Promise<{ data: T; next: string | null }> {
  const response = await githubFetch(url, token);
  if (!response.ok) {
    throw new GitHubFetchError(
      await classifyErrorResponse(response),
      `${context} (${response.status})`
    );
  }
  return {
    data: await parseJson<T>(response, `${context} 응답을 해석하지 못했습니다`),
    next: parseNextLink(response.headers.get("link")),
  };
}

async function fetchAllCommitFiles(
  url: string,
  token: string,
  sha: string
): Promise<RawCommitDetail> {
  let next: string | null = url;
  let detail: RawCommitDetail | undefined;
  const files: NonNullable<RawCommitDetail["files"]> = [];

  while (next) {
    const page: { data: RawCommitDetail; next: string | null } = await requestPage<RawCommitDetail>(
      next,
      token,
      `커밋 상세 정보를 가져오지 못했습니다: ${sha}`
    );
    detail ??= page.data;
    files.push(...(page.data.files ?? []));
    next = page.next;
  }

  return { ...detail!, files };
}

async function fetchAllPullRequests(
  url: string,
  token: string,
  sha: string
): Promise<RawPullRequest[]> {
  let next: string | null = url;
  const pullRequests: RawPullRequest[] = [];

  while (next) {
    const page: { data: RawPullRequest[]; next: string | null } = await requestPage<
      RawPullRequest[]
    >(
      next,
      token,
      `커밋 PR 정보를 가져오지 못했습니다: ${sha}`
    );
    pullRequests.push(...page.data);
    next = page.next;
  }

  return pullRequests;
}

function toPullRequest(raw: RawPullRequest): PullRequestReference {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    url: raw.html_url,
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
  };
}

async function fetchCommitDetail(
  auth: GitHubAuth,
  summary: CommitSummary
): Promise<CommitDetail> {
  const { owner, repo, token } = auth;
  const encodedSha = encodeURIComponent(summary.sha);
  const detail = await fetchAllCommitFiles(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodedSha}?per_page=100`,
    token,
    summary.sha
  );
  const pullRequests = await fetchAllPullRequests(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodedSha}/pulls?per_page=100`,
    token,
    summary.sha
  );
  const files = detail.files ?? [];

  return {
    ...summary,
    message: detail.commit.message,
    author: detail.author?.login ?? detail.commit.author?.name ?? summary.author,
    date: detail.commit.author?.date ?? summary.date,
    additions: detail.stats?.additions ?? 0,
    deletions: detail.stats?.deletions ?? 0,
    changedFiles: files.length,
    files: files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
    })),
    pullRequests: pullRequests.map(toPullRequest),
  };
}

/**
 * 블랙리스트 필터를 통과한 커밋의 근거 데이터와 저장소 구조를 수집한다.
 * 입력 커밋을 자체 평가하거나 순위를 매기지 않으며, PR 소속 정보도 그대로 보존한다.
 */
export async function fetchRepositoryContributionData(
  auth: GitHubAuth,
  commits: CommitSummary[],
  onProgress?: (progress: ContributionFetchProgress) => void
): Promise<RepositoryContributionData> {
  const details: CommitDetail[] = [];

  try {
    onProgress?.({ phase: "commit_details", completed: 0, total: commits.length });
    for (const commit of commits) {
      details.push(await fetchCommitDetail(auth, commit));
      onProgress?.({
        phase: "commit_details",
        completed: details.length,
        total: commits.length,
      });
    }

    onProgress?.({ phase: "repository_metadata" });
    const { owner, repo, token } = auth;
    const { defaultBranch } = await fetchRepoInfo(auth);
    const tree = await requestJson<RawTree>(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      token,
      "Repository 파일 트리를 가져오지 못했습니다"
    );
    const languages = await requestJson<Record<string, number>>(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/languages`,
      token,
      "Repository 언어 통계를 가져오지 못했습니다"
    );

    onProgress?.({ phase: "metrics" });
    return {
      commits: details,
      tree: tree.tree.map(
        (entry): RepositoryTreeEntry => ({
          path: entry.path,
          type: entry.type,
          sha: entry.sha,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })
      ),
      treeTruncated: tree.truncated,
      languages,
    };
  } catch (error) {
    if (details.length === 0) throw error;
    throw new GitHubFetchError("partial_failure", (error as Error).message, undefined, {
      commits: details,
    });
  }
}
