import type {
  CommitFileChange,
  PullRequestReference,
  RepositoryTreeEntry,
} from "@/lib/github/types";

export type ExperienceCandidateSource = "contribution_match" | "automatic_recommendation";

export interface ExperienceCandidate {
  readonly sha: string;
  readonly relatedShas: readonly string[];
  readonly evidence: string;
  readonly citedFilePaths: readonly string[];
  readonly source: ExperienceCandidateSource;
}

export interface ExperienceCandidateOutput {
  readonly candidates: readonly ExperienceCandidate[];
  /** 후보가 3개 미만인 이유입니다. 후보가 3개이면 null입니다. */
  readonly insufficientCandidatesReason: string | null;
}

export interface ExperienceCandidateEvidenceInput {
  readonly commits: readonly {
    readonly sha: string;
    readonly files: readonly Pick<CommitFileChange, "path">[];
    readonly pullRequests: readonly Pick<PullRequestReference, "number">[];
  }[];
  readonly fileTree: readonly Pick<RepositoryTreeEntry, "path">[];
}
