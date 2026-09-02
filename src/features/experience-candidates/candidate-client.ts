import type {
  CandidateDiff,
  ExperienceCandidateSource,
  StageACandidate,
  StageACandidateOutput,
  StageAProgress,
  StageBCandidateResult,
} from "./types";
import { validateExperienceCandidateOutput } from "./schema";
import {
  selectWorkUnitsForStageA,
  STAGE_A_MAX_SELECTION_BYTES,
  type ExcludedWorkUnit,
} from "./work-unit-selection";
import { groupCommitsIntoWorkUnits, type ExcludedCommit, type WorkUnit } from "./work-unit";
import {
  allocateCommitQuota,
  selectRepresentativeCommits,
  summarizeWorkUnit,
} from "./work-unit-summary";
import { STAGE_B_MAX_INPUT_COMMITS } from "./stage-b";
import { resolveStageBMaxInputCommits } from "./llm-provider";
import type { ReadonlyCommitDetail, RepositoryRef } from "@/lib/github/types";
import {
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  STAGE_A_MAX_PROMPT_BYTES,
  STAGE_A_MAX_REQUEST_BYTES,
  STAGE_A_MAX_UNITS,
  buildStageAPayload,
  renderStageAPrompt,
  STAGE_A_CANDIDATE_QUOTA,
  type StageAUnitInput,
} from "./stage-a";

export type CandidateStage = "stage_a" | "stage_b";

/**
 * 후보 생성 라우트가 반환하는 오류 kind에 클라이언트 전용 kind 2개를 더한 집합입니다.
 * `fetch_network`는 서버 응답을 받기 전의 전송 실패, `invalid_response`는 성공 응답의 형식 위반입니다.
 */
export type CandidateRequestErrorKind =
  | "unauthorized"
  | "invalid_json"
  | "invalid_request"
  | "body_too_large"
  | "json_parse"
  | "schema_validation"
  | "unknown_sha"
  | "unrelated_sha"
  | "unknown_file_path"
  | "llm_network"
  | "llm_auth"
  | "llm_rate_limit"
  | "llm_timeout"
  | "llm_configuration"
  | "llm_request"
  | "llm_failure"
  | "auth_revoked"
  | "repo_not_found"
  | "rate_limit"
  | "network"
  | "server_error"
  | "partial_failure"
  | "fetch_network"
  | "invalid_response";

const KNOWN_ERROR_KINDS: readonly CandidateRequestErrorKind[] = [
  "unauthorized", "invalid_json", "invalid_request", "body_too_large",
  "json_parse", "schema_validation", "unknown_sha", "unrelated_sha", "unknown_file_path",
  "llm_network", "llm_auth", "llm_rate_limit", "llm_timeout", "llm_configuration", "llm_request", "llm_failure",
  "auth_revoked", "repo_not_found", "rate_limit", "network", "server_error", "partial_failure",
];

export class CandidateRequestError extends Error {
  constructor(
    readonly stage: CandidateStage,
    readonly kind: CandidateRequestErrorKind,
    message: string,
    options?: ErrorOptions & { retryable?: boolean }
  ) {
    super(message, options);
    this.name = "CandidateRequestError";
    this.retryable = options?.retryable ?? true;
  }
  readonly retryable: boolean;
}

async function postCandidateApi(stage: CandidateStage, url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new CandidateRequestError(stage, "fetch_network", "후보 생성 서버에 연결하지 못했습니다.", { cause });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new CandidateRequestError(stage, "invalid_response", "후보 생성 응답을 해석하지 못했습니다.", { cause });
  }
  if (response.ok) return payload;
  const error =
    typeof payload === "object" && payload !== null && "error" in payload &&
    typeof payload.error === "object" && payload.error !== null
      ? (payload.error as { kind?: unknown; message?: unknown; retryable?: unknown })
      : undefined;
  const kind =
    typeof error?.kind === "string" && (KNOWN_ERROR_KINDS as readonly string[]).includes(error.kind)
      ? (error.kind as CandidateRequestErrorKind)
      : "server_error";
  const message = typeof error?.message === "string" ? error.message : "후보 생성 요청에 실패했습니다.";
  throw new CandidateRequestError(stage, kind, message, { retryable: error?.retryable !== false });
}

