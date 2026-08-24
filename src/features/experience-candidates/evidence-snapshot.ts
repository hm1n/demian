import { REPOSITORY_UNVERIFIABLE_ITEMS } from "./evidence-verifiability";
import type {
  EvidenceCommitRole,
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceSnapshotResult,
  EvidenceVerifiability,
  ExperienceCandidateListItem,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput } from "@/lib/github/types";

/**
 * 근거로 실을 patch 본문의 총 문자 상한입니다.
 *
 * Groq 무료 등급의 분당 토큰 한도는 8,000이고 초과를 429가 아니라 413 `rate_limit_exceeded`로
 * 반환합니다(`llm-wiki/wiki/2026-08-24-실데이터-검증-배치-상한-확정.md`). 꼬리 질문이 같은 근거를
 * 매 턴 다시 싣기 때문에 한 번의 요청이 한도를 다 쓰면 다음 턴이 곧바로 막힙니다.
 *
 * 그래서 patch에 3,000토큰만 배정하고, 레포가 이미 쓰는 4문자/토큰 추정으로 12,000자를 상한으로
 * 둡니다. 남는 한도는 커밋 메타데이터와 시스템 프롬프트, 응답 토큰이 씁니다. 상한을 소비자마다
 * 정하면 같은 413이 질문 생성과 꼬리 질문 두 곳에서 재발하므로 여기 한 곳에 둡니다.
 *
 * 확인 필요: 실제 토큰 수 측정은 질문 생성 이슈에서 확정합니다. 지금 값은 문자 수 추정입니다.
 */
export const EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS = 12_000;

const EVIDENCE_STATEMENT_VERIFIABILITY: EvidenceVerifiability = {
  status: "unverifiable",
  aiSelected: true,
  detail: "AI가 작성한 해석 문장입니다. Repository 값이 아니므로 사실로 다루지 않습니다.",
};

const REPRESENTATIVE_COMMIT_VERIFIABILITY: EvidenceVerifiability = {
  status: "verified",
  aiSelected: false,
  detail:
    "커밋 SHA, 제목, 메시지, 변경 파일, patch 본문, PR 정보는 GitHub 응답 값입니다. 다만 메시지에 적힌 수치·비교·의도는 그렇게 적혀 있다는 사실까지만 확인됩니다.",
};

const RELATED_COMMIT_VERIFIABILITY: EvidenceVerifiability = {
  status: "verified",
  aiSelected: true,
  detail:
    "대표 커밋과 같은 PR에 속한다는 관계까지만 확인됩니다. 근거로서 관련 있다는 판단은 확인 불가입니다.",
};

const CITED_FILE_PATHS_VERIFIABILITY: EvidenceVerifiability = {
  status: "verified",
  aiSelected: true,
  detail:
    "후보 커밋의 실제 변경 파일 목록에 있는 경로임까지만 확인됩니다. 근거로서 관련 있다는 판단은 확인 불가입니다.",
};

/** 변경 파일 통계는 커밋 상세와 diff 양쪽에서 같은 모양으로 오므로 공통 부분만 받습니다. */
type EvidenceFileStats = Pick<
  EvidenceSnapshotFile,
  "path" | "status" | "additions" | "deletions" | "changes"
>;

const NOT_INDEXED_COMMIT_DETAIL =
  "커밋 색인에서 찾지 못해 제목, 메시지, PR 정보를 확인할 수 없습니다.";

/**
 * 확인 가능으로 표시할 범위는 서버 `assertCandidateEvidence`가 실제로 증명한 것까지입니다. 색인에서
 * 찾지 못한 커밋은 조회 실패 상태이고 Repository 사실이 아니므로 확인 가능으로 표시하지 않습니다.
 */
function commitVerifiability(role: EvidenceCommitRole, indexed: boolean): EvidenceVerifiability {
  if (!indexed) {
    return { status: "unverifiable", aiSelected: role === "related", detail: NOT_INDEXED_COMMIT_DETAIL };
  }
  return role === "representative" ? REPRESENTATIVE_COMMIT_VERIFIABILITY : RELATED_COMMIT_VERIFIABILITY;
}

/**
 * 선택한 경험 1개의 Repository 근거를 인계용 스냅샷으로 고정합니다. LLM을 호출하지 않는 순수
 * 함수이고, 근거 출처가 두 곳으로 갈리는 분기를 여기서 한 번만 조립합니다. 커밋 제목·메시지·PR
 * 정보·변경 파일 목록은 `data.includedCommits`에서 오고 patch 본문은 `candidates.diffs`에만
 * 있습니다(`/api/github/commit-details`가 `withoutPatch`로 벗깁니다).
 *
 * patch 예산은 커밋 간 균등 배분입니다. 선착순으로 나눠주면 뒤 커밋이 patch를 한 글자도 받지
 * 못하는 결함이 Stage B에서 이미 확인되었습니다(`buildStageBPayload` 주석). 커밋 몫을 다 쓰지
 * 않으면 잔액을 뒤 커밋으로 이월하므로 어떤 커밋도 자기 몫보다 적게 받지 않습니다. 커밋 안에서
 * 파일 단위 배분은 Stage B와 같은 선착순이고, 소진은 그 커밋의 몫 안에서만 일어납니다.
 */
