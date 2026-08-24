import type {
  CommitFileChange,
  PullRequestReference,
  ReadonlyCommitDetail,
  RepositoryTreeEntry,
} from "@/lib/github/types";

export type ExperienceCandidateSource = "contribution_match" | "automatic_recommendation";
export type EvidenceOrigin = "repository";
/** 출처(origin) 축과 다른 별도 축입니다. 검증 여부만 나타내고 근거가 어디서 왔는지는 나타내지 않습니다. */
export type VerifiabilityStatus = "verified" | "unverifiable";

export interface ExperienceCandidate {
  readonly sha: string;
  readonly relatedShas: readonly string[];
  readonly evidence: string;
  readonly citedFilePaths: readonly string[];
  readonly source: ExperienceCandidateSource;
}

export interface ExperienceCandidateListItem {
  readonly candidate: ExperienceCandidate;
  readonly commit: ReadonlyCommitDetail | null;
  readonly origin: EvidenceOrigin;
  readonly normalizedRelatedShas: readonly string[];
  readonly normalizedCitedFilePaths: readonly string[];
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

export interface StageACandidate {
  readonly sha: string;
  readonly source: ExperienceCandidateSource;
  readonly contributionItem: string | null;
}

export interface StageACandidateOutput {
  readonly candidates: readonly StageACandidate[];
  readonly unclassifiedShas: readonly string[];
}

export interface StageARateLimit {
  readonly remainingTokens: number;
  readonly resetAfterMs: number;
  readonly usedTokens: number;
}

export interface StageAChunkOutput extends StageACandidateOutput {
  readonly rateLimit: StageARateLimit | null;
}

export interface StageACheckpoint extends StageACandidateOutput {
  readonly processedShas: readonly string[];
}

export interface StageAProgress {
  readonly completed: number;
  readonly total: number;
  readonly waitingForRateLimit: boolean;
}

export interface CandidateDiffFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
  readonly patchTruncated?: boolean;
}

export interface CandidateDiff {
  readonly sha: string;
  readonly files: readonly CandidateDiffFile[];
}

/** `/api/candidates/stage-b` 응답으로, 최종 후보와 근거 diff를 함께 전달합니다. */
export interface StageBCandidateResult extends ExperienceCandidateOutput {
  readonly diffs: readonly CandidateDiff[];
}
