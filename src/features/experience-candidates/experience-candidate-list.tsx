"use client";

import { useMemo, useState } from "react";
import type { EvidenceOrigin, ExperienceCandidateListItem, StageBCandidateResult } from "./types";
import type { CandidateDataOutput } from "@/lib/github/types";
import type { RepositoryRef } from "@/lib/github/types";
import { ExperienceCandidateDetail } from "./experience-candidate-detail";
import styles from "./experience-candidate-list.module.css";

const EVIDENCE_ORIGIN_LABEL: Record<EvidenceOrigin, string> = {
  repository: "출처: Repository",
};

const EVIDENCE_SUMMARY_NOTICE = "AI 작성 요약 · 확인 가능·불가 구분은 후속 제공";

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
  onSelectRepository: () => void;
}

export function ExperienceCandidateList({ repository, data, candidates, onSelectRepository }: ExperienceCandidateListProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const items = useMemo(() => createExperienceCandidateListItems(data, candidates), [data, candidates]);
  const selectedItem = items.find(({ candidate }) => candidate.sha === selectedSha);

  if (selectedItem) {
    return (
      <ExperienceCandidateDetail
        repository={repository}
        data={data}
        candidates={candidates}
        item={selectedItem}
        onBack={() => setSelectedSha(null)}
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
              <button type="button" onClick={() => setSelectedSha(candidate.sha)}>
                <span className={styles.title}>{indexedTitle}</span>
                <span className={styles.badges}>
                  <span>{candidate.source === "contribution_match" ? "기여 항목 일치" : "자동 추천"}</span>
                  <span>{EVIDENCE_ORIGIN_LABEL[origin]}</span>
                </span>
                <span className={styles.evidence}>{candidate.evidence}</span>
                <span className={styles.evidenceNotice}>{EVIDENCE_SUMMARY_NOTICE}</span>
                <span className={styles.metrics}>
                  <span>인용 파일 {normalizedCitedFilePaths.length}개</span>
                  <span>관련 커밋 {normalizedRelatedShas.length}개</span>
                  {commit === null ? <span>커밋 색인 실패</span> : commit.pullRequests.length === 0 ? (
                    <span>PR 정보 없음</span>
                  ) : commit.pullRequests.map((pullRequest) => <span key={pullRequest.number}>PR #{pullRequest.number}</span>)}
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
