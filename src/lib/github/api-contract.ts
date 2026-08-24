import {
  GitHubFetchError,
  RepositoryContributionFetchError,
  type GitHubFetchErrorKind,
} from "./errors";
import type { CommitDetail, CommitSummary } from "./types";

// 이슈 #19 실측(2026-08-24)으로 확정. 근거는 위키 측정 문서에 있다.
export const GITHUB_BATCH_LIMITS = {
  // 커밋 목록 1페이지(100개)당 약 550ms라 20페이지(=2000커밋)도 약 11초로 maxDuration 60초 안에 든다.
  commitPages: 20,
  // 상세 조회는 커밋당 요청 2개·844ms(순차)라 20개는 약 16.9초다. 병렬화하면 병렬도 4에서
  // 3.9초, 8에서 2.3초로 줄고 secondary rate limit은 관측되지 않았다.
  commitDetails: 20,
} as const;

export interface SerializedGitHubError {
  kind: GitHubFetchErrorKind;
  message: string;
  causeKind?: Exclude<GitHubFetchErrorKind, "partial_failure">;
  partialCommits?: CommitSummary[] | CommitDetail[];
  completed?: number;
  total?: number;
}

export class GitHubRouteRequestError extends Error {
  constructor(
    readonly kind: "invalid_json" | "invalid_request",
    message: string,
    readonly status: 400 | 422
  ) {
    super(message);
  }
}

const STATUS_BY_KIND: Record<GitHubFetchErrorKind, number> = {
  auth_revoked: 401,
  repo_not_found: 404,
  rate_limit: 429,
  network: 502,
  server_error: 500,
  partial_failure: 500,
};

function rootKind(error: GitHubFetchError): SerializedGitHubError["causeKind"] {
  let cause: unknown = error.cause;
  while (cause instanceof GitHubFetchError) {
    if (cause.kind !== "partial_failure") return cause.kind;
    cause = cause.cause;
  }
  return undefined;
}

export function errorResponse(error: unknown, total?: number): Response {
  if (error instanceof GitHubRouteRequestError) {
    return Response.json(
      { error: { kind: error.kind, message: error.message } },
      { status: error.status }
    );
  }
  const githubError =
    error instanceof GitHubFetchError
      ? error
      : new GitHubFetchError("server_error", "GitHub 조회 요청을 처리하지 못했습니다.");
  const body: SerializedGitHubError = {
    kind: githubError.kind,
    message: githubError.message,
    ...(rootKind(githubError) === undefined ? {} : { causeKind: rootKind(githubError) }),
    ...(githubError.partialCommits === undefined ? {} : { partialCommits: githubError.partialCommits }),
    ...(githubError.partialCommits === undefined ? {} : { completed: githubError.partialCommits.length }),
    ...(total === undefined ? {} : { total }),
  };
  return Response.json({ error: body }, { status: STATUS_BY_KIND[githubError.kind] });
}

function isKind(value: unknown): value is GitHubFetchErrorKind {
  return Object.keys(STATUS_BY_KIND).includes(value as string);
}

export async function readApiResponse<T>(response: Response, detailError = false): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubFetchError("server_error", "서버 응답을 해석하지 못했습니다.");
  }
  if (response.ok) return body as T;
  const serialized =
    typeof body === "object" && body !== null && "error" in body &&
    typeof body.error === "object" && body.error !== null
      ? body.error
      : undefined;
  if (!serialized || !("kind" in serialized) || !isKind(serialized.kind)) {
    throw new GitHubFetchError("server_error", "서버 오류 응답 형식이 올바르지 않습니다.");
  }
  const errorBody = serialized as SerializedGitHubError;
  const cause = errorBody.causeKind
    ? new GitHubFetchError(errorBody.causeKind, errorBody.message)
    : undefined;
  if (detailError) {
    throw new RepositoryContributionFetchError(errorBody.kind, errorBody.message, errorBody.partialCommits as CommitDetail[] | undefined, cause ? { cause } : undefined);
  }
  throw new GitHubFetchError(errorBody.kind, errorBody.message, errorBody.partialCommits as CommitSummary[] | undefined, cause ? { cause } : undefined);
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit, detailError = false): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new GitHubFetchError("network", "서버에 연결하지 못했습니다.");
  }
  return readApiResponse<T>(response, detailError);
}
