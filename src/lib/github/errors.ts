import type { CommitDetail, CommitSummary } from "./types";

export type GitHubFetchErrorKind =
  | "rate_limit"
  | "auth_revoked"
  | "repo_not_found"
  | "network"
  | "server_error"
  | "partial_failure";

export class GitHubFetchError<TCommit extends CommitSummary = CommitSummary> extends Error {
  readonly kind: GitHubFetchErrorKind;
  readonly partialCommits?: TCommit[];

  constructor(
    kind: GitHubFetchErrorKind,
    message: string,
    partialCommits?: TCommit[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GitHubFetchError";
    this.kind = kind;
    this.partialCommits = partialCommits;
  }
}

/** 후보 데이터 조회 중 일부만 수집했을 때 CommitDetail 근거를 보존하는 오류입니다. */
export class CandidateDataFetchError extends GitHubFetchError<CommitDetail> {}
