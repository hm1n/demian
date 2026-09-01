import type {
  CandidateDiff,
  ExperienceCandidateSource,
  StageACandidate,
  StageACheckpoint,
  StageAChunkOutput,
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
  STAGE_A_CHUNK_MAX_BYTES,
  STAGE_A_CHUNK_MAX_REQUEST_BYTES,
  STAGE_A_CHUNK_MAX_UNITS,
  buildStageAPayload,
  renderStageAPrompt,
  resolveChunkQuota,
  STAGE_A_DEGRADED_WAIT_MS,
  type StageAUnitInput,
  STAGE_A_RESET_SAFETY_MS,
  STAGE_A_TOKEN_RESERVE,
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
    options?: ErrorOptions & { checkpoint?: StageACheckpoint; retryable?: boolean }
  ) {
    super(message, options);
    this.name = "CandidateRequestError";
    this.checkpoint = options?.checkpoint;
    this.retryable = options?.retryable ?? true;
  }
  readonly checkpoint?: StageACheckpoint;
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
 * 묶음을 청크로 나눕니다.
 *
 * 프롬프트 바이트와 요청 본문 바이트를 둘 다 봅니다. 서버가 두 값을 각각 검증하므로 어느 한쪽만
 * 보고 나누면 422가 납니다.
 *
 * 프롬프트 바이트는 서버와 같은 `renderStageAPrompt`로 잽니다. 예전에는 여기서 요약만 이어붙여
 * 재고 기여 항목을 빼먹었습니다. 서버가 기여 항목까지 재도록 고쳐지자(Codex 리뷰 P2-1) 양쪽
 * 계산이 어긋나 클라이언트가 통과할 수 없는 청크를 만들어 보냈습니다. 실측에서 `demian` 요약
 * 9,913바이트에 기여 항목 200자를 더하면 10,530바이트로 상한 10,500을 넘어 모든 청크가 422로
 * 거부됐습니다. 크기를 재는 곳이 둘로 갈리면 반드시 다시 어긋나므로 서버와 같은 함수를 씁니다.
 */
export function splitUnitsIntoChunks(
  units: readonly StageAUnitInput[],
  contributionItems: readonly string[]
): StageAUnitInput[][] {
  const encoder = new TextEncoder();
  /** 묶음 묶기 하나가 두 상한 안에 드는지 잽니다. 서버가 재는 것과 같은 값이어야 합니다. */
  const measure = (chunk: readonly StageAUnitInput[]) => {
    const request = toStageARequest(chunk, contributionItems, 1);
    return {
      promptBytes: encoder.encode(renderStageAPrompt(buildStageAPayload(request))).length,
      requestBytes: encoder.encode(JSON.stringify(request)).length,
    };
  };
  const withinLimits = ({ promptBytes, requestBytes }: ReturnType<typeof measure>) =>
    promptBytes <= STAGE_A_CHUNK_MAX_BYTES && requestBytes <= STAGE_A_CHUNK_MAX_REQUEST_BYTES;

  const result: StageAUnitInput[][] = [];
  for (const unit of units) {
    const current = result.at(-1);
    if (current !== undefined) {
      const proposed = [...current, unit];
      if (proposed.length <= STAGE_A_CHUNK_MAX_UNITS && withinLimits(measure(proposed))) {
        result[result.length - 1] = proposed;
        continue;
      }
    }
    /**
     * 새 청크를 만들 때는 그 묶음이 혼자서 상한에 드는지 반드시 확인합니다.
     *
     * 예전에는 첫 청크(`current === undefined`)만 확인했습니다. 뒤쪽 묶음이 앞 청크에 못 들어가
     * 새 청크의 머리가 될 때는 크기를 다시 재지 않아, 혼자서 상한을 넘는 묶음이 그대로 라우트에
     * 가서 422를 받았습니다. `toStageAUnits`가 요약 렌더 바이트로 선별하므로 프롬프트 상한은
     * 지켜지지만, 요청 본문은 JSON 이스케이프가 붙어 따옴표나 백슬래시가 많은 요약이 선별을
     * 통과하고도 20,000바이트를 넘을 수 있습니다.
     *
     * 조용히 담아 보내면 서버가 422로 거부하고, 조용히 버리면 사용자가 제외 사유를 알 수
     * 없습니다. 그래서 실패시키되 `CandidateRequestError`로 던집니다. 평범한 `Error`로 던지면
     * `generateCandidates`가 재시도 지점을 남겨(`repository-analysis.ts`의
     * `samePayloadAlwaysFails`가 `CandidateRequestError`만 봅니다) 같은 입력으로 반드시 같은
     * 실패를 반복하는 재시도 버튼을 사용자에게 줍니다.
     */
    if (!withinLimits(measure([unit]))) {
      throw new CandidateRequestError(
        "stage_a",
        "invalid_request",
        `작업 묶음 하나(PR#${unit.pullRequestNumber})가 Stage A 입력 상한에 들어가지 않습니다. 기여 항목이 길면 줄여주세요.`,
        { retryable: false }
      );
    }
    result.push([unit]);
  }
  return result;
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
}

export interface StageACandidateResult extends StageACandidateOutput, StageASelectionSummary {}

