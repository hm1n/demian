"use client";

import { useMemo, useState } from "react";
import type { EvidenceOrigin, ExperienceCandidateListItem, StageBCandidateResult } from "./types";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";
import type { RepositoryRef } from "@/lib/github/types";
import { AI_SELECTION_LABEL, EVIDENCE_VERIFIABILITY_NOTICE, VERIFIABILITY_LABEL } from "./evidence-verifiability";
import { ExperienceCandidateDetail } from "./experience-candidate-detail";
import { InterviewScreen } from "@/features/interview/interview-screen";
import { confirmExperienceSelection, type ExperienceSelectionState } from "./experience-selection";
import { WORK_UNIT_EXCLUSION_COPY, type ExcludedCommit } from "./work-unit";
import {
  WORK_UNIT_SELECTION_EXCLUSION_COPY,
  type ExcludedWorkUnit,
} from "./work-unit-selection";
import { WORK_UNIT_SIGNAL_COPY } from "./work-unit-score";
import styles from "./experience-candidate-list.module.css";

/**
 * Stage A 선별에서 제외된 값입니다. `repository-analysis.ts`의 `StageASelectionState`와 구조가
 * 같습니다. 그 타입을 직접 가져오지 않는 이유는 `repository-analysis`가 이 기능을 소비하는
 * 상위 계층이기 때문입니다. 여기서 가져오면 역방향 의존이 생깁니다.
 */
export interface StageASelectionDisplay {
  readonly excludedCommits: readonly ExcludedCommit[];
  readonly excludedUnits: readonly ExcludedWorkUnit<ReadonlyCommitDetail>[];
  readonly thresholdScore: number;
  /** 점수 선별을 통과해 실제로 판단한 묶음 수입니다. 전체 대비 얼마인지 말하려면 필요합니다. */
  readonly selectedUnitCount: number;
  readonly unjudgedShas: readonly string[];
}

const EVIDENCE_ORIGIN_LABEL: Record<EvidenceOrigin, string> = {
  repository: "출처: Repository",
};

export function createExperienceCandidateListItems(
  data: CandidateDataOutput,
  candidates: StageBCandidateResult
): readonly ExperienceCandidateListItem[] {
  const commitsBySha = new Map(data.includedCommits.map((commit) => [commit.sha, commit]));
  return candidates.candidates.map((candidate) => ({
    candidate,
    commit: commitsBySha.get(candidate.sha) ?? null,
    origin: "repository",
    normalizedRelatedShas: [...new Set(candidate.relatedShas.filter((sha) => sha !== candidate.sha))],
    normalizedCitedFilePaths: [...new Set(candidate.citedFilePaths)],
  }));
}

interface ExperienceCandidateListProps {
  repository: RepositoryRef;
  data: CandidateDataOutput;
  candidates: StageBCandidateResult;
  /** 생략하면 제외 요약을 표시하지 않습니다. 실제 화면은 항상 값을 넘깁니다. */
  stageASelection?: StageASelectionDisplay;
  onSelectRepository: () => void;
}

