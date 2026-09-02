import { REPOSITORY_UNVERIFIABLE_ITEMS } from "./evidence-verifiability";
import type {
  CandidateDiffFile,
  EvidenceCommitRole,
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceSnapshotPatchBudget,
  EvidenceSnapshotResult,
  EvidenceVerifiability,
  ExperienceCandidateListItem,
  ExperienceEvidenceSnapshot,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";

/**
 * 근거 인계 입력 전체의 추정 토큰 상한입니다. patch만이 아니라 커밋 메시지, 변경 파일 목록,
 * PR 정보까지 포함한 렌더 결과를 이 값으로 묶습니다.
 *
 * **2026-09-01에 3,500에서 5,250으로 올렸습니다.**
 *
 * 3,500의 근거는 Groq 무료 등급의 분당 토큰 한도 8,000이었습니다. 초과를 429가 아니라 413
 * `rate_limit_exceeded`로 받고(`llm-wiki/wiki/2026-08-24-실데이터-검증-배치-상한-확정.md`), 상한을 꽉
 * 채운 요청이 입력 2,874~3,049에 응답 939~1,678토큰이라 최악 4,621토큰이 한도의 58%였습니다. 꼬리
 * 질문이 같은 근거를 매 턴 다시 싣기 때문에 남은 42%를 다음 턴 몫으로 남긴 값이 3,500이었습니다.
 *
 * 네 경로를 Gemini로 옮기면서 그 한도가 사라졌습니다. Groq는 유료 전환이 막혀 있어 후보가 아니고,
 * Gemini에는 분당 8,000토큰이라는 벽이 없습니다. 벽에서 나온 값이므로 벽과 함께 재산정합니다.
 *
 * 새 값의 근거는 실측입니다(2026-08-28, `llm-wiki/raw/2026-08-28-첫-질문-생성-모델-실측.md`).
 * 메타데이터 중복을 걷어낸 뒤 3,500에서 patch 몫이 4,881바이트, 5,250에서 10,131바이트였습니다.
 * 3,500에서는 `gemini-3.5-flash-lite`가 두 회차 모두 patch에 닿지 못해 커밋 메시지만으로 질문을
 * 만들었고, 5,250에서는 patch 안의 주석과 코드 표현식을 그대로 인용했습니다. 첫 청크 지연은 입력
 * 2,863토큰에서 5,043토큰까지 Lite 두 모델이 0.9~1.4초로 평평해 지연 대가가 없었습니다.
 *
 * 꼬리 질문은 이 값을 묶지 않습니다. 매 턴 근거를 다시 싣는 것은 그대로지만, 상한을 3,500에서
 * 5,250으로 올릴 때 늘어나는 것은 턴당 약 0.0004달러와 0초짜리 지연뿐입니다. 그 경로가 앞 단계의
 * 할당량을 먹지 않게 하는 것은 상한이 아니라 **모델 배분**으로 풉니다. Groq에서 Stage A가
 * `gpt-oss-120b`의 하루 한도를 소진해 첫 질문을 `gpt-oss-20b`로 갈랐던 것과 같은 방식입니다
 * (`question-generation.ts`). 꼬리 질문 경로를 구현할 때 근거를 매 턴 다시 실을지 정해지면 그때
 * 턴 수를 곱해 이 값을 다시 봅니다.
 *
 * 이 상수를 바꾸면 `INTERVIEW_QUESTION_MAX_PROMPT_BYTES`가 유도식으로 따라옵니다.
 */
export const EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS = 5_250;

/**
 * 토큰 추정에 쓰는 UTF-8 바이트 대 토큰 비율입니다.
 *
 * 문자 수로 상한을 걸면 비ASCII 근거에서 한도를 지키지 못합니다. 한국어 커밋 메시지나 이모지는
 * 문자 하나가 3~4바이트이고 토큰도 문자당 1개에 가까워, 같은 문자 수라도 실제 토큰이 몇 배로
 * 늘어납니다. 반대로 ASCII 코드 diff는 4바이트당 1토큰에 가깝기 때문에 3바이트당 1토큰은
 * 과대 추정이고, 상한을 넘지 않는 쪽으로 틀립니다.
 *
 * 이슈 #63 실측(2026-08-25)으로 이 값을 유지하기로 확정했습니다. 한국어 커밋 메시지와 ASCII diff가
 * 섞인 프롬프트에서 실제 바이트당 토큰이 Groq `openai/gpt-oss-20b` 3.635~3.669,
 * Google `gemini-3.6-flash` 3.439~3.669이었습니다. 3으로 나누면 실제보다 많은 토큰을 세므로 상한을
 * 넘지 않는 쪽으로 틀립니다. 실측값으로 올리면 추정은 정확해지지만 한국어만으로 이뤄진 근거에서
 * 여유가 사라집니다. 그런 근거는 문자 하나가 3바이트이고 토큰도 문자당 1개에 가까워 3에 붙습니다.
 * 3은 그 최악의 경우를 담는 값입니다. 측정값은
 * `llm-wiki/wiki/2026-08-25-첫-질문-생성-provider-실측과-재개-방침.md`에 있습니다.
 */
export const EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN = 3;

const utf8ByteLength = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x1_0000 ? 3 : 4;

/**
 * JSON 문자열로 직렬화했을 때 이 코드 포인트가 차지하는 바이트입니다. diff는 줄바꿈이 많고
 * `
`은 직렬화에서 2바이트가 되므로, 원본 UTF-8 바이트로만 재면 실제 요청 크기를 낮게 봅니다.
 */
function serializedCodePointBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint)) return 2;
  if (codePoint < 0x20) return 6;
  return utf8ByteLength(codePoint);
}