const SOURCES: readonly ExperienceCandidateSource[] = [
  "contribution_match",
  "automatic_recommendation",
];

function isStageACandidate(value: unknown): value is StageACandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StageACandidate>;
  return (
    typeof candidate.sha === "string" &&
    SOURCES.includes(candidate.source as ExperienceCandidateSource) &&
    (candidate.contributionItem === null || typeof candidate.contributionItem === "string")
  );
}

/**
 * 커밋을 PR 단위 작업 묶음으로 접어 Stage A 요청 입력으로 만듭니다.
 *
 * patch는 보내지 않습니다. 입력 계약 위반(422)입니다. 커밋 메시지 본문과 파일별 숫자도 더는
 * 보내지 않습니다. 묶음 요약이 그 자리를 대신합니다.
 */
/**
 * 커밋을 묶음으로 접고 점수 상위 묶음만 Stage A 입력으로 고릅니다.
 *
 * 전체 묶음을 청크로 쪼개 보내던 방식을 대신합니다. 그 방식은 `andbread` 66묶음 7청크 실측에서
 * 첫 시도 계약 준수가 33퍼센트였고, 청크 하나가 복구를 소진하면 이미 끝난 청크의 결과까지 버리고
 * 전체가 실패했습니다. 근거는 `selectWorkUnitsForStageA`에 있습니다.
 *
 * `workUnits`는 선별에서 빠진 묶음까지 전부 담습니다. 후보를 커밋으로 펼칠 때 쓰는 값이라
 * 선별 결과와 무관하게 원본을 유지해야 합니다.
 */
/**
 * 기여 항목이 프롬프트에서 차지하는 바이트입니다.
 *
 * 선별 예산에서 이 몫을 미리 뺍니다. 빼지 않으면 선별이 요약만으로 상한을 꽉 채우고, 그 뒤에
 * 기여 항목이 얹혀 라우트의 프롬프트 검증을 넘습니다. 실측에서 `demian` 요약 9,913바이트에
 * 기여 항목 200자만 더해도 10,530바이트가 되어 상한 10,500을 넘고 422로 거부됐습니다.
 *
 * 청크를 더 나누는 방법도 되지만 그 편이 나쁩니다. 분당 토큰 한도 8,000은 청크를 나눠도
 * 합계에 걸립니다. 묶음을 덜 보내고 한 번에 끝내는 쪽이 낫습니다. 빠진 묶음은
 * `over_byte_budget` 사유로 화면에 표시되므로 조용히 사라지지 않습니다.
 *
 * `renderStageAPrompt`가 만드는 문자열에서 요약을 뺀 나머지를 그대로 잽니다. 문단 구분
 * 두 글자와 `기여 항목:` 머리글이 여기 포함됩니다.
 */
function contributionItemPromptBytes(contributionItems: readonly string[]): number {
  if (contributionItems.length === 0) return 0;
  const withoutUnits = renderStageAPrompt(
    buildStageAPayload({ units: [], contributionItems: [...contributionItems], candidateLimit: 1 })
  );
  // 요약이 없으면 문단 구분이 붙지 않으므로 두 글자를 더해 실제 프롬프트와 맞춥니다.
  return new TextEncoder().encode(withoutUnits).byteLength + 2;
}

