import {
  scoreWorkUnit,
  sortByScoreDescending,
  type ScorableCommit,
  type WorkUnitSignal,
} from "./work-unit-score";
import { renderWorkUnitSummary, summarizeWorkUnit } from "./work-unit-summary";
import type { WorkUnit } from "./work-unit";

/**
 * Stage A 한 번에 보낼 수 있는 작업 묶음의 프롬프트 바이트 상한입니다.
 *
 * Groq 무료 등급의 분당 토큰 한도(TPM)가 8,000입니다. 이 한도보다 큰 요청은 기다려도 통과하지
 * 않습니다. 한도 초과는 429가 아니라 본문에 `rate_limit_exceeded`를 담은 413으로 오고
 * (`errors.ts` 참고), 재시도 안내를 보내도 같은 페이로드로는 영원히 실패합니다.
 *
 * 실측에서 프롬프트 5,842바이트가 총 3,949토큰이었습니다(입력·출력·추론 합계). 바이트당
 * 0.676토큰이 관측 최대치입니다. 10,500바이트면 약 7,100토큰으로 한도 대비 11퍼센트가
 * 남습니다. `gpt-oss` 계열은 추론 토큰이 출력에 실려 같은 입력에서도 총 토큰이 2,954에서
 * 3,949까지 34퍼센트 흔들리므로 이 여유가 필요합니다.
 */
export const STAGE_A_MAX_SELECTION_BYTES = 10_500;

export type WorkUnitSelectionExclusionReason = "below_score_threshold" | "over_byte_budget";

export interface SelectedWorkUnit<TCommit extends ScorableCommit> {
  readonly unit: WorkUnit<TCommit>;
  readonly score: number;
}

export interface ExcludedWorkUnit<TCommit extends ScorableCommit>
  extends SelectedWorkUnit<TCommit> {
  readonly reason: WorkUnitSelectionExclusionReason;
  /**
   * 발화한 신호입니다. `scoreWorkUnit`이 이미 계산해 두는 값이고, 화면이 "왜 이 점수인지"를
   * 보여주려면 필요합니다. `selected`에는 화면이 쓰지 않아 싣지 않습니다.
   */
  readonly signals: readonly WorkUnitSignal[];
}

export interface WorkUnitSelection<TCommit extends ScorableCommit> {
  readonly selected: readonly SelectedWorkUnit<TCommit>[];
  readonly excluded: readonly ExcludedWorkUnit<TCommit>[];
  /** 선택된 묶음 중 가장 낮은 점수입니다. 화면이 "N점 미만 제외"를 표시할 때 씁니다. */
  readonly thresholdScore: number;
  readonly bytes: number;
}

/** 사용자에게 보여줄 제외 사유 문구입니다. */
export const WORK_UNIT_SELECTION_EXCLUSION_COPY: Record<
  WorkUnitSelectionExclusionReason,
  string
> = {
  below_score_threshold: "점수가 기준에 못 미쳐 판단 대상에서 제외했습니다",
  over_byte_budget: "한 번에 보낼 수 있는 분량을 넘어 제외했습니다",
};

/**
 * Stage A에 보낼 작업 묶음을 점수 순으로 고릅니다.
 *
 * 묶음을 여러 청크로 쪼개 각 청크에 후보 쿼터를 나눠주던 방식을 대신합니다. 그 방식은 실측에서
 * 첫 시도 계약 준수가 6청크 중 2회(33퍼센트)였고, 청크 하나가 복구를 소진하면 이미 끝난 청크의
 * 결과까지 버리고 전체가 실패했습니다(`andbread` 66묶음 7청크 실측). 쿼터를 청크에 나눠주는
 * 것도 "어느 청크에 담겼는가"라는 우연이 선정을 좌우해 근거가 없었습니다.
 *
 * 상위 N개가 아니라 점수 경계에서 끊습니다. `andbread`는 2점짜리가 15개 뭉쳐 있어서 상위
 * 20개로 자르면 그중 10개만 남고 5개가 입력 순서로 잘립니다. 그러면 "상위 20개를 골랐습니다"가
 * 설명이 되지 않습니다. 같은 점수는 전부 넣거나 전부 뺍니다.
 *
 * 점수가 같은 무리 하나가 예산보다 큰 경우에만 그 무리를 쪼갭니다. 무리를 쪼개도 낱개 묶음
 * 하나가 예산을 혼자 넘으면 그 묶음은 선택하지 않습니다. 모든 묶음이 개별적으로 예산을 넘으면
 * `selected`는 빈 배열이 됩니다 — 억지로 하나를 남기지 않습니다. 그 경우 Stage A를 아예 부르지
 * 않는 것이 호출부의 책임입니다.
 *
 * 제외된 묶음은 사유와 점수를 달아 그대로 돌려줍니다. 조용히 버리면 사용자가 자기 작업이 왜
 * 안 보이는지 알 수 없습니다.
 */
