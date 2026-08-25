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
  /** 모델이 후보가 아니라고 판단한 묶음입니다. */
  readonly unclassifiedShas: readonly string[];
  /**
   * 모델이 끝내 판단하지 못한 묶음입니다.
   *
   * `unclassifiedShas`와 나눠 둡니다. 판단 결과 후보가 아닌 것과 판단 자체가 없는 것은 다르고,
   * 둘을 합치면 화면이 "판단하지 못한 N건"을 표시할 수 없어 조용한 배제가 됩니다.
   */
  readonly unjudgedShas: readonly string[];
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
  /**
   * 선별을 통과해 판단 대상이 된 묶음 수입니다. `processedShas`가 묶음의 대표 커밋 SHA이므로
   * 진행 상황을 말할 때 견줄 분모가 이 값입니다.
   *
   * 실패 문구 쪽에서 커밋 수로 다시 유도하지 않으려고 여기에 싣습니다. 유도하면 분모와 분자가
   * 서로 다른 단위가 되고, 유도 시점의 입력이 판단 시점과 달라지면 둘이 어긋납니다.
   * `StageACandidateOutput`이 아니라 체크포인트에만 더해 서버 응답 계약은 건드리지 않습니다.
   */
  readonly totalUnits: number;
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

/**
 * 근거 항목 하나의 확인 수준입니다. `evidence-verifiability.ts`의 상수가 화면 문구인 것과 달리
 * 이 값은 인계 payload에 그대로 실립니다. 화면 문구로만 두면 인계에서 사라지고 소비자가 확인 불가
 * 항목을 사실처럼 다루게 됩니다.
 */
export interface EvidenceVerifiability {
  readonly status: VerifiabilityStatus;
  /**
   * LLM이 고른 값이면 true입니다. `status`가 `verified`여도 관계까지만 확인되고 근거로서 관련
   * 있다는 판단은 확인 불가입니다.
   */
  readonly aiSelected: boolean;
  /** 무엇까지 확인되는지 한 문장으로 적습니다. 소비자가 그대로 인용할 수 있습니다. */
  readonly detail: string;
}

/** patch 본문이 없는 이유입니다. 예산 소진과 GitHub 미제공을 구분합니다. */
export type EvidencePatchOmittedReason = "budget_exhausted" | "not_provided";

export interface EvidenceSnapshotFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  /** 상한 배분을 통과한 patch 본문입니다. 본문이 없으면 null입니다. */
  readonly patch: string | null;
  /** 원본보다 짧아졌으면 true입니다. 절단은 정상 상태이고 부재보다 먼저 판정합니다. */
  readonly patchTruncated: boolean;
  /** 본문이 없는 이유입니다. 본문이 있으면 null입니다. */
  readonly patchOmittedReason: EvidencePatchOmittedReason | null;
}

export type EvidenceCommitRole = "representative" | "related";

export interface EvidenceSnapshotCommit {
  readonly sha: string;
  readonly role: EvidenceCommitRole;
  /** 커밋 색인에서 찾은 커밋인지 나타냅니다. false이면 제목·메시지·PR 정보를 확인할 수 없습니다. */
  readonly indexed: boolean;
  readonly title: string | null;
  readonly message: string | null;
  readonly pullRequests: readonly Pick<
    PullRequestReference,
    "number" | "title" | "state" | "baseBranch" | "headBranch"
  >[];
  readonly files: readonly EvidenceSnapshotFile[];
  readonly verifiability: EvidenceVerifiability;
}

/** LLM이 작성한 문장처럼 확인 수준을 함께 실어야 하는 텍스트 항목입니다. */
export interface EvidenceSnapshotStatement {
  readonly text: string;
  readonly verifiability: EvidenceVerifiability;
}

/** LLM이 고른 경로 목록처럼 확인 수준을 함께 실어야 하는 목록 항목입니다. */
export interface EvidenceSnapshotPaths {
  readonly paths: readonly string[];
  readonly verifiability: EvidenceVerifiability;
}

/**
 * 근거 입력 크기 예산입니다. patch만 재지 않고 직렬화한 근거 전체를 추정 토큰으로 묶습니다.
 * 문자 수가 아니라 UTF-8 바이트를 쓰는 이유는 비ASCII 근거에서 문자 수 상한이 실제 토큰을
 * 대표하지 못하기 때문입니다.
 */
export interface EvidenceSnapshotPatchBudget {
  /** 근거 입력 전체의 추정 토큰 상한입니다. */
  readonly maxInputTokens: number;
  /** patch를 뺀 나머지 근거의 추정 토큰입니다. */
  readonly metadataTokens: number;
  /** 남은 몫으로 patch에 배정한 UTF-8 바이트입니다. */
  readonly maxPatchBytes: number;
  /** patch에 실제로 실은 UTF-8 바이트입니다. */
  readonly patchBytes: number;
  /** 상한 때문에 patch를 자르거나 빼면 true입니다. */
  readonly truncatedByBudget: boolean;
}

/** 선택한 경험 1개의 Repository 근거를 AI 질문 기능이 그대로 소비하는 형태로 고정합니다. */
export interface ExperienceEvidenceSnapshot {
  readonly candidateSha: string;
  readonly source: ExperienceCandidateSource;
  readonly origin: EvidenceOrigin;
  readonly evidence: EvidenceSnapshotStatement;
  readonly representativeCommit: EvidenceSnapshotCommit;
  readonly relatedCommits: readonly EvidenceSnapshotCommit[];
  readonly citedFilePaths: EvidenceSnapshotPaths;
  /** Repository로 확인할 수 없는 고정 항목입니다. */
  readonly unverifiableItems: readonly string[];
  readonly patchBudget: EvidenceSnapshotPatchBudget;
}

export type EvidenceSnapshotFailureReason =
  | "representative_commit_not_indexed"
  | "no_repository_evidence"
  /** patch를 모두 빼도 나머지 근거만으로 입력 상한을 넘는 경우입니다. */
  | "evidence_input_too_large";

export type EvidenceSnapshotResult =
  | { readonly ok: true; readonly snapshot: ExperienceEvidenceSnapshot }
  | { readonly ok: false; readonly reason: EvidenceSnapshotFailureReason };