export async function fetchStageACandidatesFromApi(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[],
  onProgress: (progress: StageAProgress) => void = () => undefined,
  checkpoint?: StageACheckpoint,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<StageACandidateResult> {
  const processed = new Set(checkpoint?.processedShas ?? []);
  const candidates = [...(checkpoint?.candidates ?? [])];
  const unclassifiedShas = [...(checkpoint?.unclassifiedShas ?? [])];
  const unjudgedShas = [...(checkpoint?.unjudgedShas ?? [])];
  const { units, workUnits, excludedCommits, excludedUnits, thresholdScore } = toStageAUnits(
    commits,
    contributionItems
  );
  const pending = units.filter(({ representativeSha }) => !processed.has(representativeSha));
  const chunks = splitUnitsIntoChunks(pending, contributionItems);
  // 쿼터를 여기서 한 번 정합니다. 청크마다 전역 상한을 보내던 이전 방식은 실효 상한을
  // `청크 수 × 20`으로 만들어 재판단 라운드를 부르는 원인이었습니다.
  const quota = resolveChunkQuota(chunks.length);

  const requestChunk = async (chunk: readonly StageAUnitInput[]) => {
    const payload = await postCandidateApi(
      "stage_a",
      "/api/candidates/stage-a",
      toStageARequest(chunk, contributionItems, Math.min(quota, chunk.length))
    );
    if (!isStageAChunkOutput(payload)) {
      throw new CandidateRequestError("stage_a", "invalid_response", "Stage A 응답 형식이 올바르지 않습니다.");
    }
    return payload as StageAChunkOutput;
  };

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const output = await requestChunk(chunk);
      candidates.push(...output.candidates);
      unclassifiedShas.push(...output.unclassifiedShas);
      unjudgedShas.push(...output.unjudgedShas);
      chunk.forEach(({ representativeSha }) => processed.add(representativeSha));
      onProgress({ completed: processed.size, total: units.length, waitingForRateLimit: false });
      const moreRequests = index + 1 < chunks.length;
      if (moreRequests && !output.rateLimit) {
        /**
         * 한도 메타데이터가 없는 응답이 두 가지입니다. 구분하지 않으면 저하 경로가 제 일을 못
         * 합니다.
         *
         * 라우트가 복구를 소진해 부분 결과로 저하시킬 때 `rateLimit`을 null로 돌려줍니다
         * (`route.ts`의 `degrade`). 이때 판단하지 못한 묶음이 `unjudgedShas`에 담기므로 그것이
         * 저하의 표식입니다. 예전에는 이 경우도 응답 형식 오류로 던져서, 청크가 여러 개일 때 앞
         * 청크가 저하되면 뒤 청크를 아예 시도하지 않고 Stage A 전체가 실패했습니다. 저하는 이미
         * 처리한 판단을 살리려고 만든 경로인데 그 목적을 스스로 깼습니다.
         *
         * 판단 불가가 비어 있으면 저하가 아니라 정말 형식이 어긋난 응답이므로 그대로 던집니다.
         */
        if (output.unjudgedShas.length === 0) {
          throw new CandidateRequestError("stage_a", "invalid_response", "LLM 토큰 한도 메타데이터가 없습니다.");
        }
        // 남은 토큰을 모르므로 분당 창을 통째로 기다린 뒤 다음 청크로 넘어갑니다.
        onProgress({ completed: processed.size, total: units.length, waitingForRateLimit: true });
        await wait(STAGE_A_DEGRADED_WAIT_MS);
      } else if (moreRequests && output.rateLimit && output.rateLimit.remainingTokens < STAGE_A_TOKEN_RESERVE) {
        onProgress({ completed: processed.size, total: units.length, waitingForRateLimit: true });
        await wait(output.rateLimit.resetAfterMs + STAGE_A_RESET_SAFETY_MS);
      }
    }
  } catch (cause) {
    if (cause instanceof CandidateRequestError) {
      throw new CandidateRequestError(cause.stage, cause.kind, cause.message, {
        cause,
        retryable: cause.retryable,
        checkpoint: {
          candidates,
          unclassifiedShas,
          unjudgedShas,
          processedShas: [...processed],
          totalUnits: units.length,
        },
      });
    }
    throw cause;
  }

  // 쿼터가 상한을 넘지 않도록 `resolveChunkQuota`가 이미 보장하지만, 서버가 쿼터를 어긴 응답을
  // 돌려주는 경우까지 통과시키면 Stage B가 상한 초과 입력으로 422를 받습니다.
  if (candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT) {
    throw new CandidateRequestError(
      "stage_a",
      "schema_validation",
      `Stage A 후보가 상한 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개를 넘었습니다.`,
      {
        checkpoint: {
          candidates,
          unclassifiedShas,
          unjudgedShas,
          processedShas: [...processed],
          totalUnits: units.length,
        },
      }
    );
  }
  // 후보 수 검증까지는 묶음 단위로 하고, 커밋으로 펼치는 것은 마지막에 합니다. 체크포인트에
  // 묶음 단위 후보가 남아야 재개했을 때 같은 묶음을 두 번 펼치지 않습니다.
  return {
    candidates: expandCandidatesToCommits(candidates, workUnits),
    unclassifiedShas,
    unjudgedShas,
    excludedCommits,
    excludedUnits,
    thresholdScore,
  };
}

function isStageAChunkOutput(payload: unknown): payload is StageAChunkOutput {
  const output = payload as Partial<StageAChunkOutput>;
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray(output.candidates) || !output.candidates.every(isStageACandidate) ||
    !Array.isArray(output.unclassifiedShas) ||
    !output.unclassifiedShas.every((sha) => typeof sha === "string") ||
    !Array.isArray(output.unjudgedShas) ||
    !output.unjudgedShas.every((sha) => typeof sha === "string") ||
    !(output.rateLimit === null || (
      typeof output.rateLimit === "object" && output.rateLimit !== null &&
      typeof output.rateLimit.remainingTokens === "number" &&
      typeof output.rateLimit.resetAfterMs === "number" &&
      typeof output.rateLimit.usedTokens === "number"
    ))
  ) {
    return false;
  }
  return true;
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
