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
 * **2026-09-01에 10,500에서 20,000으로 올렸습니다.**
 *
 * 10,500의 근거는 Groq 무료 등급의 분당 토큰 한도(TPM) 8,000이었습니다. 프롬프트 5,842바이트가
 * 총 3,949토큰이었고(입력·출력·추론 합계) 바이트당 0.676토큰이 관측 최대치라, 10,500바이트면 약
 * 7,100토큰으로 한도 대비 11퍼센트가 남는다는 계산이었습니다.
 *
 * 제공자를 Gemini로 옮기면서 그 벽이 사라졌습니다. 유료 등급은 분당 입력 4,000,000토큰이고 모델
 * 컨텍스트도 이 단계 입력과 비교할 크기가 아닙니다. 벽에서 나온 값이므로 벽과 함께 재산정합니다.
 * 근거 스냅샷 상한을 3,500에서 5,250으로 올린 것과 같은 이유이며, 그때 이 값이 빠졌습니다.
 *
 * 남겨 두면 지는 대가가 있습니다. `hm1n/demian`은 작업 묶음이 27개인데 10,500바이트에서는 12개만
 * 실리고 **15개가 `over_byte_budget`으로 제외됩니다.** 그 사유는 화면에 "한 번에 보낼 수 있는
 * 분량을 넘어 제외했습니다"로 나가는데, Gemini에서는 사실이 아닌 설명입니다.
 *
 * 새 값의 근거는 실측입니다(2026-09-01, `llm-wiki/raw/2026-09-01-Stage-A-입력-예산-재산정.md`).
 * 27묶음 전량은 프롬프트 17,343바이트이고, 같은 입력 5회에서 전수 응답 계약이 5회 모두
 * `27/27`이었으며 소요는 2,902~3,590밀리초로 예산 55초의 5.3~6.5퍼센트였습니다. 20,000은 그
 * 17,343 위에 15퍼센트를 얹은 값입니다.
 *
 * 이 상한이 담는 묶음 수의 천장은 재지 못했습니다. 측정에 쓴 저장소가 27묶음이라 그 위에서 전수
 * 응답 계약이 어디서 깨지는지 모릅니다. Groq 시절 `andbread` 66묶음에서 첫 시도 계약 준수가
 * 33퍼센트였던 기록이 있으므로 개수가 늘면 깨진다고 보고, 개수 상한
 * (`STAGE_A_CHUNK_MAX_UNITS`)을 함께 둡니다. 이 상한을 더 올리려면 묶음이 더 많은 저장소로 계약
 * 준수를 먼저 재야 합니다.
 */
export const STAGE_A_MAX_SELECTION_BYTES = 20_000;

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