export function toStageAUnits(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[] = [],
  /**
   * 선별 예산을 주입할 수 있게 열어 둡니다. 상한을 바꿔 가며 재려면 필요합니다. 모델 ID를 열어 둔
   * 것과 같은 이유이고, 프로덕션 경로는 기본값을 씁니다.
   */
  maxSelectionBytes: number = STAGE_A_MAX_SELECTION_BYTES
): {
  units: StageAUnitInput[];
  /** Stage B 근거를 펼칠 때 필요합니다. Stage A 요청에는 실리지 않습니다. */
  workUnits: readonly WorkUnit<ReadonlyCommitDetail>[];
  excludedCommits: readonly ExcludedCommit[];
  /** 점수 선별에서 빠진 묶음입니다. 화면이 제외 사유를 보여주려면 이 값이 필요합니다. */
  excludedUnits: readonly ExcludedWorkUnit<ReadonlyCommitDetail>[];
  /** 선택된 묶음 중 가장 낮은 점수입니다. */
  thresholdScore: number;
} {
  const { units, excludedCommits } = groupCommitsIntoWorkUnits(commits);
  const selection = selectWorkUnitsForStageA(
    units,
    maxSelectionBytes - contributionItemPromptBytes(contributionItems)
  );
  return {
    units: selection.selected.map(({ unit }) => ({
      pullRequestNumber: unit.pullRequestNumber,
      representativeSha: selectRepresentativeCommits(unit, 1)[0].sha,
      summary: summarizeWorkUnit(unit),
    })),
    workUnits: units,
    excludedCommits,
    excludedUnits: selection.excluded,
    thresholdScore: selection.thresholdScore,
  };
}

/**
 * 후보로 뽑힌 묶음을 Stage B 입력 커밋으로 펼칩니다.
 *
 * Stage A는 묶음 하나를 후보 하나로 돌려주지만 Stage B는 커밋 단위로 patch를 받습니다. 대표
 * 커밋만 넘기면 커밋 18개짜리 Pull Request가 뽑혀도 근거가 한 개뿐입니다.
 *
 * 전부 넘기지도 않습니다. `andbread` 후보 14묶음은 커밋 148개가 되어 상세 재조회에 128초가
 * 걸리고 patch가 커밋당 405자로 쪼그라듭니다. `STAGE_B_MAX_INPUT_COMMITS`가 그 상한입니다.
 *
 * 펼친 커밋은 묶음의 `source`와 `contributionItem`을 그대로 물려받습니다. 같은 묶음의 커밋이
 * 서로 다른 출처를 가질 수 없기 때문입니다.
 */
export function expandCandidatesToCommits(
  candidates: readonly StageACandidate[],
  workUnits: readonly WorkUnit<ReadonlyCommitDetail>[],
  maxCommits = resolveStageBMaxInputCommits(STAGE_B_MAX_INPUT_COMMITS)
): StageACandidate[] {
  const unitByRepresentativeSha = new Map(
    workUnits.map((unit) => [selectRepresentativeCommits(unit, 1)[0].sha, unit])
  );
  const selected = candidates.flatMap((candidate) => {
    const unit = unitByRepresentativeSha.get(candidate.sha);
    return unit === undefined ? [] : [{ candidate, unit }];
  });
  const quota = allocateCommitQuota(
    selected.map(({ unit }) => unit.commits.length),
    maxCommits
  );
  return selected.flatMap(({ candidate, unit }, index) =>
    selectRepresentativeCommits(unit, quota[index]).map((commit) => ({
      sha: commit.sha,
      source: candidate.source,
      contributionItem: candidate.contributionItem,
    }))
  );
}

/** 한 청크의 요청 본문입니다. `candidateLimit`은 청크마다 고정된 쿼터입니다. */
export function toStageARequest(
  units: readonly StageAUnitInput[],
  contributionItems: readonly string[],
  candidateLimit: number
) {
  return { units: [...units], contributionItems: [...contributionItems], candidateLimit };
}

/**
 * 요청 하나가 서버 상한에 드는지 확인합니다. 넘으면 실패시킵니다.
 *
 * **2026-09-02에 `splitUnitsIntoChunks`를 대신했습니다.** 그 함수는 묶음을 여러 청크로 나눠
 * 보내려고 있었습니다. 선별이 바이트와 개수 상한을 함께 지키게 되면서 결과가 언제나 한 요청에
 * 담기므로 나눌 일이 없어졌습니다. 남은 일은 검증뿐입니다.
 *
 * 검증이 여전히 필요한 이유는 재는 대상이 둘이기 때문입니다. 선별은 묶음 요약의 렌더 바이트로
 * 자르지만 요청 본문은 JSON 이스케이프가 붙습니다. 따옴표나 백슬래시가 많은 요약은 선별을
 * 통과하고도 요청 상한을 넘을 수 있습니다.
 *
 * 서버와 같은 함수로 잽니다. 예전에 라우트가 요약만 손으로 다시 이어붙여 기여 항목을 빠뜨렸고,
 * 계산이 어긋나 클라이언트가 통과할 수 없는 요청을 만들어 보냈습니다.
 *
 * 조용히 담아 보내면 서버가 422로 거부하고, 조용히 버리면 사용자가 이유를 알 수 없습니다. 그래서
 * 실패시키되 `CandidateRequestError`로 던집니다. 평범한 `Error`로 던지면 `generateCandidates`가
 * 재시도 지점을 남겨(`repository-analysis.ts`의 `samePayloadAlwaysFails`가
 * `CandidateRequestError`만 봅니다) 같은 입력으로 반드시 같은 실패를 반복하는 재시도 버튼을
 * 사용자에게 줍니다.
 */
