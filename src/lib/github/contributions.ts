import {
  classifyErrorResponse,
  GITHUB_API_BASE,
  githubFetch,
  parseJson,
  parseNextLink,
} from "./commits";
import { GitHubFetchError, RepositoryContributionFetchError } from "./errors";
import type {
  CommitDetail,
  CommitSummary,
  ContributionFetchProgress,
  GitHubAuth,
  PullRequestReference,
  RepositoryContributionData,
  RepositoryTreeEntry,
} from "./types";

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

export async function fetchCommitDetail(
  auth: GitHubAuth,
  summary: CommitSummary
): Promise<CommitDetail> {
  const { owner, repo, token } = auth;
  const encodedSha = encodeURIComponent(summary.sha);
  const detail = await fetchAllCommitFiles(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodedSha}`,
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

export async function fetchCommitDetailsBatch(
  auth: GitHubAuth,
  commits: readonly CommitSummary[]
): Promise<CommitDetail[]> {
  const details: CommitDetail[] = [];
  try {
    for (const commit of commits) details.push(await fetchCommitDetail(auth, commit));
    return details;
  } catch (error) {
    if (details.length === 0) throw error;
    throw new RepositoryContributionFetchError(
      "partial_failure",
      (error as Error).message,
      details,
      { cause: error }
    );
  }
}

export async function fetchRepositoryMetadata(
  auth: GitHubAuth,
  repositoryHasCommits: boolean
): Promise<Omit<RepositoryContributionData, "commits">> {
  const { owner, repo, token } = auth;
  const { data: languages } = await requestPage<Record<string, number>>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/languages`,
    token,
    "Repository 언어 통계를 가져오지 못했습니다"
  );
  const treeResponse = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    token
  );
  let tree: RawTree;
  const treeMissing = treeResponse.status === 404 || treeResponse.status === 409;
  if (treeMissing && !repositoryHasCommits) {
    tree = { tree: [], truncated: false };
  } else if (!treeResponse.ok) {
    throw new GitHubFetchError(
      await classifyErrorResponse(treeResponse),
      `Repository 파일 트리를 가져오지 못했습니다 (${treeResponse.status})`
    );
  } else {
    tree = await parseJson<RawTree>(treeResponse, "Repository 파일 트리 응답을 해석하지 못했습니다");
  }
  return {
    tree: tree.tree.map((entry) => ({
      path: entry.path,
      type: entry.type,
      sha: entry.sha,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    })),
    treeTruncated: tree.truncated,
    languages,
  };
}

/**
 * 블랙리스트 필터를 통과한 커밋의 근거 데이터와 저장소 구조를 수집한다.
 * 입력 커밋을 자체 평가하거나 순위를 매기지 않으며, PR 소속 정보도 그대로 보존한다.
 */
export async function fetchRepositoryContributionData(
  auth: GitHubAuth,
  commits: readonly CommitSummary[],
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
    const { data: languages } = await requestPage<Record<string, number>>(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/languages`,
      token,
      "Repository 언어 통계를 가져오지 못했습니다"
    );
    const treeResponse = await githubFetch(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      token
    );
    let tree: RawTree;
    // 커밋이 없는 저장소는 HEAD ref가 없어 404를, 저장소 자체가 비어 있는 동안에는 409를 반환한다.
    // 언어 통계 조회가 방금 성공했고 상세 조회할 커밋도 없으므로 Repository 미존재가 아니라 빈 저장소다.
    // 상세 조회한 커밋이 있는데도 트리가 없는 경우는 빈 저장소일 수 없어 실패로 던진다.
    const treeMissing = treeResponse.status === 404 || treeResponse.status === 409;
    if (treeMissing && commits.length === 0) {
      tree = { tree: [], truncated: false };
    } else if (!treeResponse.ok) {
      throw new GitHubFetchError(
        await classifyErrorResponse(treeResponse),
        `Repository 파일 트리를 가져오지 못했습니다 (${treeResponse.status})`
      );
    } else {
      tree = await parseJson<RawTree>(
        treeResponse,
        "Repository 파일 트리 응답을 해석하지 못했습니다"
      );
    }

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
    throw new RepositoryContributionFetchError(
      "partial_failure",
      (error as Error).message,
      details,
      { cause: error }
    );
  }
}
