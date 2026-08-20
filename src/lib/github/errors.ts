import type { CommitDetail, CommitSummary } from "./types";

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
  readonly partialData?: { commits: CommitDetail[] };

  constructor(
    kind: GitHubFetchErrorKind,
    message: string,
    partialCommits?: CommitSummary[],
    partialData?: { commits: CommitDetail[] }
  ) {
    super(message);
    this.name = "GitHubFetchError";
    this.kind = kind;
    this.partialCommits = partialCommits;
    this.partialData = partialData;
  }
}
