export interface GitHubAuth {
  owner: string;
  repo: string;
  token: string;
}

export interface CommitSummary {
  sha: string;
  title: string;
  author: string;
  date: string;
  parentCount: number;
}

export interface CommitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequestReference {
  number: number;
  title: string;
  state: string;
  url: string;
  baseBranch: string;
  headBranch: string;
}

export interface CommitDetail extends CommitSummary {
  message: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: CommitFileChange[];
  pullRequests: PullRequestReference[];
}

export interface RepositoryTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface RepositoryContributionData {
  commits: CommitDetail[];
  tree: RepositoryTreeEntry[];
  treeTruncated: boolean;
  languages: Record<string, number>;
}

export type ContributionFetchProgress =
  | { phase: "commit_details"; completed: number; total: number }
  | { phase: "repository_metadata" }
  | { phase: "metrics" };
