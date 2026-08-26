import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveSettings } from "./effective-settings";
import { STAGE_A_MODEL } from "../src/features/experience-candidates/stage-a";
import {
  STAGE_B_MAX_INPUT_COMMITS,
  STAGE_B_MAX_TOTAL_PATCH_CHARS,
  STAGE_B_MODEL,
} from "../src/features/experience-candidates/stage-b";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("측정 스크립트 유효 설정", () => {
  it("스위치가 없으면 플래그가 모델을 정하고 상한은 프로덕션 값이다", () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS", "4");

    const settings = resolveEffectiveSettings({
      stageAModel: "openai/gpt-oss-20b",
      stageBModel: "gemini-3.5-flash-lite",
    });

    expect(settings).toEqual({
      stageAModel: "openai/gpt-oss-20b",
      stageBModel: "gemini-3.5-flash-lite",
      maxInputCommits: STAGE_B_MAX_INPUT_COMMITS,
      maxTotalPatchChars: STAGE_B_MAX_TOTAL_PATCH_CHARS,
    });
  });

  it("플래그도 스위치도 없으면 프로덕션 모델을 쓴다", () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", undefined);

    const settings = resolveEffectiveSettings();

    expect(settings.stageAModel).toBe(STAGE_A_MODEL);
    expect(settings.stageBModel).toBe(STAGE_B_MODEL);
  });

  /**
   * 이 테스트가 PR #68 리뷰에서 두 번 나온 결함을 잡습니다. 로컬 전환에서는 `llm-provider.ts`가
   * 환경변수 모델로 제공자를 만들기 때문에, 플래그를 기록하면 호출한 모델과 기록한 모델이
   * 갈립니다.
   */
  it("스위치가 있으면 플래그를 무시하고 환경변수 모델을 기록한다", () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("STAGE_A_MODEL", "qwen2.5:7b");
    vi.stubEnv("STAGE_B_MODEL", "qwen2.5:7b");

    const settings = resolveEffectiveSettings({
      stageAModel: "openai/gpt-oss-20b",
      stageBModel: "gemini-3.5-flash-lite",
    });

    expect(settings.stageAModel).toBe("qwen2.5:7b");
    expect(settings.stageBModel).toBe("qwen2.5:7b");
  });

  it("스위치가 있으면 축소된 상한을 기록한다", () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS", "4");
    vi.stubEnv("NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS", "12000");

    const settings = resolveEffectiveSettings();

    expect(settings.maxInputCommits).toBe(4);
    expect(settings.maxTotalPatchChars).toBe(12_000);
  });

  // 로컬 전환이라도 모델 환경변수를 빠뜨리면 플래그가 살아 있어야 합니다. 제공자 생성은
  // `llm-provider.ts`가 설정 오류로 끊으므로 기록이 앞서 거짓말하지 않게만 맞춥니다.
  it("스위치가 있고 모델 환경변수가 없으면 플래그를 기록한다", () => {
    vi.stubEnv("NEXT_PUBLIC_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("STAGE_A_MODEL", undefined);
    vi.stubEnv("STAGE_B_MODEL", undefined);

    const settings = resolveEffectiveSettings({ stageAModel: "qwen2.5:7b" });

    expect(settings.stageAModel).toBe("qwen2.5:7b");
    expect(settings.stageBModel).toBe(STAGE_B_MODEL);
  });
});
