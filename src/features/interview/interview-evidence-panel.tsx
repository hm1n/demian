import {
  AI_SELECTION_LABEL,
  EVIDENCE_VERIFIABILITY_NOTICE,
  RELATED_COMMITS_VERIFICATION_NOTICE,
  REPOSITORY_VERIFIED_NOTICE,
  VERIFIABILITY_LABEL,
} from "@/features/experience-candidates/evidence-verifiability";
import type {
  EvidenceCommitRole,
  EvidencePatchOmittedReason,
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  ExperienceEvidenceSnapshot,
} from "@/features/experience-candidates/types";
import styles from "./interview-evidence-panel.module.css";

/**
 * 확정 액션과 같은 방식으로 접근성 설명에 연결하는 안내들입니다. `aria-label`로 이름만 바꾸면
 * 안내가 스크린리더에서 사라집니다. 그것이 이슈 #47 PR #52 1차 리뷰의 P1이었습니다.
 */
export const INTERVIEW_EVIDENCE_NOTICE_ID = "interview-evidence-verifiability-notice";
export const INTERVIEW_VERIFIED_NOTICE_ID = "interview-repository-verified-notice";

const ROLE_LABEL: Record<EvidenceCommitRole, string> = {
  representative: "대표 커밋",
  related: "관련 커밋",
};

/**
 * patch 본문이 없는 이유를 사용자 문구로 옮깁니다. 예산 소진과 GitHub 미제공은 사용자에게 뜻이
 * 다릅니다. 앞은 우리가 상한 때문에 뺀 것이고 뒤는 애초에 받은 적이 없는 것입니다.
 */
const PATCH_OMITTED_COPY: Record<EvidencePatchOmittedReason, string> = {
  budget_exhausted: "근거 입력 상한이 소진되어 이 파일의 diff 본문을 싣지 않았습니다.",
  not_provided: "GitHub가 이 파일의 patch를 제공하지 않았습니다.",
};

/**
 * 온전하지 않은 patch가 있는지 봅니다. 파일 단위 `patchTruncated`·`patchOmittedReason`을 보고,
 * 스냅샷 전체의 `truncatedByBudget`과는 다른 자리를 봅니다. 하나만 보면 남은 diff만으로 전체
 * 변경을 확인한 것처럼 보입니다. 이슈 #46이 만든 표시를 회귀시키지 않기 위한 검사입니다.
 *
 * **어느 단계에서 잘렸는지는 알 수 없습니다.** `evidence-snapshot.ts`가 파일의 `patchTruncated`를
 * `source?.patchTruncated === true || cutByBudget`로 합쳐서 실어 오므로 Stage B 절단과 스냅샷
 * 예산 절단이 한 boolean에 들어옵니다. 그래서 이 검사로 만드는 안내에 단계를 지목하지 않습니다.
 * 출처를 가르려면 스냅샷 계약에 필드를 더해야 하고 그 범위는
 * `wiki/2026-08-25-스트리밍-후속-backlog.md`로 분리했습니다.
 */
export function hasIncompletePatch(commits: readonly EvidenceSnapshotCommit[]): boolean {
  return commits.some((commit) =>
    commit.files.some((file) => file.patchTruncated || file.patchOmittedReason !== null)
  );
}

const fileStats = (file: EvidenceSnapshotFile) =>
  `${file.status} · +${file.additions} / -${file.deletions}`;

interface InterviewEvidencePanelProps {
  snapshot: ExperienceEvidenceSnapshot;
}

/**
 * 질문의 근거가 된 커밋과 코드 변경 내역을 보여 줍니다.
 *
 * 질문 아래에 한 열로 둡니다. 질문을 읽는 것이 이 화면의 목적이라 근거가 질문 폭을 상시 줄이면
 * 안 되고, patch를 펼치면 높이가 늘어나는데 질문 로그는 자기 안에서 스크롤하기 때문에 두 열로
 * 두면 좁은 화면과 넓은 화면의 스크롤 동작이 갈립니다. 근거는 기본으로 접혀 있으므로 아래에
 * 두어도 질문을 읽는 데 방해가 되지 않습니다. 배치 근거는
 * `llm-wiki/wiki/2026-08-25-인터뷰-화면-근거패널-배치.md`에 있습니다.
 *
 * 화면에서 patch를 추가로 자르지 않습니다. 스냅샷에 실리는 patch 총량은 근거 입력 상한이 정하는
 * 몫(3,500토큰 × 3바이트 = 10,500바이트)을 넘지 못하므로 전부 펼쳐도 10KB 남짓입니다. 화면에서
 * 한 번 더 자르면 Stage B 절단·스냅샷 절단과 구분되지 않는 세 번째 절단이 생겨 절단 알림의 뜻이
 * 흐려집니다. 대신 파일마다 접어 두고 본문 높이만 제한합니다.
 */
