import type { CandidateDataOutput, RepositoryRef } from "@/lib/github/types";
import type {
  CandidateDiffFile,
  EvidenceSnapshotFailureReason,
  ExperienceCandidateListItem,
  StageBCandidateResult,
} from "./types";
import {
  EVIDENCE_VERIFIABILITY_NOTICE,
  RELATED_COMMITS_VERIFICATION_NOTICE,
  REPOSITORY_UNVERIFIABLE_ITEMS,
  REPOSITORY_VERIFIED_NOTICE,
} from "./evidence-verifiability";
import { EXPERIENCE_SELECTION_ERROR_COPY } from "./experience-selection";
import styles from "./experience-candidate-detail.module.css";

interface ExperienceCandidateDetailProps {
  repository: RepositoryRef;
  data: CandidateDataOutput;
  candidates: StageBCandidateResult;
  item: ExperienceCandidateListItem;
  onBack: () => void;
  /** 이 경험을 인터뷰 대상으로 확정합니다. */
  onConfirm: () => void;
  /** 근거 스냅샷을 만들지 못한 이유입니다. 성공했거나 아직 확정하지 않았으면 undefined입니다. */
  selectionError?: EvidenceSnapshotFailureReason;
}

// 확정 액션의 접근성 설명으로 연결합니다. 액션 접근성 이름은 버튼 문구로 짧게 두고, 확인 가능·불가
// 안내는 `aria-describedby`로 계속 노출합니다. `aria-label`로 이름만 주면 안내가 스크린리더에서
// 사라지고, 그것이 이슈 #47 PR #52 1차 리뷰의 P1이었습니다.
const EVIDENCE_NOTICE_ID = "candidate-evidence-verifiability-notice";
const VERIFIED_NOTICE_ID = "candidate-repository-verified-notice";

