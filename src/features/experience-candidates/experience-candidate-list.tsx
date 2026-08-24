"use client";

import { useMemo, useState } from "react";
import type { StageBCandidateResult } from "./types";
import type { CandidateDataOutput } from "@/lib/github/types";
import styles from "./experience-candidate-list.module.css";

export type EvidenceOrigin = "repository";

interface ExperienceCandidateListProps {
  data: CandidateDataOutput;
  candidates: StageBCandidateResult;
  onSelectRepository: () => void;
}

export function ExperienceCandidateList({ data, candidates, onSelectRepository }: ExperienceCandidateListProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const commitsBySha = useMemo(
    () => new Map(data.includedCommits.map((commit) => [commit.sha, commit])),
    [data.includedCommits]
  );
  const selectedCandidate = candidates.candidates.find((candidate) => candidate.sha === selectedSha);

  if (selectedCandidate) {
    const commit = commitsBySha.get(selectedCandidate.sha);
    return (
      <section className={styles.state} aria-live="polite">
        <button className={styles.backButton} type="button" onClick={() => setSelectedSha(null)}>
          ← 후보 목록으로
        </button>
        <p className={styles.eyebrow}>경험 후보 상세</p>
        <h2>{commit?.title ?? selectedCandidate.sha.slice(0, 7)}</h2>
        <p>{selectedCandidate.evidence}</p>
        <p className={styles.detailNotice}>코드 변경 내역과 파일·관련 커밋 상세는 다음 단계에서 제공됩니다.</p>
      </section>
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
        {candidates.candidates.map((candidate) => {
          const commit = commitsBySha.get(candidate.sha);
          const evidenceOrigin: EvidenceOrigin = "repository";
          return (
            <li key={candidate.sha}>
              <button type="button" onClick={() => setSelectedSha(candidate.sha)}>
                <span className={styles.title}>{commit?.title ?? candidate.sha.slice(0, 7)}</span>
                <span className={styles.badges}>
                  <span>{candidate.source === "contribution_match" ? "기여 항목 일치" : "자동 추천"}</span>
                  <span>{evidenceOrigin === "repository" ? "Repository 근거" : evidenceOrigin}</span>
                </span>
                <span className={styles.evidence}>{candidate.evidence}</span>
                <span className={styles.metrics}>
                  <span>인용 파일 {candidate.citedFilePaths.length}개</span>
                  <span>관련 커밋 {candidate.relatedShas.length}개</span>
                  {commit?.pullRequests.map((pullRequest) => (
                    <span key={pullRequest.number}>PR #{pullRequest.number}</span>
                  ))}
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
      <button className={styles.secondaryButton} type="button" onClick={onSelectRepository}>다른 Repository 선택</button>
    </section>
  );
}
