import {
  INTERVIEW_HISTORY_ITEM_MAX_BYTES,
  INTERVIEW_HISTORY_MAX_BYTES,
  INTERVIEW_HISTORY_MAX_ITEMS,
  interviewHistoryItemBytes,
  isWellFormedInterviewHistory,
  type InterviewHistoryMessage,
} from "./history";
import type {
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceVerifiability,
  ExperienceEvidenceSnapshot,
} from "@/features/experience-candidates/types";

/**
 * `POST /api/interview/stream`의 요청 본문입니다. 하위 이슈 B와 공유하는 계약이고 착수 전에
 * 고정했습니다. 서버는 커밋과 diff를 다시 조립하지 않고 스냅샷을 그대로 소비합니다.
 *
 * `history`가 없거나 비어 있으면 첫 질문 생성입니다. 있으면 마지막 답변에 이어지는 꼬리 질문
 * 생성입니다. 근거는 두 경우 모두 전량이 실립니다.
 */
export interface InterviewStreamRequestBody {
  readonly snapshot: ExperienceEvidenceSnapshot;
  readonly history: readonly InterviewHistoryMessage[];
}

/**
 * 근거 스냅샷 하나가 차지하는 본문 몫입니다.
 *
 * 근거 스냅샷은 만들 때 추정 5,250토큰으로 묶이고 실측 직렬화 크기는 10KB대였습니다. 64KB는 그
 * 위로 넉넉한 자리이면서, 본문을 다 읽기 전에 거절할 수 있는 크기입니다. Stage A의 4.5MB를 쓰지
 * 않는 이유는 입력의 성격이 다르기 때문입니다. Stage A는 저장소 전체 커밋 요약을 받고 이 route는
 * 이미 상한이 걸린 스냅샷 하나만 받습니다.
 */
const SNAPSHOT_BODY_BYTES = 64 * 1024;

/**
 * 요청 본문 상한입니다.
 *
 * 2026-09-03까지는 근거 스냅샷 하나만 받는 전제로 64KB였습니다. 꼬리 질문은 클라이언트가 대화
 * 전문을 매 턴 실어 보내므로 그 값이 먼저 깨집니다. 실측에서 1,500자 답변 기준 10턴 본문이 58KB
 * 근처였고 15턴에서 상한을 넘겼습니다
 * (`llm-wiki/raw/2026-09-03-꼬리질문-근거-재전송-비용-비교-session-log.md` 5절).
 *
 * **근거 몫을 손대지 않고 이력 몫만 더합니다.** 이렇게 두면 상한이 커지기만 하므로 지금 통과하는
 * 첫 질문 요청은 그대로 통과합니다. 이력 몫은 `INTERVIEW_MAX_TURNS`에서 유도되므로 지원할 턴 수를
 * 바꾸면 이 값이 따라옵니다.
 */
export const MAX_INTERVIEW_STREAM_BODY_BYTES = SNAPSHOT_BODY_BYTES + INTERVIEW_HISTORY_MAX_BYTES;

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

function isHistoryMessage(value: unknown): value is InterviewHistoryMessage {
  if (!isRecord(value)) return false;
  return (value.role === "question" || value.role === "answer") && typeof value.text === "string";
}

/**
 * 요청 본문 파싱 결과입니다.
 *
 * 실패를 하나로 묶지 않는 이유는 사용자가 할 수 있는 일이 다르기 때문입니다. 모양이 어긋난 요청은
 * 같은 입력으로 다시 보내도 풀리지 않고 사용자가 손댈 것도 없습니다. 이력이 큰 요청은 대화를 줄이면
 * 풀립니다. 두 갈래를 같은 분류로 보내면 "다시 시도" 안내 하나로 뭉개집니다.
 */
export type InterviewStreamRequestParseResult =
  | { readonly ok: true; readonly body: InterviewStreamRequestBody }
  | {
      readonly ok: false;
      readonly kind: "invalid_request" | "history_too_large";
      readonly message: string;
    };

/**
 * 요청 본문을 검증해 계약대로 만든 값으로 바꿉니다.
 *
 * `history`는 없어도 되고, 없으면 빈 배열로 채웁니다. 첫 질문 요청이 `history` 없이 오던 지금
 * 형태 그대로 통과해야 하기 때문입니다.
 *
 * 모양 검증과 크기 검증을 갈라 부릅니다. 모양이 어긋난 이력의 크기를 재는 것은 의미가 없으므로
 * 모양을 먼저 봅니다.
 */
export function parseInterviewStreamRequestBody(
  value: unknown
): InterviewStreamRequestParseResult {
  if (!isRecord(value) || !isExperienceEvidenceSnapshot(value.snapshot)) {
    return {
      ok: false,
      kind: "invalid_request",
      message: "근거 스냅샷 형식이 올바르지 않습니다.",
    };
  }

  const rawHistory = value.history ?? [];
  if (!Array.isArray(rawHistory) || !rawHistory.every(isHistoryMessage)) {
    return { ok: false, kind: "invalid_request", message: "대화 이력 형식이 올바르지 않습니다." };
  }
  const history: readonly InterviewHistoryMessage[] = rawHistory;
  if (!isWellFormedInterviewHistory(history)) {
    return {
      ok: false,
      kind: "invalid_request",
      message:
        "대화 이력은 질문으로 시작해 질문과 답변이 번갈아 나오고 답변으로 끝나야 하며, 빈 항목이 있을 수 없습니다.",
    };
  }

  if (history.length > INTERVIEW_HISTORY_MAX_ITEMS) {
    return {
      ok: false,
      kind: "history_too_large",
      message: `대화 이력은 ${INTERVIEW_HISTORY_MAX_ITEMS}개 이하여야 합니다.`,
    };
  }
  if (history.some((message) => interviewHistoryItemBytes(message) > INTERVIEW_HISTORY_ITEM_MAX_BYTES)) {
    return {
      ok: false,
      kind: "history_too_large",
      message: `질문과 답변은 하나에 ${INTERVIEW_HISTORY_ITEM_MAX_BYTES}바이트 이하여야 합니다.`,
    };
  }

  return { ok: true, body: { snapshot: value.snapshot, history } };
}