const commitUrl = ({ owner, repo }: RepositoryRef, sha: string) =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${sha}`;

const fileStats = (file: Pick<CandidateDiffFile, "status" | "additions" | "deletions">) =>
  `${file.status} · +${file.additions} / -${file.deletions}`;

export function ExperienceCandidateDetail({
  repository,
  data,
  candidates,
  item,
  onBack,
  onConfirm,
  selectionError,
}: ExperienceCandidateDetailProps) {
  const { candidate, commit, normalizedRelatedShas } = item;
  const commitsBySha = new Map(data.includedCommits.map((entry) => [entry.sha, entry]));
  const representativeDiff = candidates.diffs.find((diff) => diff.sha === candidate.sha);
  const diffsByPath = new Map(representativeDiff?.files.map((file) => [file.path, file]) ?? []);
  const hasPatch = representativeDiff?.files.some((file) => file.patch !== undefined) ?? false;
  const candidateShas = new Set([candidate.sha, ...normalizedRelatedShas]);
  const hasTruncatedPatch = candidates.diffs.some(
    (diff) => candidateShas.has(diff.sha) && diff.files.some((file) => file.patchTruncated === true)
  );
  const title = commit?.title ?? `커밋 색인 실패 · ${candidate.sha.slice(0, 7)}`;

  return (
    <section className={styles.detail} aria-live="polite">
      <button className={styles.backButton} type="button" onClick={onBack}>← 후보 목록으로</button>
      <p className={styles.eyebrow}>경험 후보 상세</p>
      <h2>{title}</h2>
      {commit === null ? <p className={styles.notice}>대표 커밋을 커밋 색인에서 찾지 못했습니다.</p> : null}
      <a className={styles.commitLink} href={commitUrl(repository, candidate.sha)} target="_blank" rel="noreferrer">
        대표 커밋 {candidate.sha.slice(0, 7)}
      </a>
      <p>{candidate.evidence}</p>
      <p id={EVIDENCE_NOTICE_ID} className={styles.evidenceNotice}>{EVIDENCE_VERIFIABILITY_NOTICE}</p>

      <section className={styles.section} aria-labelledby="unverifiable-heading">
        <h3 id="unverifiable-heading">Repository로 확인할 수 없는 항목</h3>
        <ul className={styles.unverifiableList}>
          {REPOSITORY_UNVERIFIABLE_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <p id={VERIFIED_NOTICE_ID} className={styles.verifiedNotice}>{REPOSITORY_VERIFIED_NOTICE}</p>

      <section className={styles.section} aria-labelledby="changed-files-heading">
        <h3 id="changed-files-heading">변경 파일 {commit?.files.length ?? 0}개</h3>
        {commit?.files.length ? (
          <ul className={styles.fileList}>
            {commit.files.map((file) => {
              const diff = diffsByPath.get(file.path);
              return (
                <li key={file.path}>
                  <span>{file.path}</span>
                  <small>{fileStats(file)}</small>
                  {diff?.patchTruncated ? <strong>diff 절단</strong> : diff?.patch === undefined ? <strong>diff 미포함</strong> : null}
                </li>
              );
            })}
          </ul>
        ) : <p>변경 파일이 없습니다.</p>}
      </section>

      <section className={styles.section} aria-labelledby="diff-heading">
        <h3 id="diff-heading">코드 변경 내역</h3>
        {hasTruncatedPatch ? <p className={styles.warning}>일부 diff가 예산에 맞게 절단되거나 미포함되었습니다.</p> : null}
        {!hasPatch ? <p className={styles.empty}><strong>표시할 코드 변경 내역이 없습니다</strong> patch 예산 절단 또는 patch 미제공 파일 때문일 수 있습니다.</p> : null}
        {representativeDiff?.files.some((file) => file.patch !== undefined || file.patchTruncated) ? (
          <div className={styles.diffList}>
            {representativeDiff.files.filter((file) => file.patch !== undefined || file.patchTruncated).map((file) => (
              <details key={file.path}>
                <summary>
                  <span>{file.path}</span>
                  <small>{fileStats(file)}</small>
                  {file.patchTruncated ? <strong>diff 절단</strong> : null}
                </summary>
                {file.patch === undefined
                  ? <p className={styles.truncatedNotice}>patch 예산이 소진되어 diff 본문이 미포함되었습니다.</p>
                  : <pre><code>{file.patch}</code></pre>}
              </details>
            ))}
          </div>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="related-commits-heading">
        <h3 id="related-commits-heading">관련 커밋 {normalizedRelatedShas.length}개</h3>
        {normalizedRelatedShas.length === 0 ? <p>관련 커밋이 없습니다.</p> : (
          <>
            <p className={styles.aiSelectionNotice}>{RELATED_COMMITS_VERIFICATION_NOTICE}</p>
            <ul className={styles.relatedList}>
            {normalizedRelatedShas.map((sha) => {
              const related = commitsBySha.get(sha);
              return (
                <li key={sha}>
                  <a href={commitUrl(repository, sha)} target="_blank" rel="noreferrer">{related?.title ?? `커밋 색인 실패 · ${sha.slice(0, 7)}`}</a>
                  <span>{sha.slice(0, 7)}</span>
                  {related?.pullRequests.map((pullRequest) => <span key={pullRequest.number}>PR #{pullRequest.number}</span>)}
                </li>
              );
            })}
            </ul>
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="pull-requests-heading">
        <h3 id="pull-requests-heading">PR 정보</h3>
        {commit === null ? <p>커밋 색인 실패</p> : commit.pullRequests.length === 0 ? <p>PR 정보 없음</p> : (
          <ul className={styles.prList}>
            {commit.pullRequests.map((pullRequest) => (
              <li key={pullRequest.number}>
                <a href={pullRequest.url} target="_blank" rel="noreferrer">PR #{pullRequest.number} · {pullRequest.title}</a>
                <span>{pullRequest.state} · {pullRequest.headBranch} → {pullRequest.baseBranch}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="selection-heading">
        <h3 id="selection-heading">인터뷰 시작</h3>
        {selectionError ? (
          <div className={styles.selectionError} role="alert" data-selection-error={selectionError}>
            <strong>{EXPERIENCE_SELECTION_ERROR_COPY[selectionError].title}</strong>
            <span>{EXPERIENCE_SELECTION_ERROR_COPY[selectionError].message}</span>
          </div>
        ) : (
          <p>확인한 근거로 이 경험을 인터뷰 대상으로 확정합니다. 목록으로 돌아가 다른 경험을 다시 선택할 수 있습니다.</p>
        )}
        <button
          className={styles.primaryButton}
          type="button"
          aria-describedby={`${EVIDENCE_NOTICE_ID} ${VERIFIED_NOTICE_ID}`}
          onClick={onConfirm}
        >
          이 경험으로 인터뷰 시작
        </button>
      </section>
    </section>
  );
}
