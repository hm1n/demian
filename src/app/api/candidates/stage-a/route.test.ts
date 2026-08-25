import { STAGE_A_CHUNK_MAX_BYTES } from "@/features/experience-candidates/stage-a";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptGitHubToken,
  GITHUB_SESSION_COOKIE,
  GITHUB_SESSION_KEY_ENV,
} from "@/lib/github/auth-session";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import { handleStageA, MAX_STAGE_A_BODY_BYTES } from "./route";

function unit(pullRequestNumber: number, representativeSha: string) {
  return {
    pullRequestNumber,
    representativeSha,
    summary: {
      pullRequestNumber,
      pullRequestTitle: "경량 입력",
      commitCount: 1,
      spanDays: 1,
      additions: 1,
      deletions: 0,
      commitTitles: ["feat: 경량 입력"],
      changedFilePathCount: 1,
      topFilePaths: ["src/a.ts"],
    },
  };
}

const SHA = "a".repeat(40);
const SHA_2 = "b".repeat(40);
const SHA_3 = "c".repeat(40);
const body = { units: [unit(1, SHA)], contributionItems: [], candidateLimit: 1 };

function request(value: unknown, authenticated = true) {
  return new NextRequest("https://example.com/api/candidates/stage-a", {
    method: "POST",
    headers: authenticated
      ? { cookie: `${GITHUB_SESSION_COOKIE}=${encryptGitHubToken("token")}` }
      : undefined,
    body: JSON.stringify(value),
  });
}

