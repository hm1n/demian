"use client";

import { useMemo } from "react";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";
import { InterviewEvidencePanel } from "./interview-evidence-panel";
import { createInterviewStreamFetch } from "./interview-request";
import { DEFAULT_INTERVIEW_STREAM_URL, InterviewStreamView } from "./interview-stream-view";
import styles from "./interview-screen.module.css";

export interface InterviewScreenProps {
  snapshot: ExperienceEvidenceSnapshot;
  onBack: () => void;
  /**
   * 질문 스트림 주소입니다. 개발과 검증에서는 `?scenario=slow`처럼 붙여 테스트 스트림의 시나리오를
   * 지정합니다. 시나리오 목록은 `test-stream.ts`에 있습니다.
   */
  streamUrl?: string;
  /** 테스트에서 스트림 응답을 대체하는 통로입니다. */
  fetchImpl?: typeof fetch;
}

/**
 * 인터뷰 화면 본체입니다. `ExperienceInterviewEntry` 임시 자리 화면을 대체합니다.
 *
 * 질문 영역은 이슈 #60이 실측으로 확정한 `InterviewStreamView`를 그대로 씁니다. 렌더링 방식,
 * 자동 스크롤, 오류 안내를 다시 정하지 않습니다. 이 화면이 더하는 것은 확정한 경험의 제목, 근거
 * 패널, 그리고 근거 스냅샷을 요청 본문으로 만들어 전송 계층에 넘기는 배선입니다.
 *
 * Loading과 Error를 새로 만들지 않았습니다. 첫 내용이 오기 전 "질문을 준비하고 있습니다" 안내와
 * 오류별 안내·다시 시도는 `InterviewStreamView`가 이미 담당합니다. 같은 상태를 두 곳에서 그리면
 * 어긋납니다. Empty는 없습니다. 후보 0개는 앞 단계 Empty가 처리하므로 이 화면에 도달하지
 * 않습니다.
 */
export function InterviewScreen({
  snapshot,
  onBack,
  streamUrl = DEFAULT_INTERVIEW_STREAM_URL,
  fetchImpl,
}: InterviewScreenProps) {
  const title =
    snapshot.representativeCommit.title ?? `대표 커밋 ${snapshot.candidateSha.slice(0, 7)}`;
  const streamFetch = useMemo(
    () => createInterviewStreamFetch(snapshot, { baseFetch: fetchImpl }),
    [snapshot, fetchImpl]
  );

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

      <InterviewStreamView url={streamUrl} fetchImpl={streamFetch} />
      <InterviewEvidencePanel snapshot={snapshot} />
    </section>
  );
}