export function ExperienceCandidateList({
  repository,
  data,
  candidates,
  stageASelection,
  onSelectRepository,
}: ExperienceCandidateListProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // 확정 상태는 `AnalysisState`가 아니라 후보 기능 안에 둡니다. 이유는 `experience-selection.ts`에 있습니다.
  const [selection, setSelection] = useState<ExperienceSelectionState>({ status: "idle" });
  const items = useMemo(() => createExperienceCandidateListItems(data, candidates), [data, candidates]);
  const selectedItem = items.find(({ candidate }) => candidate.sha === selectedSha);

  // 목록으로 돌아갈 때 확정 상태를 비웁니다. 다른 경험을 다시 확정하면 그 값이 이전 확정을 교체합니다.
  function backToList() {
    setSelectedSha(null);
    setSelection({ status: "idle" });
  }

  if (selection.status === "confirmed") {
    return <InterviewScreen snapshot={selection.snapshot} onBack={backToList} />;
  }

  if (selectedItem) {
    return (
      <ExperienceCandidateDetail
        repository={repository}
        data={data}
        candidates={candidates}
        item={selectedItem}
        onBack={backToList}
        onConfirm={() => setSelection(confirmExperienceSelection(selectedItem, data, candidates))}
        selectionError={selection.status === "error" ? selection.reason : undefined}
      />
    );
  }

  return (
    <section className={styles.state} aria-live="polite">
      <h2>경험 후보를 준비했습니다</h2>
      <p>{`실제 diff와 PR 소속을 근거로 경험 후보 ${candidates.candidates.length}개를 선정했습니다.`}</p>
      {candidates.insufficientCandidatesReason ? (
        <p className={styles.insufficientReason}>
          <strong>후보를 3개 채우지 않은 이유</strong>
          {candidates.insufficientCandidatesReason} 기준을 완화하거나 후보를 임의로 채우지 않습니다.
        </p>
      ) : null}
      <ul className={styles.candidateList}>
        {items.map(({ candidate, commit, origin, normalizedRelatedShas, normalizedCitedFilePaths }) => {
          const indexedTitle = commit?.title ?? `커밋 색인 실패 · ${candidate.sha.slice(0, 7)}`;
          return (
            <li key={candidate.sha}>
              <button
                type="button"
                aria-label={`${indexedTitle} · ${EVIDENCE_ORIGIN_LABEL[origin]}`}
                aria-describedby={`candidate-evidence-${candidate.sha}`}
                onClick={() => setSelectedSha(candidate.sha)}
              >
                <span className={styles.title}>{indexedTitle}</span>
                <span id={`candidate-evidence-${candidate.sha}`} className={styles.evidenceGroup}>
                  <span className={styles.badges}>
                    <span>{candidate.source === "contribution_match" ? "기여 항목 일치" : "자동 추천"}</span>
                    <span>{EVIDENCE_ORIGIN_LABEL[origin]}</span>
                  </span>
                  <span className={styles.evidence}>{candidate.evidence}</span>
                  <span className={styles.evidenceNotice}>{EVIDENCE_VERIFIABILITY_NOTICE}</span>
                  <span className={styles.metrics}>
                    <span className={styles.aiSelectionTag}>{AI_SELECTION_LABEL}</span>
                    <span>인용 파일 {normalizedCitedFilePaths.length}개</span>
                    <span>관련 커밋 {normalizedRelatedShas.length}개</span>
                    <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
                    {commit === null ? <span>커밋 색인 실패</span> : commit.pullRequests.length === 0 ? (
                      <span>PR 정보 없음</span>
                    ) : commit.pullRequests.map((pullRequest) => <span key={pullRequest.number}>PR #{pullRequest.number}</span>)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.summary}>
        <div><strong>{data.allCommits.length}</strong><span>전체 커밋</span></div>
        <div><strong>{data.includedCommits.length}</strong><span>상세 조회 커밋</span></div>
      </div>
      {stageASelection ? <StageAExclusions {...stageASelection} /> : null}
      <button className={styles.secondaryButton} type="button" onClick={onSelectRepository}>다른 Repository 선택</button>
    </section>
  );
}

/**
 * 이슈 #58이 못박은 원칙("어떤 커밋도 사용자 모르게 배제하지 않는다")을 지키려고 세 지점의
 * 배제를 보여줍니다. 후보 목록이 주인공이므로 이 구획은 목록과 요약 아래, 화면 맨 끝에 둡니다.
 *
 * 점수 컷에서 밀린 묶음(`below_score_threshold`)과 분량 상한에서 밀린 묶음(`over_byte_budget`)은
 * 같은 "제외"라도 사용자에게 다른 의미라 구획을 나눕니다. 점수는 우리 휴리스틱이지 Repository
 * 사실이 아니므로 `확인 가능` 태그를 씌우지 않고 별도로 표시합니다. PR 번호·제목은 GitHub 응답
 * 값이라 `확인 가능`을 씌웁니다.
 *
 * 후보 0개인 빈 상태(`repository-analysis-view.tsx`의 `EmptyState`)도 같은 원칙이 적용되는
 * 지점이라 이 컴포넌트를 그대로 재사용합니다. 같은 정보를 두 곳에서 다르게 그리면 어긋납니다
 * (이슈 #58 Codex 리뷰 P1-2).
 */
export function StageAExclusions({
  excludedCommits,
  excludedUnits,
  thresholdScore,
  selectedUnitCount,
  unjudgedShas,
}: StageASelectionDisplay) {
  const overInputBudget = excludedUnits
    .filter((item) => item.reason === "over_input_budget")
    .sort((a, b) => b.score - a.score);
  // 전체 묶음 수입니다. 판단한 것과 빠진 것을 합치면 저장소의 묶음 전부가 됩니다.
  const totalUnitCount = selectedUnitCount + excludedUnits.length;
  const overBudget = excludedUnits
    .filter((item) => item.reason === "over_byte_budget")
    .sort((a, b) => b.score - a.score);

  if (
    excludedCommits.length === 0 &&
    overInputBudget.length === 0 &&
    overBudget.length === 0 &&
    unjudgedShas.length === 0
  ) {
    return null;
  }

  return (
    <section className={styles.exclusions} aria-labelledby="stage-a-exclusions-heading">
      <h3 id="stage-a-exclusions-heading">1차 선별에서 제외된 항목</h3>

      {excludedCommits.length > 0 ? (
        <details className={styles.exclusionDetails}>
          <summary>
            <span>{`Pull Request에 속하지 않아 제외한 커밋 ${excludedCommits.length}건`}</span>
            <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
          </summary>
          <p className={styles.exclusionReason}>{WORK_UNIT_EXCLUSION_COPY.no_pull_request}</p>
          <ul className={styles.exclusionList}>
            {excludedCommits.map((commit) => (
              <li key={commit.sha}>
                <code>{commit.sha.slice(0, 7)}</code>
                <span>{commit.title}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {overInputBudget.length > 0 ? (
        <details className={styles.exclusionDetails}>
          {/*
            접힌 상태에서도 보이는 줄이라 여기에 전체 대비 몇 묶음을 판단했는지 적습니다. 제외
            개수만 적으면 그것이 전체의 얼마인지 알 수 없어, 저장소가 커서 잘렸다는 사실이 드러나지
            않습니다. 2026-09-02까지 이 줄은 "점수 N점 미만 M묶음을 제외했습니다"였고, 점수에 합격선이
            있다는 뜻으로 읽혔습니다. 실제 방아쇠는 입력 상한입니다.
          */}
          <summary>
            <span>{`저장소가 커서 전체 ${totalUnitCount}묶음 중 점수 상위 ${selectedUnitCount}묶음만 판단했습니다`}</span>
          </summary>
          <p className={styles.exclusionReason}>
            {WORK_UNIT_SELECTION_EXCLUSION_COPY.over_input_budget}
            {` 이번 판단의 점수 경계는 ${thresholdScore}점이었습니다.`}
            <span className={styles.heuristicNotice}> 점수는 자동 계산한 휴리스틱이고 Repository 사실이 아닙니다.</span>
          </p>
          <ul className={`${styles.exclusionList} ${styles.scrollableList}`}>
            {overInputBudget.map(({ unit, score, signals }) => (
              <li key={unit.pullRequestNumber}>
                <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
                <span>{`PR #${unit.pullRequestNumber}`}</span>
                <span>{unit.pullRequest.title}</span>
                <span className={styles.heuristicScore}>{`${score}점 · 휴리스틱`}</span>
                {signals.length > 0 ? (
                  <span className={styles.signalList}>
                    {signals.map((signal) => <span key={signal}>{WORK_UNIT_SIGNAL_COPY[signal]}</span>)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {overBudget.length > 0 ? (
        <details className={styles.exclusionDetails}>
          <summary>
            <span>{`한 번에 보낼 수 있는 분량을 넘어 ${overBudget.length}묶음을 제외했습니다`}</span>
          </summary>
          <p className={styles.exclusionReason}>{WORK_UNIT_SELECTION_EXCLUSION_COPY.over_byte_budget}</p>
          <ul className={`${styles.exclusionList} ${styles.scrollableList}`}>
            {overBudget.map(({ unit, score, signals }) => (
              <li key={unit.pullRequestNumber}>
                <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
                <span>{`PR #${unit.pullRequestNumber}`}</span>
                <span>{unit.pullRequest.title}</span>
                <span className={styles.heuristicScore}>{`${score}점 · 휴리스틱`}</span>
                {signals.length > 0 ? (
                  <span className={styles.signalList}>
                    {signals.map((signal) => <span key={signal}>{WORK_UNIT_SIGNAL_COPY[signal]}</span>)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {unjudgedShas.length > 0 ? (
        <details className={styles.exclusionDetails}>
          <summary>
            <span>{`모델이 판단하지 못한 묶음 ${unjudgedShas.length}건`}</span>
          </summary>
          <p className={styles.exclusionReason}>
            모델이 이 묶음들에 대해 판단을 내놓지 못했습니다. 제외한 것이 아니라 판단이 없는 상태입니다.
          </p>
          <ul className={styles.exclusionList}>
            {unjudgedShas.map((sha) => (
              <li key={sha}><code>{sha.slice(0, 7)}</code></li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