beforeEach(() => {
  process.env[GITHUB_SESSION_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  delete process.env[GITHUB_SESSION_KEY_ENV];
  vi.useRealTimers();
});

describe("POST /api/candidates/stage-a", () => {
  it("세션 쿠키가 없으면 LLM을 호출하지 않고 거부한다", async () => {
    let called = false;
    const response = await handleStageA(request(body, false), async () => {
      called = true;
      return { decisions: [] };
    });
    expect(response.status).toBe(401);
    expect(called).toBe(false);
    expect(await response.json()).toMatchObject({ error: { kind: "unauthorized" } });
  });

  it("성공 응답은 Stage A 계약만 반환한다", async () => {
    const response = await handleStageA(request(body), async () => ({
      decisions: [{ pullRequestNumber: 1, contributionItem: null, recommended: false }],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candidates: [], unclassifiedShas: [SHA], unjudgedShas: [], rateLimit: null,
    });
  });

  it("잘못된 JSON, 입력 계약, 4.5MB 초과를 서로 다른 요청 오류로 거부한다", async () => {
    const malformed = request(body);
    Object.defineProperty(malformed, "text", { value: async () => "{" });
    const invalidJson = await handleStageA(malformed);
    const invalidRequest = await handleStageA(request({ contributionItems: [] }));
    const tooLarge = request(body);
    tooLarge.headers.set("content-length", String(MAX_STAGE_A_BODY_BYTES + 1));
    const oversized = await handleStageA(tooLarge);

    expect(invalidJson.status).toBe(400);
    expect(invalidRequest.status).toBe(422);
    expect(oversized.status).toBe(413);
  });

  it("요약에 없는 필드를 덧붙인 요청은 계약 위반 422로 거부한다", async () => {
    const tainted = unit(1, SHA);
    const response = await handleStageA(request({
      units: [{ ...tainted, summary: { ...tainted.summary, patch: "x".repeat(1024 * 1024) } }],
      contributionItems: [],
      candidateLimit: 1,
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("프롬프트 상한을 넘는 요약은 LLM 호출 전에 422로 거부한다", async () => {
    const generate = vi.fn();
    const long = unit(1, SHA);
    const response = await handleStageA(request({
      units: [{ ...long, summary: { ...long.summary, commitTitles: ["x".repeat(STAGE_A_CHUNK_MAX_BYTES + 500)] } }],
      contributionItems: [],
      candidateLimit: 1,
    }), generate);
    expect(response.status).toBe(422);
    expect(generate).not.toHaveBeenCalled();
  });

  it("접힌 묶음 요약만 모델에 전달한다", async () => {
    let received: unknown;
    const response = await handleStageA(request(body), async (payload) => {
      received = payload;
      return { decisions: [{ pullRequestNumber: 1, contributionItem: null, recommended: false }] };
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(received)).not.toContain("patch");
    expect((received as { units: { summary: string }[] }).units[0].summary)
      .toContain("PR#1 경량 입력 [1커밋 1일 +1-0 1파일]");
  });

  it("묶음 수 상한을 넘는 단일 청크는 LLM 호출 전에 422로 거부한다", async () => {
    const generate = vi.fn();
    const response = await handleStageA(request({
      units: Array.from({ length: 21 }, (_, index) =>
        unit(index + 1, String(index).padStart(40, "0"))
      ),
      contributionItems: [],
      candidateLimit: 2,
    }), generate);
    expect(response.status).toBe(422);
    expect(generate).not.toHaveBeenCalled();
  });

  it("쿼터가 묶음 수보다 크면 LLM 호출 전에 422로 거부한다", async () => {
    const generate = vi.fn();
    const response = await handleStageA(request({
      units: [unit(1, SHA)], contributionItems: [], candidateLimit: 2,
    }), generate);
    expect(response.status).toBe(422);
    expect(generate).not.toHaveBeenCalled();
  });

  it("누락된 묶음만 최대 2회 축소 재호출해 전수 계약을 복구한다", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ decisions: [
        { pullRequestNumber: 1, contributionItem: null, recommended: false },
      ] })
      .mockResolvedValueOnce({ decisions: [
        { pullRequestNumber: 2, contributionItem: null, recommended: false },
      ] });

    const response = await handleStageA(request({
      units: [unit(1, SHA), unit(2, SHA_2)], contributionItems: [], candidateLimit: 2,
    }), generate);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].units.map(
      ({ pullRequestNumber }: { pullRequestNumber: number }) => pullRequestNumber
    )).toEqual([2]);
    expect(await response.json()).toMatchObject({ unclassifiedShas: [SHA, SHA_2] });
  });

  it("부분 응답과 복구 응답을 합칠 때 요청 상한을 넘지 않는다", async () => {
    // 복구에 넘기는 상한에 최소 1의 바닥이 있어 부분 응답이 이미 상한을 채워도 하나가 더 얹힙니다.
    // 실측에서 상한 5에 후보 6개, 상한 2에 후보 3개가 나왔습니다.
    const threeUnits = {
      units: [unit(1, SHA), unit(2, SHA_2), unit(3, SHA_3)],
      contributionItems: [],
      candidateLimit: 1,
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ decisions: [{ pullRequestNumber: 1, contributionItem: null, recommended: true }] })
      .mockResolvedValue({ decisions: [
        { pullRequestNumber: 2, contributionItem: null, recommended: true },
        { pullRequestNumber: 3, contributionItem: null, recommended: true },
      ] });

    const response = await handleStageA(request(threeUnits), generate);
    const output = await response.json();

    expect(response.status).toBe(200);
    expect(output.candidates).toHaveLength(1);
    // 잘린 후보는 버리지 않고 미분류로 내립니다. 셋 다 어딘가에는 남아야 합니다.
    expect([
      ...output.candidates.map(({ sha }: { sha: string }) => sha),
      ...output.unclassifiedShas,
      ...output.unjudgedShas,
    ].sort()).toEqual([SHA, SHA_2, SHA_3].sort());
  });

  it("상한을 넘으면 기여 항목에 맞은 후보를 먼저 남긴다", async () => {
    const twoUnits = {
      units: [unit(1, SHA), unit(2, SHA_2)],
      contributionItems: ["결제 연동"],
      candidateLimit: 1,
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ decisions: [{ pullRequestNumber: 1, contributionItem: null, recommended: true }] })
      .mockResolvedValue({ decisions: [
        { pullRequestNumber: 2, contributionItem: "결제 연동", recommended: true },
      ] });

    const response = await handleStageA(request(twoUnits), generate);
    const output = await response.json();

    expect(output.candidates).toEqual([
      { sha: SHA_2, source: "contribution_match", contributionItem: "결제 연동" },
    ]);
    expect(output.unclassifiedShas).toContain(SHA);
  });

  it("복구 호출이 제공자 오류로 죽어도 이미 받은 부분 응답을 살린다", async () => {
    // 실측에서 모델이 스키마를 못 맞춰 제공자가 400을 돌려주는 경우가 간헐적으로 있었고,
    // 그때마다 정상 판단된 묶음까지 함께 버려졌습니다.
    const twoUnits = {
      units: [unit(1, SHA), unit(2, SHA_2)],
      contributionItems: [],
      candidateLimit: 2,
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ decisions: [{ pullRequestNumber: 1, contributionItem: null, recommended: true }] })
      .mockRejectedValue(new ExperienceCandidateOutputError("llm_request", "LLM이 요청을 거부했습니다."));

    const response = await handleStageA(request(twoUnits), generate);
    const output = await response.json();

    expect(response.status).toBe(200);
    expect(output.candidates).toEqual([
      { sha: SHA, source: "automatic_recommendation", contributionItem: null },
    ]);
    expect(output.unjudgedShas).toEqual([SHA_2]);
  });

  it("세 번 판단하지 못한 묶음은 실패가 아니라 판단 불가로 돌려준다", async () => {
    // 예외를 던지면 같은 응답에 담긴 정상 판단 묶음까지 함께 버려집니다. andbread 실측에서
    // 청크 하나가 복구를 소진하자 이미 끝난 다섯 청크의 결과가 전부 사라졌습니다.
    const generate = vi.fn().mockResolvedValue({ decisions: [] });
    const response = await handleStageA(request(body), generate);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await response.json()).toEqual({
      candidates: [], unclassifiedShas: [], unjudgedShas: [SHA], rateLimit: null,
    });
  });

  it.each([
    ["schema_validation", 502],
    ["unknown_sha", 502],
    ["llm_network", 502],
    ["llm_auth", 502],
    ["llm_rate_limit", 503],
    ["llm_timeout", 504],
    ["llm_configuration", 500],
    ["llm_request", 502],
    ["llm_failure", 502],
  ] as const)("%s 오류를 HTTP %i로 매핑한다", async (kind, status) => {
    const response = await handleStageA(request(body), async () => {
      throw new ExperienceCandidateOutputError(kind, "safe message");
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { kind, message: "safe message" } });
  });

  it("Groq 시한 중단을 JSON llm_timeout 504로 반환한다", async () => {
    vi.useFakeTimers();
    const responsePromise = handleStageA(
      request(body),
      async (_payload, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      10
    );
    await vi.advanceTimersByTimeAsync(10);
    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { kind: "llm_timeout" } });
  });
});