/** JSON 문자열 값으로 직렬화했을 때의 바이트입니다. 감싸는 따옴표는 세지 않습니다. */
export function serializedByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) bytes += serializedCodePointBytes(character.codePointAt(0)!);
  return bytes;
}

/** 직렬화한 근거의 추정 토큰입니다. 문자열을 주면 그 문자열을 그대로 잽니다. */
export function estimateEvidenceTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(new TextEncoder().encode(text).byteLength / EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN);
}

/**
 * 근거의 크기를 잴 때 쓰는 렌더러입니다. 모델에 실제로 가는 문자열을 내야 합니다.
 *
 * 예산은 모델 입력을 묶는 값이므로 실제 프롬프트로 재야 합니다. 2026-08-28까지는 JSON 직렬화
 * 바이트로 쟀고, 키와 따옴표가 빠지는 만큼 프롬프트가 더 작다고 보았습니다. 실측에서 그 가정이
 * 깨졌습니다. patch가 큰 근거에서는 렌더러가 붙이는 확인 수준 문장과 코드 블록 울타리가 키·따옴표
 * 보다 커서 JSON 10,436바이트에 프롬프트 10,632바이트였습니다
 * (`llm-wiki/raw/2026-08-28-근거-스냅샷-메타데이터-항목별-비용.md`).
 *
 * 이 모듈이 프롬프트 렌더러를 직접 부르면 기능 사이 의존이 양방향이 되므로 주입으로 받습니다.
 */
export type EvidenceBudgetRenderer = (snapshot: ExperienceEvidenceSnapshot) => string;

/**
 * 렌더러를 받지 못했을 때 쓰는 기본값입니다. JSON 직렬화 바이트로 재므로 프롬프트를 아는 호출부는
 * 반드시 자기 렌더러를 넘겨야 합니다. 프로덕션 경로는 `confirmExperienceSelection`이 넘깁니다.
 */
const serializeSnapshotForBudget: EvidenceBudgetRenderer = (snapshot) =>
  JSON.stringify(snapshot) ?? "";

/**
 * 직렬화 바이트 상한을 넘지 않는 가장 긴 앞부분을 남깁니다.
 *
 * 코드 포인트 경계에서만 자릅니다. UTF-16 코드 단위로 자르면 이모지 같은 astral 문자가 경계에
 * 걸릴 때 홀로 남은 서로게이트가 생기고, 직렬화 결과에 실제 Repository 문자가 아닌 값이 나갑니다.
 */
export function sliceEvidencePatchBySerializedBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = serializedCodePointBytes(character.codePointAt(0)!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return end === text.length ? text : text.slice(0, end);
}

