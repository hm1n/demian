import {
  resolveLocalLlm,
  resolveStageBMaxInputCommits,
  resolveStageBMaxTotalPatchChars,
} from "../src/features/experience-candidates/llm-provider";
import { STAGE_A_MODEL } from "../src/features/experience-candidates/stage-a";
import {
  STAGE_B_MAX_INPUT_COMMITS,
  STAGE_B_MAX_TOTAL_PATCH_CHARS,
  STAGE_B_MODEL,
} from "../src/features/experience-candidates/stage-b";

/**
 * 측정 스크립트가 쓰는 유효 설정입니다.
 *
 * `measure-pipeline.ts`에 두지 않고 이 파일로 뽑은 이유는 테스트 때문입니다. 측정 스크립트는
 * 최상단에서 `process.argv`를 읽고 인자가 없으면 `process.exit(1)`을 부르는 CLI라 테스트가
 * import할 수 없습니다. 계산만 여기로 옮기면 스크립트는 호출만 하고 규칙은 테스트가 잡습니다.
 *
 * 이 계산이 틀리면 실행은 정상인데 기록이 실제와 달라집니다. 2026-08-26 PR #68 리뷰에서 실제로
 * 두 번 드러났습니다. `stage-a-chunks`가 `--model`을 로그에 찍으면서 환경변수 모델을 호출했고,
 * payload 보고가 프로덕션 상한으로 크기와 상한 도달을 판정해 실제로 보낸 커밋 4개·12,000자와
 * 다른 수치를 남겼습니다. 측정 기록이 실제와 다르면 그 기록을 근거로 쓴 결정이 전부 흔들립니다.
 */
export interface EffectiveSettings {
  readonly stageAModel: string;
  readonly stageBModel: string;
  readonly maxInputCommits: number;
  readonly maxTotalPatchChars: number;
}

export interface ModelOptions {
  /** `--model=` 플래그 값입니다. */
  readonly stageAModel?: string;
  /** `--stage-b-model=` 플래그 값입니다. */
  readonly stageBModel?: string;
}

/**
 * 모델 우선순위는 환경변수, 플래그, 프로덕션 상수 순서입니다.
 *
 * 로컬 전환에서는 `llm-provider.ts`가 환경변수 모델로 제공자를 만들기 때문에 플래그를 앞세우면
 * 호출한 모델과 기록한 모델이 갈립니다. 플래그는 프로덕션 제공자로 후보 모델을 비교할 때만
 * 유효합니다.
 */
export function resolveEffectiveSettings(options: ModelOptions = {}): EffectiveSettings {
  const local = resolveLocalLlm();
  return {
    stageAModel: local?.stageAModel ?? options.stageAModel ?? STAGE_A_MODEL,
    stageBModel: local?.stageBModel ?? options.stageBModel ?? STAGE_B_MODEL,
    maxInputCommits: resolveStageBMaxInputCommits(STAGE_B_MAX_INPUT_COMMITS),
    maxTotalPatchChars: resolveStageBMaxTotalPatchChars(STAGE_B_MAX_TOTAL_PATCH_CHARS),
  };
}
