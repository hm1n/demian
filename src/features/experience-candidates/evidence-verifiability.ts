import type { VerifiabilityStatus } from "./types";

/**
 * 이슈 #32·#47이 결정한 판별 규칙입니다. 판별용 LLM 호출이나 문장 파싱 휴리스틱을 쓰지 않고
 * 화면 항목 단위로 고정된 값만 사용합니다. 규칙 원문은 `llm-wiki/wiki/2026-08-24-확인가능불가-구분-계약.md`에 있습니다.
 */
export const VERIFIABILITY_LABEL: Record<VerifiabilityStatus, string> = {
  verified: "확인 가능",
  unverifiable: "확인 불가",
};

/** LLM이 작성한 evidence 문장 전체는 Repository 값이 아니라 해석이므로 확인 불가입니다. */
export const EVIDENCE_VERIFIABILITY_NOTICE = `${VERIFIABILITY_LABEL.unverifiable} · AI가 작성한 해석입니다`;

/** 화면에 이미 표시하는 항목 중 GitHub 응답 값이거나 서버 검증을 통과한 관계임을 알리는 문구입니다. */
export const REPOSITORY_VERIFIED_NOTICE = `${VERIFIABILITY_LABEL.verified} · 변경 파일, 코드 변경 내역, PR 정보는 Repository 응답 값이고, 관련 커밋은 대표 커밋과 같은 PR에 속한다는 관계까지 확인됩니다`;

/**
 * `relatedShas`와 `citedFilePaths`는 LLM이 고른 값입니다. `assertCandidateEvidence`는 관련 SHA가
 * 대표 커밋과 같은 PR에 속한다는 사실과 인용 경로가 후보 커밋의 실제 변경 파일 목록에 있다는 사실만
 * 증명하고, 그 항목이 근거로서 실제로 관련 있다는 판단은 증명하지 않습니다. 이 구분을 흐리지 않도록
 * `확인 가능` 태그를 이 값들에 씌우지 않습니다.
 */
export const AI_SELECTION_LABEL = "AI 선택";

export const RELATED_COMMITS_VERIFICATION_NOTICE = `${AI_SELECTION_LABEL} · 대표 커밋과 같은 PR에 속한다는 관계까지만 확인되고, 근거로서 관련 있다는 판단은 확인 불가입니다`;

/**
 * 확인 불가 고정 목록입니다. 인터뷰 단계에서 사용자가 스스로 설명해야 하는 지점을 미리 드러내려고
 * 상세 화면에 항상 표시합니다.
 */
export const REPOSITORY_UNVERIFIABLE_ITEMS: readonly string[] = [
  "성능 개선 폭",
  "사용자 영향",
  "다른 대안과의 비교",
  "협업·논의 배경",
  "커밋 메시지에 적힌 수치·비교·의도가 실제로 그러했는지",
];
