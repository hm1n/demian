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
}