export function assertStageARequestWithinLimits(
  units: readonly StageAUnitInput[],
  contributionItems: readonly string[]
): void {
  if (units.length === 0) return;
  const encoder = new TextEncoder();
  const request = toStageARequest(units, contributionItems, 1);
  const promptBytes = encoder.encode(renderStageAPrompt(buildStageAPayload(request))).length;
  const requestBytes = encoder.encode(JSON.stringify(request)).length;
  if (
    units.length <= STAGE_A_MAX_UNITS &&
    promptBytes <= STAGE_A_MAX_PROMPT_BYTES &&
    requestBytes <= STAGE_A_MAX_REQUEST_BYTES
  ) {
    return;
  }
  throw new CandidateRequestError(
    "stage_a",
    "invalid_request",
    "Stage A 입력이 한 번에 보낼 수 있는 상한에 들어가지 않습니다. 기여 항목이 길면 줄여주세요.",
    { retryable: false }
  );
}

/**
 * `fetchStageACandidatesFromApi`의 반환 타입입니다. `StageACandidateOutput`을 넓히되 그 타입
 * 자체는 건드리지 않습니다. `StageACheckpoint`와 `StageAChunkOutput`이 `StageACandidateOutput`을
 * 함께 상속하므로(`types.ts:50`), 화면 전용 값을 상위 타입에 얹으면 체크포인트와 청크 응답까지
 * 커집니다. 두 값 다 화면이 쓰지 않는 값이라 실을 이유가 없습니다.
 */
export interface StageASelectionSummary {
  readonly excludedCommits: readonly ExcludedCommit[];
  /** 점수 선별에서 빠진 묶음입니다. 화면이 제외 사유를 보여주려면 이 값이 필요합니다. */
  readonly excludedUnits: readonly ExcludedWorkUnit<ReadonlyCommitDetail>[];
  /** 선택된 묶음 중 가장 낮은 점수입니다. */
  readonly thresholdScore: number;
  /**
   * 점수 선별을 통과해 실제로 모델에 보낸 묶음 수입니다.
   *
   * 화면이 "전체 N묶음 중 M묶음을 판단했습니다"를 말하려면 분자가 필요합니다. 제외 수만 보여주면
   * 사용자는 그것이 전체의 얼마인지 알 수 없고, 저장소가 커서 잘렸다는 사실이 드러나지 않습니다.
   */
  readonly selectedUnitCount: number;
}

export interface StageACandidateResult extends StageACandidateOutput, StageASelectionSummary {}

/**
 * Stage A를 한 번 호출해 후보와 제외 사유를 함께 돌려줍니다.
 *
 * **2026-09-02까지 이 함수는 묶음을 청크로 나눠 여러 번 호출했습니다.** 청크 사이에 한도 창을
 * 기다리고, 실패하면 이미 끝난 청크를 체크포인트로 남겨 재개했습니다. 선별이 바이트와 개수 상한을
 * 함께 지키게 되면서 결과가 언제나 한 요청에 담기므로 그 구조가 전부 도달 불가가 되어 걷어냈습니다.
 * 근거는 `llm-wiki/raw/2026-09-02-Stage-A-묶음-수-천장-실측.md`입니다.
 *
 * 호출이 한 번이면 실패는 전부 아니면 전무입니다. 부분 결과를 살릴 자리가 없으므로 체크포인트도
 * 없앴습니다. 라우트 안에는 여전히 복구와 저하가 있어(`route.ts`의 `selectWithRecovery`) 모델이
 * 계약을 어긴 묶음만 판단 불가로 내려오고 나머지는 살아 돌아옵니다.
 */
