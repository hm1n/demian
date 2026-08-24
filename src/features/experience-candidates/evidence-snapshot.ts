import { REPOSITORY_UNVERIFIABLE_ITEMS } from "./evidence-verifiability";
import type {
  CandidateDiffFile,
  EvidenceCommitRole,
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceSnapshotResult,
  EvidenceVerifiability,
  ExperienceCandidateListItem,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";

/**
 * 근거 인계 입력 전체의 추정 토큰 상한입니다. patch만이 아니라 커밋 메시지, 변경 파일 목록,
 * PR 정보까지 포함한 직렬화 결과를 이 값으로 묶습니다.
 *
 * Groq 무료 등급의 분당 토큰 한도는 8,000이고 초과를 429가 아니라 413 `rate_limit_exceeded`로
 * 반환합니다(`llm-wiki/wiki/2026-08-24-실데이터-검증-배치-상한-확정.md`). 꼬리 질문이 같은 근거를
 * 매 턴 다시 싣기 때문에 한 번의 요청이 한도를 다 쓰면 다음 턴이 곧바로 막힙니다. 시스템 프롬프트와
 * 사용자 답변, 응답 토큰이 쓸 몫을 남기려고 근거 입력에는 3,500토큰만 배정합니다.
 *
 * 확인 필요: 이 값은 실제 토크나이저 측정이 아니라 바이트 기반 추정입니다. provider를 확정한 뒤
 * 질문 생성 이슈에서 실제 요청 토큰을 재서 이 상한과 추정식을 함께 교정해야 합니다.
 */
export const EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS = 3_500;

/**
 * 토큰 추정에 쓰는 UTF-8 바이트 대 토큰 비율입니다.
 *
 * 문자 수로 상한을 걸면 비ASCII 근거에서 한도를 지키지 못합니다. 한국어 커밋 메시지나 이모지는
 * 문자 하나가 3~4바이트이고 토큰도 문자당 1개에 가까워, 같은 문자 수라도 실제 토큰이 몇 배로
 * 늘어납니다. 반대로 ASCII 코드 diff는 4바이트당 1토큰에 가깝기 때문에 3바이트당 1토큰은
 * 과대 추정이고, 상한을 넘지 않는 쪽으로 틀립니다.
 */
export const EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN = 3;

const utf8ByteLength = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x1_0000 ? 3 : 4;

/** 직렬화한 근거의 추정 토큰입니다. JSON 이스케이프가 더하는 분량은 추정의 여유로 흡수합니다. */
export function estimateEvidenceTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(new TextEncoder().encode(text).byteLength / EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN);
}

/**
 * UTF-8 바이트 상한을 넘지 않는 가장 긴 앞부분을 남깁니다.
 *
 * 코드 포인트 경계에서만 자릅니다. UTF-16 코드 단위로 자르면 이모지 같은 astral 문자가 경계에
 * 걸릴 때 홀로 남은 서로게이트가 생기고, 직렬화 결과에 실제 Repository 문자가 아닌 값이 나갑니다.
 */
export function sliceEvidencePatchByUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8ByteLength(character.codePointAt(0)!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return end === text.length ? text : text.slice(0, end);
}

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

/** 변경 파일 통계는 커밋 상세와 diff 양쪽에서 같은 모양으로 오므로 공통 부분만 받습니다. */
type EvidenceFileStats = Pick<
  EvidenceSnapshotFile,
  "path" | "status" | "additions" | "deletions" | "changes"
>;

interface CommitInput {
  readonly sha: string;
  readonly role: EvidenceCommitRole;
  readonly detail: ReadonlyCommitDetail | null;
  readonly diffByPath: ReadonlyMap<string, CandidateDiffFile>;
  readonly baseFiles: readonly EvidenceFileStats[];
}

interface AssembledCommits {
  readonly commits: readonly EvidenceSnapshotCommit[];
  readonly patchBytes: number;
  readonly truncatedByBudget: boolean;
}

/**
 * patch 예산을 커밋 간 균등 배분해 스냅샷 커밋 목록을 만듭니다.
 *
 * 선착순으로 나눠주면 뒤 커밋이 patch를 한 글자도 받지 못하는 결함이 Stage B에서 이미
 * 확인되었습니다(`buildStageBPayload` 주석). 커밋 몫을 다 쓰지 않으면 잔액을 뒤 커밋으로
 * 이월하므로 어떤 커밋도 자기 몫보다 적게 받지 않습니다. 커밋 안에서 파일 단위 배분은 Stage B와
 * 같은 선착순이고, 소진은 그 커밋의 몫 안에서만 일어납니다.
 *
 * `maxPatchBytes`가 0이면 patch가 전혀 없는 스냅샷이 나옵니다. 나머지 근거의 크기를 먼저 재는 데
 * 같은 함수를 그대로 씁니다.
 */