export function buildExperienceEvidenceSnapshot(
  item: ExperienceCandidateListItem,
  data: CandidateDataOutput,
  candidates: StageBCandidateResult,
  maxTotalPatchChars: number = EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS
): EvidenceSnapshotResult {
  const { candidate, commit, origin, normalizedRelatedShas, normalizedCitedFilePaths } = item;
  // 대표 커밋을 색인에서 찾지 못하면 제목·메시지·PR·변경 파일이 모두 없어 인터뷰할 근거가 없습니다.
  // 목록 화면이 표시하는 `커밋 색인 실패`와 같은 상태이고, 확정 흐름에서는 Error로 알립니다.
  if (commit === null) return { ok: false, reason: "representative_commit_not_indexed" };
  if (commit.files.length === 0) return { ok: false, reason: "no_repository_evidence" };

  const commitsBySha = new Map(data.includedCommits.map((entry) => [entry.sha, entry]));
  const diffsBySha = new Map(candidates.diffs.map((diff) => [diff.sha, diff]));
  const shas = [candidate.sha, ...normalizedRelatedShas];
  const share = Math.floor(maxTotalPatchChars / shas.length);

  let carried = 0;
  let usedChars = 0;
  let truncatedByBudget = false;
  const snapshotCommits: EvidenceSnapshotCommit[] = [];

  for (const [index, sha] of shas.entries()) {
    const role: EvidenceCommitRole = index === 0 ? "representative" : "related";
    const detail = role === "representative" ? commit : commitsBySha.get(sha) ?? null;
    const diff = diffsBySha.get(sha);
    const diffByPath = new Map((diff?.files ?? []).map((file) => [file.path, file]));
    // 색인에 없는 관련 커밋도 diff에는 남아 있을 수 있으므로 변경 파일 목록을 잃지 않습니다.
    const baseFiles: readonly EvidenceFileStats[] = detail?.files.length
      ? detail.files
      : diff?.files ?? [];
    let available = share + carried;

    const files: EvidenceSnapshotFile[] = baseFiles.map((file) => {
      const source = diffByPath.get(file.path);
      const sourcePatch = source?.patch;
      const patch = sourcePatch === undefined ? "" : sourcePatch.slice(0, available);
      available -= patch.length;
      usedChars += patch.length;
      const cutByBudget = sourcePatch !== undefined && patch.length < sourcePatch.length;
      if (cutByBudget) truncatedByBudget = true;
      // 절단을 부재보다 먼저 판정합니다. Stage B에서 예산이 소진되면 `patchTruncated: true`이면서
      // patch가 없는 조합이 실제로 나오고, 이 조합을 일반 미포함으로 표시한 것이 이슈 #46의
      // 재검증 P2였습니다.
      const patchTruncated = source?.patchTruncated === true || cutByBudget;
      return {
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: patch.length > 0 ? patch : null,
        patchTruncated,
        patchOmittedReason:
          patch.length > 0 ? null : patchTruncated ? "budget_exhausted" : "not_provided",
      };
    });

    carried = available;
    snapshotCommits.push({
      sha,
      role,
      indexed: detail !== null,
      title: detail?.title ?? null,
      message: detail?.message ?? null,
      pullRequests: (detail?.pullRequests ?? []).map(
        ({ number, title, state, baseBranch, headBranch }) => ({
          number,
          title,
          state,
          baseBranch,
          headBranch,
        })
      ),
      files,
      verifiability: commitVerifiability(role, detail !== null),
    });
  }

  const [representativeCommit, ...relatedCommits] = snapshotCommits;
  return {
    ok: true,
    snapshot: {
      candidateSha: candidate.sha,
      source: candidate.source,
      origin,
      evidence: { text: candidate.evidence, verifiability: EVIDENCE_STATEMENT_VERIFIABILITY },
      representativeCommit,
      relatedCommits,
      citedFilePaths: {
        paths: normalizedCitedFilePaths,
        verifiability: CITED_FILE_PATHS_VERIFIABILITY,
      },
      unverifiableItems: REPOSITORY_UNVERIFIABLE_ITEMS,
      patchBudget: { maxTotalChars: maxTotalPatchChars, usedChars, truncatedByBudget },
    },
  };
}
