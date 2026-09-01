import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceCandidateOutputError } from "./errors";
import {
  createStageAModel,
  createStageBModel,
  isLocalLlm,
  resolveLocalLlm,
  localSamplingOptions,
  resolveLlmTimeoutMs,
  resolveStageBMaxInputCommits,
  resolveStageBMaxTotalPatchChars,
} from "./llm-provider";

// 제공자 생성에 넘긴 설정을 그대로 되돌려 받기 위한 모킹입니다. 실제 SDK는 설정을 감춰 두므로
// `baseURL`과 `apiKey`가 실제로 전달됐는지 확인할 방법이 없습니다.
vi.mock("@ai-sdk/groq", () => ({
  createGroq: (options?: unknown) => (modelId: string) => ({ provider: "groq", options, modelId }),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogle: (options?: unknown) => (modelId: string) => ({ provider: "google", options, modelId }),
}));

interface FakeModel {
  readonly provider: string;
  readonly options?: { readonly baseURL?: string; readonly apiKey?: string };
  readonly modelId: string;
}

const asFake = (model: unknown) => model as unknown as FakeModel;

function stubLocal(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("환경변수 미설정", () => {
  // 프로덕션 기본 동작 불변이 이슈 #66의 제약입니다. 이 테스트가 그 회귀를 잡습니다.
  it("Stage A와 Stage B 모두 Google 경로를 그대로 탄다", () => {
    stubLocal({ NEXT_PUBLIC_LLM_BASE_URL: undefined, LLM_API_KEY: undefined });

    const stageA = asFake(createStageAModel("gemini-3.1-flash-lite"));
    const stageB = asFake(createStageBModel("gemini-3.5-flash-lite"));

    expect(resolveLocalLlm()).toBeNull();
    expect(isLocalLlm()).toBe(false);
    expect(stageA).toMatchObject({ provider: "google", modelId: "gemini-3.1-flash-lite" });
    expect(stageA.options).toBeUndefined();
    expect(stageB).toMatchObject({ provider: "google", modelId: "gemini-3.5-flash-lite" });
    expect(stageB.options).toBeUndefined();
  });

  // 모델 환경변수만으로 프로덕션 모델이 바뀌면 사용자 실행 경로가 로컬 사정에 끌려갑니다.
  it("모델 환경변수만 설정해도 프로덕션 모델을 바꾸지 않는다", () => {
    stubLocal({ NEXT_PUBLIC_LLM_BASE_URL: undefined, STAGE_A_MODEL: "qwen2.5:7b", STAGE_B_MODEL: "qwen2.5:7b" });

    expect(asFake(createStageAModel("openai/gpt-oss-120b")).modelId).toBe("openai/gpt-oss-120b");
    expect(asFake(createStageBModel("gemini-3.7-flash")).modelId).toBe("gemini-3.7-flash");
  });

  it("빈 문자열은 미설정으로 본다", () => {
    stubLocal({ NEXT_PUBLIC_LLM_BASE_URL: "   " });

    expect(isLocalLlm()).toBe(false);
    expect(asFake(createStageAModel("gemini-3.1-flash-lite")).provider).toBe("google");
  });
});

describe("NEXT_PUBLIC_LLM_BASE_URL 설정", () => {
  it("두 단계 모두 OpenAI 호환 경로로 같은 baseURL을 탄다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_API_KEY: "ollama",
      STAGE_A_MODEL: "qwen2.5:7b",
      STAGE_B_MODEL: "qwen2.5:7b",
    });

    const stageA = asFake(createStageAModel("gemini-3.1-flash-lite"));
    const stageB = asFake(createStageBModel("gemini-3.5-flash-lite"));

    expect(isLocalLlm()).toBe(true);
    // Gemini API는 OpenAI 호환이 아니므로 Stage B도 로컬에서는 Groq 제공자를 통해 같은 경로를 탑니다.
    expect(stageA).toMatchObject({ provider: "groq", modelId: "qwen2.5:7b" });
    expect(stageB).toMatchObject({ provider: "groq", modelId: "qwen2.5:7b" });
    for (const model of [stageA, stageB]) {
      expect(model.options).toEqual({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
    }
  });

  it("LLM_API_KEY가 없으면 자리값을 채운다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_API_KEY: undefined,
      STAGE_A_MODEL: "qwen2.5:7b",
    });

    expect(asFake(createStageAModel("openai/gpt-oss-120b")).options?.apiKey).toBe("ollama");
  });

  // 모델 환경변수를 빠뜨리면 프로덕션 모델 ID가 로컬 엔드포인트로 나가 404가 되고, 그 404는
  // 모델 설정 오류로 뭉개져 원인이 환경변수 누락이라는 사실이 드러나지 않습니다.
  it("모델 환경변수가 없으면 설정 오류로 먼저 끊는다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      STAGE_A_MODEL: undefined,
      STAGE_B_MODEL: undefined,
    });

    for (const [create, envName, model] of [
      [createStageAModel, "STAGE_A_MODEL", "openai/gpt-oss-120b"],
      [createStageBModel, "STAGE_B_MODEL", "gemini-3.7-flash"],
    ] as const) {
      let caught: unknown;
      try {
        create(model);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExperienceCandidateOutputError);
      expect((caught as ExperienceCandidateOutputError).kind).toBe("llm_configuration");
      expect((caught as ExperienceCandidateOutputError).message).toContain(envName);
    }
  });

  it("한쪽 모델만 빠지면 그 단계에서만 설정 오류가 난다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      STAGE_A_MODEL: "qwen2.5:7b",
      STAGE_B_MODEL: undefined,
    });

    expect(asFake(createStageAModel("openai/gpt-oss-120b")).modelId).toBe("qwen2.5:7b");
    expect(() => createStageBModel("gemini-3.7-flash")).toThrow(ExperienceCandidateOutputError);
  });
});

