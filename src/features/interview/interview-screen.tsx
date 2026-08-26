"use client";

import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";
import { InterviewEvidencePanel } from "./interview-evidence-panel";
import { InterviewStreamView } from "./interview-stream-view";
import styles from "./interview-screen.module.css";

export interface InterviewScreenProps {
  snapshot: ExperienceEvidenceSnapshot;
  onBack: () => void;
  /** 테스트에서 스트림 응답을 대체하는 통로입니다. */
  fetchImpl?: typeof fetch;
}

/**
 * 인터뷰 화면 본체입니다. `ExperienceInterviewEntry` 임시 자리 화면을 대체합니다.
 *
 * 질문 영역은 이슈 #60이 실측으로 확정한 `InterviewStreamView`를 그대로 씁니다. 렌더링 방식,
 * 자동 스크롤, 오류 안내를 다시 정하지 않습니다. 이 화면이 더하는 것은 확정한 경험의 제목과 근거
 * 패널, 그리고 근거 스냅샷을 질문 생성 경로에 넘기는 배선입니다.
 *
 * **`snapshot`을 반드시 넘깁니다.** 넘기지 않으면 `InterviewStreamView`가 테스트용 스트림을
 * `GET`으로 받고, 그 스트림의 고정 질문이 사용자가 고른 경험의 질문인 것처럼 근거 패널과 나란히
 * 표시됩니다. 어떤 저장소를 골라도 같은 질문이 나오므로 AI가 실제 Repository 근거로 질문한다는
 * 원칙이 깨집니다. PR #65 리뷰 P1이 이 지점이었습니다. 회귀는 이 화면의 테스트가 요청 본문을
 * 직접 확인해 막습니다.
 *
 * `snapshot`을 넘기면 그 스트림은 `resumeMode: "restart"`가 됩니다. 끊긴 지점부터 이어받지 않고
 * 다시 시도가 처음부터 새로 생성하며, 안내 문구도 그에 맞게 갈라집니다. 이 결정은 이슈 #63의
 * 범위이고 화면이 따로 지정하지 않습니다.
 *
 * Loading과 Error를 새로 만들지 않았습니다. 첫 내용이 오기 전 "질문을 준비하고 있습니다" 안내와
 * 오류별 안내·다시 시도는 `InterviewStreamView`가 이미 담당합니다. 같은 상태를 두 곳에서 그리면
 * 어긋납니다. Empty는 없습니다. 후보 0개는 앞 단계 Empty가 처리하므로 이 화면에 도달하지
 * 않습니다.
 */
export function InterviewScreen({ snapshot, onBack, fetchImpl }: InterviewScreenProps) {
  const title =
    snapshot.representativeCommit.title ?? `대표 커밋 ${snapshot.candidateSha.slice(0, 7)}`;

  return (
    // 이 자리에 `aria-live`를 두지 않습니다. 안쪽 질문 텍스트가 프레임마다 자라나므로 스크린리더가
    // 자라나는 질문 전체를 반복해서 읽습니다. 낭독 대상은 `InterviewStreamView`의 상태 문단과 새
    // 메시지 안내입니다. PR #61 리뷰가 정정한 결정입니다.
    <section className={styles.screen}>
      <button className={styles.backButton} type="button" onClick={onBack}>
        ← 후보 목록으로
      </button>
      <p className={styles.eyebrow}>AI 인터뷰</p>
      <h2>{title}</h2>
      <p>
        이 경험의 커밋과 코드 변경 내역을 근거로 질문을 만듭니다. 질문 아래에서 근거가 된 커밋과
        diff를 펼쳐 확인할 수 있습니다.
      </p>

      <InterviewStreamView snapshot={snapshot} fetchImpl={fetchImpl} />
      <InterviewEvidencePanel snapshot={snapshot} />
    </section>
  );
}