export function selectWorkUnitsForStageA<TCommit extends ScorableCommit>(
  units: readonly WorkUnit<TCommit>[],
  maxBytes: number = STAGE_A_MAX_SELECTION_BYTES
): WorkUnitSelection<TCommit> {
  const scored = units.map((unit) => {
    const summary = summarizeWorkUnit(unit);
    const { score, signals } = scoreWorkUnit(unit, summary);
    return {
      unit,
      score,
      signals,
      bytes: Buffer.byteLength(renderWorkUnitSummary(summary), "utf8"),
    };
  });
  const ordered = sortByScoreDescending(scored, ({ score }) => score);

  const selected: SelectedWorkUnit<TCommit>[] = [];
  const excluded: ExcludedWorkUnit<TCommit>[] = [];
  let selectedBytes = 0;
  let budgetExhausted = false;

  for (let index = 0; index < ordered.length; ) {
    const score = ordered[index].score;
    const group: typeof ordered = [];
    while (index < ordered.length && ordered[index].score === score) {
      group.push(ordered[index]);
      index += 1;
    }
    const groupBytes = group.reduce((sum, item) => sum + item.bytes, 0);
    // 묶음 사이마다 줄바꿈 한 글자가 들어갑니다.
    const separators = selected.length + group.length - 1;
    if (!budgetExhausted && selectedBytes + groupBytes + separators <= maxBytes) {
      group.forEach(({ unit, score: itemScore }) => selected.push({ unit, score: itemScore }));
      selectedBytes += groupBytes;
      continue;
    }
    budgetExhausted = true;
    // 아직 아무것도 선택되지 않았을 때만 무리를 쪼개 개별 묶음이 예산에 드는지 봅니다. 이미
    // 무언가 선택됐다면 남은 예산을 채우려 하지 않고 점수 순위 그대로 자릅니다.
    const allowSplit = selected.length === 0;
    for (const { unit, score: itemScore, bytes, signals } of group) {
      if (allowSplit && selectedBytes + bytes + selected.length <= maxBytes) {
        selected.push({ unit, score: itemScore });
        selectedBytes += bytes;
        continue;
      }
      excluded.push({
        unit,
        score: itemScore,
        signals,
        reason: allowSplit ? "over_byte_budget" : "below_score_threshold",
      });
    }
  }

  // 이전에는 selected가 비면 최고 점수 묶음을 무조건 되살렸습니다. 그 묶음이 예산을 넘어
  // over_byte_budget으로 제외됐을 때도 되살려서 excluded에서 지웠고, 결과로 나간 요청이 예산을
  // 넘어 서버가 422로 거부했습니다(Codex 리뷰 P2-2). 위 루프는 예산 안에 드는 묶음이 하나라도
  // 있으면 점수 순으로 이미 그 묶음을 selected에 담았으므로, 이 시점에 selected가 비어 있다는
  // 것은 모든 묶음이 개별적으로 예산을 넘는다는 뜻입니다. 그런 경우는 되살리지 않고 selected를
  // 빈 배열로 둡니다. 입력이 비면 호출부가 Stage A를 부르지 않고 빈 상태를 보여줍니다.

  return {
    selected,
    excluded,
    thresholdScore: selected.length > 0 ? selected[selected.length - 1].score : 0,
    bytes: selectedBytes + Math.max(0, selected.length - 1),
  };
}