export async function fetchStageACandidatesFromApi(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[],
  onProgress: (progress: StageAProgress) => void = () => undefined
): Promise<StageACandidateResult> {
  const { units, workUnits, excludedCommits, excludedUnits, thresholdScore } = toStageAUnits(
    commits,
    contributionItems
  );
  assertStageARequestWithinLimits(units, contributionItems);

  const payload = await postCandidateApi(
    "stage_a",
    "/api/candidates/stage-a",
    toStageARequest(units, contributionItems, Math.min(STAGE_A_CANDIDATE_QUOTA, units.length))
  );
  if (!isStageACandidateOutput(payload)) {
    throw new CandidateRequestError(
      "stage_a",
      "invalid_response",
      "Stage A 응답 형식이 올바르지 않습니다."
    );
  }
  const { candidates, unclassifiedShas, unjudgedShas } = payload;
  onProgress({ completed: units.length, total: units.length });

  // 후보 상한은 쿼터로 이미 요청에 실었지만, 서버가 쿼터를 어긴 응답을 돌려주는 경우까지
  // 통과시키면 Stage B가 상한 초과 입력으로 422를 받습니다.
  if (candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT) {
    throw new CandidateRequestError(
      "stage_a",
      "schema_validation",
      `Stage A 후보가 상한 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개를 넘었습니다.`
    );
  }
  // 후보 수 검증까지는 묶음 단위로 하고, 커밋으로 펼치는 것은 마지막에 합니다.
  return {
    candidates: expandCandidatesToCommits(candidates, workUnits),
    unclassifiedShas,
    unjudgedShas,
    excludedCommits,
    excludedUnits,
    thresholdScore,
    selectedUnitCount: units.length,
  };
}

function isStageACandidateOutput(payload: unknown): payload is StageACandidateOutput {
  const output = payload as Partial<StageACandidateOutput>;
  return (
    typeof payload === "object" && payload !== null &&
    Array.isArray(output.candidates) && output.candidates.every(isStageACandidate) &&
    Array.isArray(output.unclassifiedShas) &&
    output.unclassifiedShas.every((sha) => typeof sha === "string") &&
    Array.isArray(output.unjudgedShas) &&
    output.unjudgedShas.every((sha) => typeof sha === "string")
  );
}

function isCandidateDiff(value: unknown): value is CandidateDiff {
  if (typeof value !== "object" || value === null) return false;
  const diff = value as Partial<CandidateDiff>;
  return (
    typeof diff.sha === "string" &&
    Array.isArray(diff.files) &&
    diff.files.every(
      (file) => typeof file === "object" && file !== null && typeof (file as { path?: unknown }).path === "string"
    )
  );
}

export async function fetchStageBCandidatesFromApi(
  repository: RepositoryRef,
  candidates: readonly StageACandidate[]
): Promise<StageBCandidateResult> {
  const payload = await postCandidateApi("stage_b", "/api/candidates/stage-b", {
    owner: repository.owner,
    repo: repository.repo,
    candidates,
  });
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray((payload as { diffs?: unknown }).diffs) ||
    !(payload as { diffs: unknown[] }).diffs.every(isCandidateDiff)
  ) {
    throw new CandidateRequestError("stage_b", "invalid_response", "Stage B 응답 형식이 올바르지 않습니다.");
  }
  const { diffs, ...output } = payload as { diffs: CandidateDiff[] } & Record<string, unknown>;
  try {
    return { ...validateExperienceCandidateOutput(output), diffs };
  } catch (cause) {
    // 서버가 이미 검증한 응답이므로 형식 위반은 LLM 스키마 위반이 아니라 전송 계층 문제로 다룹니다.
    throw new CandidateRequestError("stage_b", "invalid_response", "Stage B 응답 형식이 올바르지 않습니다.", { cause });
  }
}