export function InterviewEvidencePanel({ snapshot }: InterviewEvidencePanelProps) {
  const {
    representativeCommit,
    relatedCommits,
    citedFilePaths,
    patchBudget,
    evidence,
    unverifiableItems,
  } = snapshot;
  const commits = [representativeCommit, ...relatedCommits];
  const incompletePatch = hasIncompletePatch(commits);

  return (
    <section className={styles.panel} aria-labelledby="interview-evidence-heading">
      <h3 id="interview-evidence-heading">이 질문의 근거</h3>

      <p className={styles.evidence}>{evidence.text}</p>
      <p id={INTERVIEW_EVIDENCE_NOTICE_ID} className={styles.evidenceNotice}>
        {EVIDENCE_VERIFIABILITY_NOTICE}
      </p>

      {/*
        `확인 가능`은 대표 커밋의 변경 파일 개수에만 붙입니다. 관련 커밋과 인용 파일은 어떤
        SHA·경로를 넣을지 AI가 고른 값이라 개수 자체가 그 선택에 따라 달라집니다. PR #57 1차 리뷰
        P2가 이 경계를 지적했습니다.
      */}
      <ul className={styles.metrics}>
        <li>
          <span className={styles.verifiedTag}>{VERIFIABILITY_LABEL.verified}</span>
          대표 커밋 변경 파일 {representativeCommit.files.length}개
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

      <p id={INTERVIEW_VERIFIED_NOTICE_ID} className={styles.verifiedNotice}>
        {REPOSITORY_VERIFIED_NOTICE}
      </p>

      {/*
        두 안내는 보는 자리가 달라 하나가 있어도 나머지를 감추지 않습니다. 앞은 스냅샷 전체의
        `truncatedByBudget`이고 뒤는 파일 단위 `patchTruncated`·`patchOmittedReason`입니다.

        뒤 안내에 단계를 지목하지 않습니다. 파일의 `patchTruncated`는 `evidence-snapshot.ts`가
        Stage B 절단과 스냅샷 예산 절단을 OR로 합쳐 실어 오므로 화면이 출처를 가를 수 없습니다.
        지목하면 예산으로만 잘린 경우에 "앞 단계에서 잘렸다"는 거짓을 말하게 됩니다. PR #65
        재검증 P2가 이 지점이었고, 출처 필드 추가는
        `wiki/2026-08-25-스트리밍-후속-backlog.md`로 분리했습니다.
      */}
      {patchBudget.truncatedByBudget ? (
        <p className={styles.warning}>
          근거 입력 상한 추정 {patchBudget.maxInputTokens.toLocaleString("ko-KR")}토큰에 맞춰 코드
          변경 내역 일부를 잘랐습니다. patch에 실제로 실은 분량은{" "}
          {patchBudget.patchBytes.toLocaleString("ko-KR")}바이트입니다.
        </p>
      ) : null}
      {incompletePatch ? (
        <p className={styles.warning}>
          일부 코드 변경 내역이 절단되거나 미포함되었습니다. 남은 diff만으로 전체 변경을 확인한
          것으로 단정할 수 없습니다.
        </p>
      ) : null}

      {/*
        기본으로 접어 둡니다. 펼치면 커밋 메시지와 patch가 이어지므로 첫 질문을 읽는 동안 질문을
        화면 밖으로 밀어냅니다.
      */}
      <details className={styles.commits}>
        <summary aria-describedby={`${INTERVIEW_VERIFIED_NOTICE_ID} ${INTERVIEW_EVIDENCE_NOTICE_ID}`}>
          커밋과 코드 변경 내역 {commits.length}건 보기
        </summary>
        <div className={styles.commitList}>
          <EvidenceCommitCard commit={representativeCommit} />
          {relatedCommits.length === 0 ? (
            <p className={styles.emptyNotice}>관련 커밋이 없습니다.</p>
          ) : (
            <>
              <p className={styles.aiSelectionNotice}>{RELATED_COMMITS_VERIFICATION_NOTICE}</p>
              {relatedCommits.map((commit) => (
                <EvidenceCommitCard key={commit.sha} commit={commit} />
              ))}
            </>
          )}
        </div>
      </details>

      <section className={styles.section} aria-labelledby="interview-cited-files-heading">
        <h4 id="interview-cited-files-heading">인용 파일 {citedFilePaths.paths.length}개</h4>
        <p className={styles.aiSelectionNotice}>
          {AI_SELECTION_LABEL} · {citedFilePaths.verifiability.detail}
        </p>
        {citedFilePaths.paths.length === 0 ? (
          <p className={styles.emptyNotice}>AI가 인용한 파일이 없습니다.</p>
        ) : (
          <ul className={styles.pathList}>
            {citedFilePaths.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        )}
      </section>

      {unverifiableItems.length > 0 ? (
        <section className={styles.section} aria-labelledby="interview-unverifiable-heading">
          <h4 id="interview-unverifiable-heading">Repository로 확인할 수 없는 항목</h4>
          <p className={styles.unverifiableNotice}>
            아래 항목은 커밋과 diff로 확인할 수 없습니다. 인터뷰에서 사용자가 직접 설명해야 하는
            지점입니다.
          </p>
          <ul className={styles.unverifiableList}>
            {unverifiableItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function EvidenceCommitCard({ commit }: { commit: EvidenceSnapshotCommit }) {
  // 커밋 자체의 확인 수준은 스냅샷이 실어 옵니다. 화면이 다시 판단하지 않습니다. 관련 커밋은
  // `aiSelected`가 true라 `확인 가능` 태그를 씌우지 않습니다.
  const { status, aiSelected, detail } = commit.verifiability;

  return (
    <article className={styles.commit}>
      <h5 className={styles.commitHeading}>
        <span>{ROLE_LABEL[commit.role]}</span>
        <code>{commit.sha.slice(0, 7)}</code>
      </h5>
      <p className={styles.commitVerifiability}>
        <span className={aiSelected ? styles.aiSelectionTag : styles.verifiedTag}>
          {aiSelected ? AI_SELECTION_LABEL : VERIFIABILITY_LABEL[status]}
        </span>
        {detail}
      </p>

      {commit.indexed ? null : (
        <p className={styles.emptyNotice}>
          커밋 색인에서 찾지 못해 제목, 메시지, PR 정보를 확인할 수 없습니다.
        </p>
      )}
      {commit.title === null ? null : <p className={styles.commitTitle}>{commit.title}</p>}
      {commit.message === null ? null : (
        <pre className={styles.commitMessage}>{commit.message}</pre>
      )}

      {commit.pullRequests.length === 0 ? (
        <p className={styles.emptyNotice}>PR 정보 없음</p>
      ) : (
        <ul className={styles.prList}>
          {commit.pullRequests.map((pullRequest) => (
            <li key={pullRequest.number}>
              <span>
                PR #{pullRequest.number} · {pullRequest.title}
              </span>
              <small>
                {pullRequest.state} · {pullRequest.headBranch} → {pullRequest.baseBranch}
              </small>
            </li>
          ))}
        </ul>
      )}

      {commit.files.length === 0 ? (
        <p className={styles.emptyNotice}>변경 파일이 없습니다.</p>
      ) : (
        <ul className={styles.fileList}>
          {commit.files.map((file) => (
            <li key={file.path}>
              <details>
                <summary>
                  <span className={styles.filePath}>{file.path}</span>
                  <small>{fileStats(file)}</small>
                  {file.patchTruncated ? <strong>diff 절단</strong> : null}
                  {file.patchOmittedReason === null ? null : <strong>diff 미포함</strong>}
                </summary>
                {file.patch === null ? (
                  <p className={styles.omittedNotice}>
                    {file.patchOmittedReason === null
                      ? "diff 본문이 없습니다."
                      : PATCH_OMITTED_COPY[file.patchOmittedReason]}
                  </p>
                ) : (
                  <pre className={styles.patch}>
                    <code>{file.patch}</code>
                  </pre>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