/**
 * patch 하나가 본문 밖에서 더 쓰는 바이트입니다. patch가 있을 때와 없을 때 본문 밖 표기가 달라지는
 * 몫을 덮는 보수적인 값입니다. 이 몫이 없으면 patch가 예산을 꽉 채울 때 완성된 근거가 상한을 몇
 * 바이트 넘습니다.
 *
 * 2026-08-28에 4에서 8로 올렸습니다. 크기를 JSON 직렬화가 아니라 실제 프롬프트로 재게 되면서
 * (`buildExperienceEvidenceSnapshot`의 `renderForBudget`) 덮어야 하는 차이가 바뀌었습니다. patch가
 * 없는 파일은 `[patch 없음: 상한]` 같은 표식을 쓰고 있다가 patch가 실리면 그 표식이 사라지고 코드
 * 블록 울타리와 `[patch 잘림]`이 붙습니다. 실측 최악 조합이 파일당 5바이트 증가였습니다.
 */
const PATCH_ENVELOPE_BYTES = 8;

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
        sourcePatch === undefined
          ? ""
          : sliceEvidencePatchBySerializedBytes(
              sourcePatch,
              Math.max(0, available - PATCH_ENVELOPE_BYTES)
            );
      const usedBytes = serializedByteLength(patch);
      available -= usedBytes === 0 ? 0 : usedBytes + PATCH_ENVELOPE_BYTES;
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
 * 크기는 patch만 재지 않고 근거 전체를 잽니다. 무엇으로 재는지는 `renderForBudget`이 정하고,
 * 프로덕션은 실제 첫 질문 프롬프트를 넘깁니다. patch를 뺀 나머지 근거의 추정 토큰을
 * 먼저 재고 남은 몫만 patch에 줍니다. 커밋 메시지와 변경 파일 목록, PR 정보가 상한 밖에 있으면
 * patch를 아무리 잘라도 413을 막을 수 없습니다. 나머지 근거만으로 상한을 넘으면 스냅샷을 만들지
 * 않고 실패로 알립니다.
 */
export function buildExperienceEvidenceSnapshot(
  item: ExperienceCandidateListItem,
  data: CandidateDataOutput,
  candidates: StageBCandidateResult,
  maxInputTokens: number = EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
  renderForBudget: EvidenceBudgetRenderer = serializeSnapshotForBudget
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

  // 추정 대상은 실제로 직렬화되는 스냅샷 모양 그대로입니다. `candidateSha`, `source`, `origin`,
  // `patchBudget`과 커밋 묶음의 키까지 세지 않으면 patch가 몫을 다 쓸 때 완성된 스냅샷이 상한을
  // 넘습니다. 예산 숫자는 아직 정해지지 않았으므로 실제보다 크거나 같은 자리수를 넣어 추정이
  // 모자라지 않게 합니다.
  const budgetUpperBound = maxInputTokens * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN;
  const withoutPatches = assembleCommits(inputs, 0);
  const snapshotShape = (
    commits: readonly EvidenceSnapshotCommit[],
    patchBudget: EvidenceSnapshotPatchBudget
  ) => ({
    candidateSha: candidate.sha,
    source: candidate.source,
    origin,
    evidence: statement,
    representativeCommit: commits[0],
    relatedCommits: commits.slice(1),
    citedFilePaths,
    unverifiableItems: REPOSITORY_UNVERIFIABLE_ITEMS,
    patchBudget,
  });
  const metadataTokens = estimateEvidenceTokens(
    renderForBudget(
      snapshotShape(withoutPatches.commits, {
        maxInputTokens,
        metadataTokens: maxInputTokens,
        maxPatchBytes: budgetUpperBound,
        patchBytes: budgetUpperBound,
        truncatedByBudget: true,
      })
    )
  );
  const remainingTokens = maxInputTokens - metadataTokens;
  if (remainingTokens <= 0) return { ok: false, reason: "evidence_input_too_large" };

  const maxPatchBytes = remainingTokens * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN;
  const { commits, patchBytes, truncatedByBudget } = assembleCommits(inputs, maxPatchBytes);

  return {
    ok: true,
    snapshot: snapshotShape(commits, {
      maxInputTokens,
      metadataTokens,
      maxPatchBytes,
      patchBytes,
      truncatedByBudget,
    }),
  };
}
