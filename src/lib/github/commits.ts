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
  parents: Array<{ sha: string }>;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    const message = (body as { message?: unknown } | null)?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

export async function classifyErrorResponse(response: Response): Promise<GitHubFetchErrorKind> {
  if (response.status === 404) return "repo_not_found";
  if (response.status === 401) return "auth_revoked";
  if (response.status === 429) return "rate_limit";
  if (response.status === 403) {
    // 1차 rate limit: x-ratelimit-remaining이 0. 2차(secondary) rate limit: remaining이 남아 있고
    // retry-after 헤더도 없을 수 있어, 이때는 응답 본문 메시지로 판별한다. 다 놓치면 정상 유저가
    // 인증 취소로 오분류된다.
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = response.headers.get("retry-after");
    if (remaining === "0" || retryAfter !== null) return "rate_limit";

    // ponytail: 메시지 문자열 매칭은 GitHub가 문구를 바꾸면 깨지는 얕은 방법이지만, 공식
    // 문서에 나온 두 문구만 대응하는 지금 수준에서는 충분함. 오분류가 실제로 관찰되면 그때
    // 패턴을 넓히면 됨.
    const message = await readErrorMessage(response);
    if (/secondary rate limit|abuse detection/i.test(message)) return "rate_limit";
    return "auth_revoked";
  }
  return "server_error";
}

export async function githubFetch(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, { headers: githubHeaders(token) });
  } catch {
    throw new GitHubFetchError("network", `GitHub API 요청에 실패했습니다: ${url}`);
  }
}

/** 성공 응답의 body 파싱이 실패하면(끊긴 연결, 깨진 JSON) network 오류로 통일해서 던진다. */
export async function parseJson<T>(response: Response, context: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new GitHubFetchError("network", `${context}: ${(error as Error).message}`);
  }
}

export function parseNextLink(linkHeader: string | null): string | null {
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
    parentCount: raw.parents.length,
  };
}

export interface RepoInfo {
  defaultBranch: string;
}

export async function fetchRepoInfo({ owner, repo, token }: GitHubAuth): Promise<RepoInfo> {
  const response = await githubFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, token);
  if (!response.ok) {
    throw new GitHubFetchError(
      await classifyErrorResponse(response),
      `Repository 정보를 가져오지 못했습니다: ${owner}/${repo} (${response.status})`
    );
  }
  const data = await parseJson<{ default_branch: string }>(
    response,
    `Repository 정보 응답을 해석하지 못했습니다: ${owner}/${repo}`
  );
  return { defaultBranch: data.default_branch };
}

/**
 * 브랜치 이름을 그대로 페이지네이션 sha로 쓰면, 조회 도중 기본 브랜치에 새 커밋이 들어올 때
 * 페이지 경계에서 커밋이 중복되거나 누락될 수 있다. 브랜치 head를 커밋 SHA로 한 번 고정해
 * 이후 모든 페이지 요청이 같은 히스토리를 기준으로 동작하게 한다.
 *
 * 커밋이 하나도 없는 저장소는 기본 브랜치에 대한 ref 자체가 없어 이 조회가 404를 반환한다.
 * 다만 Repository 정보 조회와 이 조회 사이에 기본 브랜치가 바뀌었을 수도 있으므로, 404를
 * 곧바로 빈 저장소로 단정하지 않는다. 저장소 크기(size)는 저장 용량(KB)일 뿐 커밋 수를 보장하지
 * 않아 판별 기준으로 쓸 수 없다. 대신 기본 브랜치를 다시 조회해 이름이 그대로인지로 판별한다.
 * 이름이 바뀌었으면 새 이름으로 한 번 재시도하고, 그대로인데도 404면 실제로 ref가 없는 빈
 * 저장소로 본다.
 *
 * ponytail: 재시도는 1회로 고정. 재시도한 새 브랜치명도 404면(연속 rename) 재확인 없이 그냥
 * 빈 저장소로 본다 — 두 번 연속 레이스는 사실상 안 일어나서 재시도 횟수를 매개변수로 뺄 필요는
 * 없음. 실제로 반복 발생이 확인되면 그때 재시도 횟수를 인자로 빼서 늘리면 됨.
 */
async function resolveBranchHeadSha(
  auth: GitHubAuth,
  branch: string,
  hasRetried = false
): Promise<string | null> {
  const { owner, repo, token } = auth;
  const response = await githubFetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
    token
  );
  if (response.status === 404) {
    if (hasRetried) {
      return null;
    }
    const refreshed = await fetchRepoInfo(auth);
    if (refreshed.defaultBranch === branch) {
      return null;
    }
    return resolveBranchHeadSha(auth, refreshed.defaultBranch, true);
  }
  if (!response.ok) {
    throw new GitHubFetchError(
      await classifyErrorResponse(response),
      `기본 브랜치 정보를 가져오지 못했습니다: ${owner}/${repo}@${branch} (${response.status})`
    );
  }
  const data = await parseJson<{ commit: { sha: string } }>(
    response,
    `기본 브랜치 응답을 해석하지 못했습니다: ${owner}/${repo}@${branch}`
  );
  return data.commit.sha;
}

/**
 * 선택한 Repository의 기본 브랜치를 기준으로 전체 커밋을 페이지네이션 조회한다.
 * 커밋 수에는 임의의 상한을 두지 않는다.
 */
export async function fetchAllCommits(auth: GitHubAuth): Promise<CommitSummary[]> {
  const { owner, repo, token } = auth;
  const { defaultBranch } = await fetchRepoInfo(auth);
  const headSha = await resolveBranchHeadSha(auth, defaultBranch);
  if (headSha === null) {
    return [];
  }

  const commits: CommitSummary[] = [];
  let url: string | null = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
    headSha
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
      // 이미 일부 페이지를 받은 뒤라면 저장소 상태가 바뀐 것이므로 partial_failure로 처리한다.
      if (commits.length > 0) {
        throw new GitHubFetchError(
          "partial_failure",
          `커밋 목록 조회 중 저장소 상태가 변경되어 실패했습니다 (409)`,
          commits
        );
      }
      break;
    }

    if (!response.ok) {
      const message = `커밋 목록 조회에 실패했습니다 (${response.status})`;
      if (commits.length > 0) {
        throw new GitHubFetchError("partial_failure", message, commits);
      }
      throw new GitHubFetchError(await classifyErrorResponse(response), message);
    }

    try {
      const page = await parseJson<RawCommit[]>(response, "커밋 목록 응답을 해석하지 못했습니다");
      commits.push(...page.map(toCommitSummary));
    } catch (error) {
      if (commits.length > 0) {
        throw new GitHubFetchError("partial_failure", (error as Error).message, commits);
      }
      if (error instanceof GitHubFetchError) throw error;
      throw new GitHubFetchError(
        "network",
        `커밋 목록 응답을 해석하지 못했습니다: ${(error as Error).message}`
      );
    }

    url = parseNextLink(response.headers.get("link"));
  }

  return commits;
}