function assembleCommits(inputs: readonly CommitInput[], maxPatchBytes: number): AssembledCommits {
  const share = inputs.length === 0 ? 0 : Math.floor(maxPatchBytes / inputs.length);
  let carried = 0;
  let patchBytes = 0;
  let truncatedByBudget = false;

  const commits = inputs.map(({ sha, role, detail, diffByPath, baseFiles }) => {
    let available = share + carried;
    const files: EvidenceSnapshotFile[] = baseFiles.map((file) => {
      const source = diffByPath.get(file.path);
      const sourcePatch = source?.patch;
      const patch =
        sourcePatch === undefined ? "" : sliceEvidencePatchByUtf8Bytes(sourcePatch, available);
      const usedBytes = new TextEncoder().encode(patch).byteLength;
      available -= usedBytes;
      patchBytes += usedBytes;
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
          patch.length > 0 ? null : patchTruncated ? ("budget_exhausted" as const) : ("not_provided" as const),
      };
    });

    carried = available;
    return {
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
    };
  });

  return { commits, patchBytes, truncatedByBudget };
}

/**
 * 선택한 경험 1개의 Repository 근거를 인계용 스냅샷으로 고정합니다. LLM을 호출하지 않는 순수
 * 함수이고, 근거 출처가 두 곳으로 갈리는 분기를 여기서 한 번만 조립합니다. 커밋 제목·메시지·PR
 * 정보·변경 파일 목록은 `data.includedCommits`에서 오고 patch 본문은 `candidates.diffs`에만
 * 있습니다(`/api/github/commit-details`가 `withoutPatch`로 벗깁니다).
 *
 * 크기는 patch만 재지 않고 직렬화한 근거 전체를 잽니다. patch를 뺀 나머지 근거의 추정 토큰을
 * 먼저 재고 남은 몫만 patch에 줍니다. 커밋 메시지와 변경 파일 목록, PR 정보가 상한 밖에 있으면
 * patch를 아무리 잘라도 413을 막을 수 없습니다. 나머지 근거만으로 상한을 넘으면 스냅샷을 만들지
 * 않고 실패로 알립니다.
 */
export function buildExperienceEvidenceSnapshot(
  item: ExperienceCandidateListItem,
  data: CandidateDataOutput,
  candidates: StageBCandidateResult,
  maxInputTokens: number = EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS
): EvidenceSnapshotResult {
  const { candidate, commit, origin, normalizedRelatedShas, normalizedCitedFilePaths } = item;
  // 대표 커밋을 색인에서 찾지 못하면 제목·메시지·PR·변경 파일이 모두 없어 인터뷰할 근거가 없습니다.
  // 목록 화면이 표시하는 `커밋 색인 실패`와 같은 상태이고, 확정 흐름에서는 Error로 알립니다.
  if (commit === null) return { ok: false, reason: "representative_commit_not_indexed" };

  const commitsBySha = new Map(data.includedCommits.map((entry) => [entry.sha, entry]));
  const diffsBySha = new Map(candidates.diffs.map((diff) => [diff.sha, diff]));

  const inputs: CommitInput[] = [candidate.sha, ...normalizedRelatedShas].map((sha, index) => {
    const role: EvidenceCommitRole = index === 0 ? "representative" : "related";
    const detail = role === "representative" ? commit : commitsBySha.get(sha) ?? null;
    const diff = diffsBySha.get(sha);
    return {
      sha,
      role,
      detail,
      diffByPath: new Map((diff?.files ?? []).map((file) => [file.path, file])),
      // 색인에 없는 관련 커밋도 diff에는 남아 있을 수 있으므로 변경 파일 목록을 잃지 않습니다.
      baseFiles: detail?.files.length ? detail.files : diff?.files ?? [],
    };
  });

  // 변경 파일은 대표 커밋만 보고 판단하지 않습니다. 대표 커밋이 빈 커밋이어도 같은 PR의 관련
  // 커밋에 변경 파일이 있으면 인터뷰할 근거가 있습니다.
  if (inputs.every(({ baseFiles }) => baseFiles.length === 0)) {
    return { ok: false, reason: "no_repository_evidence" };
  }

  const statement = { text: candidate.evidence, verifiability: EVIDENCE_STATEMENT_VERIFIABILITY };
  const citedFilePaths = {
    paths: normalizedCitedFilePaths,
    verifiability: CITED_FILE_PATHS_VERIFIABILITY,
  };

  const withoutPatches = assembleCommits(inputs, 0);
  const metadataTokens = estimateEvidenceTokens({
    evidence: statement,
    commits: withoutPatches.commits,
    citedFilePaths,
    unverifiableItems: REPOSITORY_UNVERIFIABLE_ITEMS,
  });
  const remainingTokens = maxInputTokens - metadataTokens;
  if (remainingTokens <= 0) return { ok: false, reason: "evidence_input_too_large" };

  const maxPatchBytes = remainingTokens * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN;
  const { commits, patchBytes, truncatedByBudget } = assembleCommits(inputs, maxPatchBytes);
  const [representativeCommit, ...relatedCommits] = commits;

  return {
    ok: true,
    snapshot: {
      candidateSha: candidate.sha,
      source: candidate.source,
      origin,
      evidence: statement,
      representativeCommit,
      relatedCommits,
      citedFilePaths,
      unverifiableItems: REPOSITORY_UNVERIFIABLE_ITEMS,
      patchBudget: {
        maxInputTokens,
        metadataTokens,
        maxPatchBytes,
        patchBytes,
        truncatedByBudget,
      },
    },
  };
}
