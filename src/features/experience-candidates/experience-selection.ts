import { buildExperienceEvidenceSnapshot } from "./evidence-snapshot";
import type {
  EvidenceSnapshotFailureReason,
  ExperienceCandidateListItem,
  ExperienceEvidenceSnapshot,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput } from "@/lib/github/types";

/**
 * 인터뷰 대상 확정 상태입니다.
 *
 * `AnalysisState`에 넣지 않습니다. Repository 분석 진행 상태와 인터뷰 대상 확정은 서로 다른
 * 축이고, 얹으면 분석을 다시 실행할 때 확정 상태가 함께 초기화됩니다.
 *
 * Loading 상태를 따로 두지 않았습니다. 스냅샷 생성은 LLM을 호출하지 않는 동기 순수 함수여서
 * 관측할 진행 상태가 없습니다. 시간 같은 대리 지표로 가짜 전환을 만들지 않는 기존 결정을
 * 따릅니다(`repository-analysis.ts`의 `stage_b` 주석). 선택 흐름의 Loading은 분석 Loading이
 * 담당하고, 그 동안 후보 목록과 선택 액션은 렌더링되지 않습니다.
 *
 * Empty도 새로 만들지 않았습니다. 최종 후보 0개는 `no_final_candidates` Empty가 처리하므로
 * 후보 목록과 선택 액션에 도달하지 않습니다.
 */
export type ExperienceSelectionState =
  | { readonly status: "idle" }
  | { readonly status: "confirmed"; readonly snapshot: ExperienceEvidenceSnapshot }
  | { readonly status: "error"; readonly reason: EvidenceSnapshotFailureReason };

/** 근거 스냅샷을 만들지 못한 이유별 안내입니다. 무엇이 부족한지 알리고 목록 복귀로 유도합니다. */
export const EXPERIENCE_SELECTION_ERROR_COPY: Record<
  EvidenceSnapshotFailureReason,
  { readonly title: string; readonly message: string }
> = {
  representative_commit_not_indexed: {
    title: "이 경험으로는 인터뷰를 시작할 수 없습니다",
    message:
      "대표 커밋을 커밋 색인에서 찾지 못해 제목, 메시지, PR 정보, 변경 파일을 근거로 쓸 수 없습니다. 후보 목록으로 돌아가 다른 경험을 선택해 주세요.",
  },
  no_repository_evidence: {
    title: "이 경험으로는 인터뷰를 시작할 수 없습니다",
    message:
      "대표 커밋에 변경 파일이 없어 코드를 근거로 물어볼 것이 없습니다. 후보 목록으로 돌아가 다른 경험을 선택해 주세요.",
  },
};

/**
 * 상세 화면의 선택 액션이 호출합니다. 확정 시점에 근거 스냅샷을 만들고, 재선택하면 이전 확정
 * 상태를 그대로 교체합니다.
 */
export function confirmExperienceSelection(
  item: ExperienceCandidateListItem,
  data: CandidateDataOutput,
  candidates: StageBCandidateResult
): ExperienceSelectionState {
  const result = buildExperienceEvidenceSnapshot(item, data, candidates);
  return result.ok
    ? { status: "confirmed", snapshot: result.snapshot }
    : { status: "error", reason: result.reason };
}
