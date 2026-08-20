import { GitHubFetchError, type GitHubFetchErrorKind } from "./errors";
import type { CommitSummary, GitHubAuth } from "./types";

const GITHUB_API_BASE = "https://api.github.com";
const PER_PAGE = 100;

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function classifyErrorResponse(response: Response): GitHubFetchErrorKind {
  if (response.status === 404) return "repo_not_found";
  if (response.status === 401) return "auth_revoked";
  if (response.status === 429) return "rate_limit";
  if (response.status === 403) {
    // 1차 rate limit: x-ratelimit-remaining이 0. 2차(secondary) rate limit: remaining이 남아 있어도
    // retry-after 헤더로 신호를 준다. 둘 다 놓치면 정상 유저가 인증 취소로 오분류된다.
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = response.headers.get("retry-after");
    return remaining === "0" || retryAfter !== null ? "rate_limit" : "auth_revoked";
  }
  return "server_error";
}

async function githubFetch(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, { headers: githubHeaders(token) });
  } catch {
    throw new GitHubFetchError("network", `GitHub API 요청에 실패했습니다: ${url}`);
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function toCommitSummary(raw: RawCommit): CommitSummary {
  return {
    sha: raw.sha,
    title: raw.commit.message.split("\n")[0],
    author: raw.author?.login ?? raw.commit.author?.name ?? "unknown",
    date: raw.commit.author?.date ?? "",
  };
}

async function fetchDefaultBranch({ owner, repo, token }: GitHubAuth): Promise<string> {
  const response = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, token);
  if (!response.ok) {
    throw new GitHubFetchError(
      classifyErrorResponse(response),
      `Repository 정보를 가져오지 못했습니다: ${owner}/${repo} (${response.status})`
    );
  }
  const data = await response.json();
  return data.default_branch as string;
}

/**
 * 선택한 Repository의 기본 브랜치를 기준으로 전체 커밋을 페이지네이션 조회한다.
 * 커밋 수에는 임의의 상한을 두지 않는다.
 */
export async function fetchAllCommits(auth: GitHubAuth): Promise<CommitSummary[]> {
  const { owner, repo, token } = auth;
  const branch = await fetchDefaultBranch(auth);

  const commits: CommitSummary[] = [];
  let url: string | null = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
    branch
  )}&per_page=${PER_PAGE}`;

  while (url) {
    let response: Response;
    try {
      response = await githubFetch(url, token);
    } catch (error) {
      if (commits.length > 0) {
        throw new GitHubFetchError("partial_failure", (error as Error).message, commits);
      }
      throw error;
    }

    if (response.status === 409) {
      // 커밋이 하나도 없는 Repository는 200 []이 아니라 409 "Git Repository is empty"를 반환한다.
      break;
    }

    if (!response.ok) {
      const message = `커밋 목록 조회에 실패했습니다 (${response.status})`;
      if (commits.length > 0) {
        throw new GitHubFetchError("partial_failure", message, commits);
      }
      throw new GitHubFetchError(classifyErrorResponse(response), message);
    }

    const page: RawCommit[] = await response.json();
    commits.push(...page.map(toCommitSummary));
    url = parseNextLink(response.headers.get("link"));
  }

  return commits;
}
