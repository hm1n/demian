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
  | { phase: "repository_metadata" };

export type ReadonlyCommitDetail = Readonly<
  Omit<CommitDetail, "files" | "pullRequests"> & {
    files: readonly Readonly<CommitFileChange>[];
    pullRequests: readonly Readonly<PullRequestReference>[];
  }
>;

/** 앞 단계의 실제 조회 결과를 깊은 읽기 전용으로 전달합니다. */
export type ReadonlyRepositoryContributionData = Readonly<
  Omit<RepositoryContributionData, "commits" | "tree" | "languages"> & {
    commits: readonly ReadonlyCommitDetail[];
    tree: readonly Readonly<RepositoryTreeEntry>[];
    languages: Readonly<RepositoryContributionData["languages"]>;
  }
>;

/** 전체 커밋과 앞 단계의 실제 조회 결과를 출력 조립 함수에 전달합니다. */
export interface CandidateDataInput {
  readonly allCommits: readonly Readonly<CommitSummary>[];
  readonly contributionData: ReadonlyRepositoryContributionData;
}

/** 개발 경험 후보 생성 기능의 Repository 근거 입력입니다. */
export interface CandidateDataOutput {
  /** 블랙리스트 제외 여부와 무관한 인증 사용자 본인의 전체 커밋 메타데이터입니다. */
  readonly allCommits: readonly Readonly<CommitSummary>[];
  /** 블랙리스트에서 제외되지 않아 상세 조회한 커밋입니다. */
  readonly includedCommits: readonly ReadonlyCommitDetail[];
  readonly repository: Readonly<{
    fileTree: readonly Readonly<RepositoryTreeEntry>[];
    treeTruncated: boolean;
    languages: Readonly<Record<string, number>>;
  }>;
}