describe("Stage B 입력 축소값", () => {
  it("환경변수가 없으면 프로덕션 예산을 그대로 쓴다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: undefined,
      NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS: undefined,
    });

    expect(resolveStageBMaxInputCommits(30)).toBe(30);
    expect(resolveStageBMaxTotalPatchChars(60_000)).toBe(60_000);
  });

  it("설정하면 그 값으로 줄인다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: "8",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS: "12000",
    });

    expect(resolveStageBMaxInputCommits(30)).toBe(8);
    expect(resolveStageBMaxTotalPatchChars(60_000)).toBe(12_000);
  });

  // 프로덕션 예산은 이슈 #19 실측에 묶여 있습니다. 환경변수가 그 예산을 늘리는 경로를 막습니다.
  it("프로덕션 예산보다 크게는 만들지 못한다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: "300",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS: "600000",
    });

    expect(resolveStageBMaxInputCommits(30)).toBe(30);
    expect(resolveStageBMaxTotalPatchChars(60_000)).toBe(60_000);
  });

  /**
   * 축소값을 남겨 둔 채 스위치만 끄는 경우가 프로덕션 확인 절차입니다. 이때 게이트가 없으면
   * 프로덕션 Stage B가 시연용 축소 입력을 그대로 받아 커밋 30개가 4개로 줄어듭니다.
   */
  it("스위치를 끄면 축소값이 남아 있어도 프로덕션 예산을 쓴다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: undefined,
      NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: "4",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS: "12000",
    });

    expect(isLocalLlm()).toBe(false);
    expect(resolveStageBMaxInputCommits(30)).toBe(30);
    expect(resolveStageBMaxTotalPatchChars(60_000)).toBe(60_000);
  });

  it("스위치를 켜면 같은 축소값이 적용된다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: "4",
      NEXT_PUBLIC_LLM_STAGE_B_MAX_TOTAL_PATCH_CHARS: "12000",
    });

    expect(resolveStageBMaxInputCommits(30)).toBe(4);
    expect(resolveStageBMaxTotalPatchChars(60_000)).toBe(12_000);
  });

  it("정수가 아니거나 1보다 작으면 무시한다", () => {
    for (const raw of ["0", "-5", "8.5", "여덟", ""]) {
      stubLocal({
        NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
        NEXT_PUBLIC_LLM_STAGE_B_MAX_INPUT_COMMITS: raw,
      });
      expect(resolveStageBMaxInputCommits(30)).toBe(30);
    }
  });
});

describe("로컬 전용 시한과 샘플링", () => {
  it("환경변수가 없으면 프로덕션 시한과 제공자 기본 샘플링을 쓴다", () => {
    stubLocal({ NEXT_PUBLIC_LLM_BASE_URL: undefined, LLM_TIMEOUT_MS: "1000", LLM_TEMPERATURE: "0" });

    // 로컬 전환이 아니면 두 값 모두 무시합니다. 프로덕션 시한은 이슈 #19 실측에 묶여 있습니다.
    expect(resolveLlmTimeoutMs(55_000)).toBe(55_000);
    expect(localSamplingOptions()).toEqual({});
  });

  it("로컬 전환이면 시한과 온도를 적용한다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_TIMEOUT_MS: "300000",
      LLM_TEMPERATURE: "0",
    });

    expect(resolveLlmTimeoutMs(55_000)).toBe(300_000);
    expect(localSamplingOptions()).toEqual({ temperature: 0 });
  });

  it("값이 없거나 숫자가 아니면 무시한다", () => {
    stubLocal({
      NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_TIMEOUT_MS: "빠르게",
      LLM_TEMPERATURE: undefined,
    });

    expect(resolveLlmTimeoutMs(55_000)).toBe(55_000);
    expect(localSamplingOptions()).toEqual({});
  });

  // `Number("")`는 0이고 0은 유효한 온도입니다. 빈 값을 걸러내지 않으면 값을 지운 환경변수가
  // 온도를 0으로 고정한 설정과 구별되지 않습니다.
  it("온도를 빈 문자열로 두면 제공자 기본 샘플링을 쓴다", () => {
    stubLocal({ NEXT_PUBLIC_LLM_BASE_URL: "http://localhost:11434/v1", LLM_TEMPERATURE: "  " });

    expect(localSamplingOptions()).toEqual({});
  });
});
