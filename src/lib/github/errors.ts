import type { CommitSummary } from "./types";

export type GitHubFetchErrorKind =
  | "rate_limit"
  | "auth_revoked"
  | "repo_not_found"
  | "network"
  | "server_error"
  | "partial_failure";

export class GitHubFetchError extends Error {
  readonly kind: GitHubFetchErrorKind;
  readonly partialCommits?: CommitSummary[];

  constructor(
    kind: GitHubFetchErrorKind,
    message: string,
    partialCommits?: CommitSummary[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GitHubFetchError";
    this.kind = kind;
    this.partialCommits = partialCommits;
  }
}
