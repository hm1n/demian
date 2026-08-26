import type {
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceVerifiability,
  ExperienceEvidenceSnapshot,
} from "@/features/experience-candidates/types";

/**
 * `POST /api/interview/stream`의 요청 본문입니다. 하위 이슈 B와 공유하는 계약이고 착수 전에
 * 고정했습니다. 서버는 커밋과 diff를 다시 조립하지 않고 스냅샷을 그대로 소비합니다.
 */
export interface InterviewStreamRequestBody {
  readonly snapshot: ExperienceEvidenceSnapshot;
}

/**
 * 요청 본문 상한입니다.
 *
 * 근거 스냅샷은 만들 때 추정 3,500토큰으로 묶이고 실측 직렬화 크기는 10KB대였습니다. 64KB는 그
 * 위로 넉넉한 자리이면서, 본문을 다 읽기 전에 거절할 수 있는 크기입니다. Stage A의 4.5MB를 쓰지
 * 않는 이유는 입력의 성격이 다르기 때문입니다. Stage A는 저장소 전체 커밋 요약을 받고 이 route는
 * 이미 상한이 걸린 스냅샷 하나만 받습니다.
 */
export const MAX_INTERVIEW_STREAM_BODY_BYTES = 64 * 1024;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;

const isNullableString = (value: unknown): boolean => value === null || typeof value === "string";

function isVerifiability(value: unknown): value is EvidenceVerifiability {
  if (!isRecord(value)) return false;
  return (
    (value.status === "verified" || value.status === "unverifiable") &&
    typeof value.aiSelected === "boolean" &&
    typeof value.detail === "string"
  );
}

function isSnapshotFile(value: unknown): value is EvidenceSnapshotFile {
  if (!isRecord(value)) return false;
  if (typeof value.path !== "string" || value.path.length === 0) return false;
  if (typeof value.status !== "string") return false;
  if (!isCount(value.additions) || !isCount(value.deletions) || !isCount(value.changes)) return false;
  if (!isNullableString(value.patch)) return false;
  if (typeof value.patchTruncated !== "boolean") return false;
  // 절단과 부재는 다른 상태이고 표시 문구도 다릅니다. 본문이 있으면 사유가 없어야 하고 없으면
  // 있어야 합니다. 둘이 어긋난 스냅샷을 받으면 프롬프트가 "본문 없음"과 본문을 함께 싣습니다.
  if (value.patch === null) {
    return value.patchOmittedReason === "budget_exhausted" || value.patchOmittedReason === "not_provided";
  }
  return value.patchOmittedReason === null;
}

function isSnapshotCommit(value: unknown, role: "representative" | "related"): value is EvidenceSnapshotCommit {
  if (!isRecord(value)) return false;
  if (typeof value.sha !== "string" || !SHA_PATTERN.test(value.sha)) return false;
  if (value.role !== role) return false;
  if (typeof value.indexed !== "boolean") return false;
  if (!isNullableString(value.title) || !isNullableString(value.message)) return false;
  if (!Array.isArray(value.pullRequests)) return false;
  const pullRequestsValid = value.pullRequests.every(
    (pullRequest) =>
      isRecord(pullRequest) &&
      Number.isInteger(pullRequest.number) &&
      typeof pullRequest.title === "string" &&
      typeof pullRequest.state === "string" &&
      typeof pullRequest.baseBranch === "string" &&
      typeof pullRequest.headBranch === "string"
  );
  if (!pullRequestsValid) return false;
  if (!Array.isArray(value.files) || !value.files.every(isSnapshotFile)) return false;
  return isVerifiability(value.verifiability);
}

function isStatement(value: unknown): boolean {
  return isRecord(value) && typeof value.text === "string" && isVerifiability(value.verifiability);
}

function isPaths(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.paths) &&
    value.paths.every((path) => typeof path === "string") &&
    isVerifiability(value.verifiability)
  );
}

function isPatchBudget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isCount(value.maxInputTokens) &&
    isCount(value.metadataTokens) &&
    isCount(value.maxPatchBytes) &&
    isCount(value.patchBytes) &&
    typeof value.truncatedByBudget === "boolean"
  );
}

/**
 * 근거 스냅샷의 구조를 검증합니다.
 *
 * 필드가 있는지만 보지 않고 값의 범위와 서로의 일관성까지 봅니다. 이 route는 스냅샷을 다시
 * 조립하지 않고 그대로 프롬프트에 싣기 때문에, 어긋난 값이 통과하면 그대로 모델에 들어가 근거가
 * 아닌 것을 근거처럼 만듭니다. `role`을 자리와 맞춰 보는 것과 patch 본문·사유의 배타성을 보는 것이
 * 그 때문입니다.
 */
export function isExperienceEvidenceSnapshot(value: unknown): value is ExperienceEvidenceSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.candidateSha !== "string" || !SHA_PATTERN.test(value.candidateSha)) return false;
  if (value.source !== "contribution_match" && value.source !== "automatic_recommendation") return false;
  if (value.origin !== "repository") return false;
  if (!isStatement(value.evidence)) return false;
  if (!isSnapshotCommit(value.representativeCommit, "representative")) return false;
  if (
    !Array.isArray(value.relatedCommits) ||
    !value.relatedCommits.every((commit) => isSnapshotCommit(commit, "related"))
  ) {
    return false;
  }
  if (!isPaths(value.citedFilePaths)) return false;
  if (
    !Array.isArray(value.unverifiableItems) ||
    !value.unverifiableItems.every((item) => typeof item === "string")
  ) {
    return false;
  }
  if (!isPatchBudget(value.patchBudget)) return false;
  // 대표 커밋은 후보 커밋이어야 합니다. 다르면 화면이 고른 경험과 질문의 근거가 어긋납니다.
  return value.candidateSha === (value.representativeCommit as EvidenceSnapshotCommit).sha;
}

export function isInterviewStreamRequestBody(value: unknown): value is InterviewStreamRequestBody {
  return isRecord(value) && isExperienceEvidenceSnapshot(value.snapshot);
}
