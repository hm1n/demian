import {
  AI_SELECTION_LABEL,
  EVIDENCE_VERIFIABILITY_NOTICE,
  VERIFIABILITY_LABEL,
} from "./evidence-verifiability";
import type { ExperienceEvidenceSnapshot } from "./types";
import styles from "./experience-interview-entry.module.css";

interface ExperienceInterviewEntryProps {
  snapshot: ExperienceEvidenceSnapshot;
  onBack: () => void;
}

const changedFileCount = (snapshot: ExperienceEvidenceSnapshot) =>
  snapshot.representativeCommit.files.length +
  snapshot.relatedCommits.reduce((total, commit) => total + commit.files.length, 0);

/**
 * 확정 이후의 임시 자리 화면입니다. **인터뷰 화면 본체가 아닙니다.**
 *
 * 이슈 #55의 범위는 인터뷰 대상 확정과 근거 스냅샷 생성까지이고, 질문 생성과 스트리밍 출력은
 * 다루지 않습니다. `실제 코드 기반 AI 질문 생성` 이슈가 이 컴포넌트 자리를 인터뷰 화면 본체로
 * 대체합니다. 그 시점에 여기의 근거 요약은 질문 화면의 근거 패널로 옮기거나 제거합니다.
 *
 * 다음 작업자에게: 이 화면을 완성된 인터뷰 화면으로 보고 위에 기능을 덧붙이지 말아 주세요.
 * 대체 대상입니다.
 */
export function ExperienceInterviewEntry({ snapshot, onBack }: ExperienceInterviewEntryProps) {
  const { representativeCommit, relatedCommits, citedFilePaths, patchBudget } = snapshot;
  const title = representativeCommit.title ?? `대표 커밋 ${snapshot.candidateSha.slice(0, 7)}`;

  return (
    <section className={styles.entry} aria-live="polite">
      <button className={styles.backButton} type="button" onClick={onBack}>
        ← 후보 목록으로
      </button>
      <p className={styles.eyebrow}>인터뷰 대상 확정</p>
      <h2>{title}</h2>
      <p>
        이 경험을 인터뷰 대상으로 확정했습니다. 아래 근거가 다음 단계의 질문 생성 입력으로
        넘어갑니다.
      </p>

      <p className={styles.placeholderNotice}>
        <strong>질문은 아직 생성되지 않습니다</strong>
        질문 생성과 실시간 응답은 다음 기능에서 붙습니다. 이 화면은 확정된 근거를 확인하는 임시
        자리입니다.
      </p>

      <ul className={styles.metrics}>
        <li>
          <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
          변경 파일 {changedFileCount(snapshot)}개
        </li>
        <li>
          <span className={styles.aiSelectionTag}>{AI_SELECTION_LABEL}</span>
          관련 커밋 {relatedCommits.length}개
        </li>
        <li>
          <span className={styles.aiSelectionTag}>{AI_SELECTION_LABEL}</span>
          인용 파일 {citedFilePaths.paths.length}개
        </li>
      </ul>

      <p className={styles.evidence}>{snapshot.evidence.text}</p>
      <p className={styles.evidenceNotice}>{EVIDENCE_VERIFIABILITY_NOTICE}</p>

      {patchBudget.truncatedByBudget ? (
        <p className={styles.warning}>
          근거 상한 {patchBudget.maxTotalChars.toLocaleString("ko-KR")}자에 맞춰 코드 변경 내역
          일부를 잘랐습니다. 실제로 실은 분량은 {patchBudget.usedChars.toLocaleString("ko-KR")}
          자입니다.
        </p>
      ) : null}
    </section>
  );
}
