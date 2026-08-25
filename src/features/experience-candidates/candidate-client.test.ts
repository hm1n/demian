import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandidateRequestError,
  fetchStageACandidatesFromApi,
  fetchStageBCandidatesFromApi,
  toStageARequest,
  toStageAUnits,
  splitUnitsIntoChunks,
  expandCandidatesToCommits,
} from "./candidate-client";
import {
  buildStageAPayload,
  renderStageAPrompt,
  STAGE_A_CHUNK_MAX_BYTES,
  STAGE_A_CHUNK_MAX_REQUEST_BYTES,
  STAGE_A_DEGRADED_WAIT_MS,
} from "./stage-a";
import type { StageACandidate } from "./types";
import type { ReadonlyCommitDetail } from "@/lib/github/types";

const COMMIT: ReadonlyCommitDetail = {
  sha: "sha-1",
  title: "feat: add analysis",
  author: "octocat",
  date: "2026-08-20T00:00:00Z",
  parentCount: 1,
  message: "feat: add analysis",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  files: [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 2, changes: 12, patch: "@@ -1 +1 @@" }],
  pullRequests: [{ number: 7, title: "PR", state: "merged", url: "https://example.test", baseBranch: "main", headBranch: "feat" }],
};

const STAGE_A_CANDIDATE: StageACandidate = {
  sha: "sha-1",
  source: "contribution_match",
  contributionItem: "푸시 알림 구현",
};

const REPOSITORY = { owner: "octocat", repo: "hello-world" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function expectRequestError(promise: Promise<unknown>, expected: Partial<CandidateRequestError>) {
  const error = await promise.then(
    () => {
      throw new Error("오류가 발생해야 합니다.");
    },
    (thrown) => thrown as unknown
  );
  expect(error).toBeInstanceOf(CandidateRequestError);
  expect(error).toMatchObject(expected);
}

type StageARequestBody = {
  units: { pullRequestNumber: number; representativeSha: string }[];
  candidateLimit: number;
};

function parseRequest(init: RequestInit | undefined): StageARequestBody {
  return JSON.parse(String(init?.body)) as StageARequestBody;
}

/** 커밋마다 서로 다른 PR을 붙여 묶음 하나에 커밋 하나가 되게 합니다. */
function manyUnits(count: number): ReadonlyCommitDetail[] {
  return Array.from({ length: count }, (_, index) => ({
    ...COMMIT,
    sha: `sha-${index}`,
    pullRequests: [{ ...COMMIT.pullRequests[0], number: index + 1 }],
  }));
}

/** 서버가 실제로 재는 프롬프트 바이트입니다. 라우트와 같은 함수를 씁니다. */
function promptBytesOf(
  commits: readonly ReadonlyCommitDetail[],
  contributionItems: readonly string[]
): number {
  const units = toStageAUnits(commits, contributionItems).units;
  return new TextEncoder().encode(
    renderStageAPrompt(buildStageAPayload(toStageARequest(units, contributionItems, 1)))
  ).byteLength;
}

/**
 * 프롬프트 상한에서 `room` 바이트만 남기는 한국어 기여 항목을 만듭니다.
 *
 * 한글 한 글자가 UTF-8 3바이트입니다. 기여 항목 머리글과 문단 구분 몫으로 넉넉히 32바이트를
 * 뺍니다. 정확한 경계가 아니라 "예산을 거의 다 먹는다"는 조건만 필요합니다.
 */
function itemFillingBudgetExcept(room: number): string {
  return "가".repeat(Math.max(1, Math.floor((STAGE_A_CHUNK_MAX_BYTES - room - 32) / 3)));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toStageAUnits", () => {
  it("PR 묶음으로 접고 patch와 커밋 본문을 남기지 않는다", () => {
    const { units, excludedCommits } = toStageAUnits([COMMIT]);

    expect(excludedCommits).toEqual([]);
    expect(units).toHaveLength(1);
    expect(units[0].pullRequestNumber).toBe(7);
    expect(units[0].representativeSha).toBe("sha-1");
    expect(JSON.stringify(units)).not.toContain("patch");
    expect(JSON.stringify(units)).not.toContain("\\n");
  });

  it("기여 항목 몫을 선별 예산에서 미리 뺀다", () => {
    // 빼지 않으면 선별이 요약만으로 상한을 꽉 채우고, 그 뒤 기여 항목이 얹혀 라우트가 422로
    // 거부합니다. 묶음을 덜 보내고 한 번에 끝내는 쪽이 청크를 늘리는 쪽보다 낫습니다.
    // 분당 토큰 한도는 청크를 나눠도 합계에 걸립니다.
    const commits = manyUnits(20);
    // 기여 항목 길이를 픽스처 실측에서 유도합니다. 고정 숫자를 쓰면 픽스처가 바뀔 때 조용히
    // 무의미한 테스트가 됩니다. 전체 요약의 절반만 들어갈 예산을 남깁니다.
    const longItem = itemFillingBudgetExcept(Math.floor(promptBytesOf(commits, []) / 2));

    const withoutItems = toStageAUnits(commits, []);
    const withItems = toStageAUnits(commits, [longItem]);

    expect(withItems.units.length).toBeLessThan(withoutItems.units.length);
    // 빠진 묶음은 조용히 사라지지 않고 분량 초과 사유로 남습니다.
    expect(withItems.excludedUnits.some(({ reason }) => reason === "over_byte_budget")).toBe(true);
    // 선별 결과가 서버 프롬프트 상한 안에 들어갑니다.
    const bytes = new TextEncoder().encode(
      renderStageAPrompt(buildStageAPayload(toStageARequest(withItems.units, [longItem], 1)))
    ).byteLength;
    expect(bytes).toBeLessThanOrEqual(STAGE_A_CHUNK_MAX_BYTES);
  });

  it("PR에 속하지 않은 커밋을 사유와 함께 제외한다", () => {
    const { units, excludedCommits } = toStageAUnits([{ ...COMMIT, pullRequests: [] }]);

    expect(units).toEqual([]);
    expect(excludedCommits).toEqual([
      { sha: "sha-1", title: COMMIT.title, reason: "no_pull_request" },
    ]);
  });
});

describe("expandCandidatesToCommits", () => {
  /** 묶음 하나에 커밋 여러 개를 붙입니다. */
  function unitCommits(pullRequestNumber: number, count: number): ReadonlyCommitDetail[] {
    return Array.from({ length: count }, (_, index) => ({
      ...COMMIT,
      sha: `pr${pullRequestNumber}-c${index}`,
      files: [{ ...COMMIT.files[0], changes: 100 - index }],
      pullRequests: [{ ...COMMIT.pullRequests[0], number: pullRequestNumber }],
    }));
  }

  it("후보 묶음의 커밋을 대표 하나가 아니라 여러 개로 펼친다", () => {
    const { workUnits, units } = toStageAUnits(unitCommits(1, 5));
    const candidates = [
      { sha: units[0].representativeSha, source: "automatic_recommendation" as const, contributionItem: null },
    ];

    const expanded = expandCandidatesToCommits(candidates, workUnits, 30);

    expect(expanded).toHaveLength(5);
    expect(expanded[0].sha).toBe(units[0].representativeSha);
  });

  it("펼친 커밋이 묶음의 출처와 기여 항목을 물려받는다", () => {
    const { workUnits, units } = toStageAUnits(unitCommits(1, 3));
    const candidates = [
      { sha: units[0].representativeSha, source: "contribution_match" as const, contributionItem: "푸시 알림 구현" },
    ];

    const expanded = expandCandidatesToCommits(candidates, workUnits, 30);

    expect(expanded.every((c) => c.source === "contribution_match")).toBe(true);
    expect(expanded.every((c) => c.contributionItem === "푸시 알림 구현")).toBe(true);
  });

  it("상한을 넘기지 않고 묶음마다 최소 한 개는 남긴다", () => {
    const commits = [...unitCommits(1, 21), ...unitCommits(2, 18), ...unitCommits(3, 2)];
    const { workUnits, units } = toStageAUnits(commits);
    const candidates = units.map(({ representativeSha }) => ({
      sha: representativeSha, source: "automatic_recommendation" as const, contributionItem: null,
    }));

    const expanded = expandCandidatesToCommits(candidates, workUnits, 10);

    expect(expanded).toHaveLength(10);
    for (const { representativeSha } of units) {
      expect(expanded.some(({ sha }) => sha === representativeSha)).toBe(true);
    }
  });

  it("후보가 아닌 묶음의 커밋은 넣지 않는다", () => {
    const commits = [...unitCommits(1, 3), ...unitCommits(2, 3)];
    const { workUnits, units } = toStageAUnits(commits);
    const candidates = [
      { sha: units[0].representativeSha, source: "automatic_recommendation" as const, contributionItem: null },
    ];

    const expanded = expandCandidatesToCommits(candidates, workUnits, 30);

    expect(expanded.every(({ sha }) => sha.startsWith("pr1-"))).toBe(true);
  });

  it("SHA가 어느 묶음에도 없으면 조용히 버리지 않고 건너뛴다", () => {
    const { workUnits } = toStageAUnits(unitCommits(1, 3));

    const expanded = expandCandidatesToCommits(
      [{ sha: "없는sha", source: "automatic_recommendation", contributionItem: null }],
      workUnits,
      30
    );

    expect(expanded).toEqual([]);
  });
});

describe("fetchStageACandidatesFromApi", () => {
  it("검증한 Stage A 응답을 반환한다", async () => {
    const output = {
      candidates: [STAGE_A_CANDIDATE],
      unclassifiedShas: ["sha-2"],
      unjudgedShas: [],
      rateLimit: null,
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(output));

    await expect(fetchStageACandidatesFromApi([COMMIT], ["푸시 알림 구현"])).resolves.toEqual({
      candidates: output.candidates,
      unclassifiedShas: output.unclassifiedShas,
      unjudgedShas: [],
      excludedCommits: [],
      excludedUnits: [],
      thresholdScore: 0,
    });
    expect(fetch).toHaveBeenCalledWith("/api/candidates/stage-a", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(toStageARequest(toStageAUnits([COMMIT]).units, ["푸시 알림 구현"], 1)),
    }));
  });

  it("후보 묶음을 Stage B 입력 커밋으로 펼쳐서 반환한다", async () => {
    // 커밋 4개가 한 PR에 묶입니다. Stage A는 묶음 하나를 후보로 돌려주지만 결과에는 커밋 4개가
    // 모두 실려야 합니다. 펼치기를 빠뜨리면 대표 커밋 1개만 남습니다.
    const commits = Array.from({ length: 4 }, (_, index) => ({
      ...COMMIT,
      sha: `sha-${index}`,
      files: [{ ...COMMIT.files[0], changes: 100 - index }],
    }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      return jsonResponse({
        candidates: request.units.map(({ representativeSha }) => ({
          sha: representativeSha, source: "automatic_recommendation", contributionItem: null,
        })),
        unclassifiedShas: [],
        unjudgedShas: [],
        rateLimit: null,
      });
    });

    const output = await fetchStageACandidatesFromApi(commits, []);

    expect(output.candidates.map(({ sha }) => sha).sort()).toEqual(
      commits.map(({ sha }) => sha).sort()
    );
  });

  it("오류 응답의 kind와 message를 단계 정보와 함께 보존한다", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { kind: "llm_rate_limit", message: "LLM 호출 한도에 도달했습니다." } }, 503)
    );

    await expectRequestError(fetchStageACandidatesFromApi([COMMIT], []), {
      stage: "stage_a",
      kind: "llm_rate_limit",
      message: "LLM 호출 한도에 도달했습니다.",
    });
  });

  it("알 수 없는 오류 kind는 server_error로 정규화한다", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { kind: "mystery", message: "?" } }, 500));
    await expectRequestError(fetchStageACandidatesFromApi([COMMIT], []), { kind: "server_error" });
  });

  it("전송 실패와 JSON이 아닌 응답을 서버 오류와 구분한다", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    await expectRequestError(fetchStageACandidatesFromApi([COMMIT], []), { kind: "fetch_network" });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expectRequestError(fetchStageACandidatesFromApi([COMMIT], []), { kind: "invalid_response" });
  });

  it("성공 응답의 형식 위반을 invalid_response로 거부한다", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ candidates: [{ sha: 1 }], unclassifiedShas: [], unjudgedShas: [] }));
    await expectRequestError(fetchStageACandidatesFromApi([COMMIT], []), {
      stage: "stage_a",
      kind: "invalid_response",
    });
  });

  it("모든 묶음을 한 번씩 판단하고 재판단 라운드 없이 끝낸다", async () => {
    const commits = manyUnits(25);
    const sent: number[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      sent.push(...request.units.map(({ pullRequestNumber }) => pullRequestNumber));
      const selected = request.units.slice(0, request.candidateLimit);
      return jsonResponse({
        candidates: selected.map(({ representativeSha }) => ({
          sha: representativeSha,
          source: "automatic_recommendation",
          contributionItem: null,
        })),
        unclassifiedShas: request.units.slice(selected.length).map((u) => u.representativeSha),
        unjudgedShas: [],
        rateLimit: { remainingTokens: 0, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    const output = await fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined);

    expect(sent).toEqual(commits.map((_, index) => index + 1));
    expect(new Set(sent).size).toBe(25);
    expect(output.candidates.length).toBeLessThanOrEqual(20);
    // 청크 수만큼만 호출합니다. 재판단 라운드가 있으면 이 값을 넘습니다.
    const chunkCount = splitUnitsIntoChunks(toStageAUnits(commits).units, []).length;
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(chunkCount);
  });

  it("앞 청크가 판단 불가로 저하돼도 뒤 청크를 계속 보낸다", async () => {
    // 라우트가 복구를 소진하면 부분 결과를 rateLimit null로 돌려준다(route.ts의 degrade).
    // 예전에는 이 응답을 응답 형식 오류로 던져서 청크가 여러 개일 때 뒤 청크를 아예 시도하지
    // 않았다. 저하는 이미 처리한 판단을 살리려고 만든 경로인데 그 목적을 스스로 깼다.
    const commits = manyUnits(25);
    const sentChunks: number[][] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      sentChunks.push(request.units.map(({ pullRequestNumber }) => pullRequestNumber));
      const degraded = sentChunks.length === 1;
      return jsonResponse({
        candidates: [],
        unclassifiedShas: degraded ? [] : request.units.map(({ representativeSha }) => representativeSha),
        // 저하의 표식은 판단 불가 묶음이 있다는 것이다.
        unjudgedShas: degraded ? request.units.map(({ representativeSha }) => representativeSha) : [],
        rateLimit: degraded ? null : { remainingTokens: 8_000, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    const waits: number[] = [];
    const output = await fetchStageACandidatesFromApi(
      commits, [], () => undefined, undefined, async (ms) => { waits.push(ms); }
    );

    const chunkCount = splitUnitsIntoChunks(toStageAUnits(commits).units, []).length;
    expect(chunkCount).toBeGreaterThan(1);
    expect(sentChunks).toHaveLength(chunkCount);
    // 저하된 청크의 묶음은 판단 불가로 남고 뒤 청크의 판단은 살아 있다.
    expect(output.unjudgedShas.length).toBeGreaterThan(0);
    expect(output.unclassifiedShas.length).toBeGreaterThan(0);
    // 남은 토큰을 모르므로 한 창을 기다린 뒤 넘어간다.
    expect(waits[0]).toBe(STAGE_A_DEGRADED_WAIT_MS);
  });

  it("한도 메타데이터가 없고 판단 불가도 없으면 응답 형식 오류로 던진다", async () => {
    // 저하가 아니라 정말 형식이 어긋난 응답이다. 이 경우의 기존 방어는 유지해야 한다.
    const commits = manyUnits(25);
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      return jsonResponse({
        candidates: [],
        unclassifiedShas: request.units.map(({ representativeSha }) => representativeSha),
        unjudgedShas: [],
        rateLimit: null,
      });
    });

    await expect(
      fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined)
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("체크포인트가 판단 대상 묶음 수를 함께 싣는다", async () => {
    // 실패 문구가 커밋 수로 분모를 다시 유도하지 않도록 체크포인트가 분모를 들고 다닌다.
    const commits = manyUnits(25);
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { kind: "llm_failure", message: "실패" } }, 502)
    );

    const units = toStageAUnits(commits).units;
    await expect(
      fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined)
    ).rejects.toMatchObject({ checkpoint: { totalUnits: units.length } });
  });

  it("청크마다 쿼터를 보내고 쿼터 합이 전역 상한을 넘지 않는다", async () => {
    const commits = manyUnits(25);
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      return jsonResponse({
        candidates: [],
        unclassifiedShas: request.units.map(({ representativeSha }) => representativeSha),
        unjudgedShas: [],
        rateLimit: { remainingTokens: 8_000, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    await fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined);

    const limits = vi.mocked(fetch).mock.calls.map(([, init]) => parseRequest(init).candidateLimit);
    expect(limits.every((limit) => limit >= 1)).toBe(true);
    expect(limits.reduce((sum, limit) => sum + limit, 0)).toBeLessThanOrEqual(20);
  });

  it("실패 전 완료 청크 체크포인트로 재개해 이미 판단한 묶음을 다시 보내지 않는다", async () => {
    const commits = manyUnits(25);
    const firstChunk = splitUnitsIntoChunks(toStageAUnits(commits).units, [])[0];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        candidates: [],
        unclassifiedShas: firstChunk.map(({ representativeSha }) => representativeSha),
        unjudgedShas: [],
        rateLimit: { remainingTokens: 0, resetAfterMs: 1, usedTokens: 100 },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: { kind: "llm_failure", message: "실패" } }, 502));

    let checkpoint: import("./types").StageACheckpoint | undefined;
    try {
      await fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined);
    } catch (error) {
      checkpoint = (error as CandidateRequestError).checkpoint;
    }
    expect(checkpoint?.processedShas).toHaveLength(firstChunk.length);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      candidates: [], unclassifiedShas: [], unjudgedShas: [], rateLimit: null,
    }));
    await fetchStageACandidatesFromApi(commits, [], () => undefined, checkpoint, async () => undefined);
    const resumed = parseRequest(vi.mocked(fetch).mock.calls[0][1]);
    expect(resumed.units.some(({ representativeSha }) =>
      checkpoint!.processedShas.includes(representativeSha)
    )).toBe(false);
  });

  it("프롬프트 예산을 넘는 묶음은 청크로 쪼개지 않고 선별에서 제외한다", async () => {
    // 점수 선별이 청크 분할보다 먼저 돌고 예산이 같으므로 요청은 항상 한 번입니다.
    const commits = manyUnits(3).map((commit) => ({
      ...commit,
      title: "x".repeat(Math.floor(STAGE_A_CHUNK_MAX_BYTES / 2) - 250),
    }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      return jsonResponse({
        candidates: [],
        unclassifiedShas: request.units.map(({ representativeSha }) => representativeSha),
        unjudgedShas: [],
        rateLimit: { remainingTokens: 8_000, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    const output = await fetchStageACandidatesFromApi(commits, []);

    expect(vi.mocked(fetch).mock.calls.map(([, init]) => parseRequest(init).units.length))
      .toEqual([2]);
    expect(output.unclassifiedShas).toHaveLength(2);
    expect(toStageAUnits(commits).excludedUnits).toHaveLength(1);
    expect(toStageAUnits(commits).excludedUnits[0].reason).toBe("over_byte_budget");
  });
});

describe("splitUnitsIntoChunks", () => {
  it("묶음 수 상한에서 나눈다", () => {
    const units = toStageAUnits(manyUnits(45)).units;

    const chunks = splitUnitsIntoChunks(units, []);

    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.flat().map(({ pullRequestNumber }) => pullRequestNumber))
      .toEqual(units.map(({ pullRequestNumber }) => pullRequestNumber));
  });

  it("묶음이 없으면 청크도 없다", () => {
    expect(splitUnitsIntoChunks([], [])).toEqual([]);
  });

  it("묶음 하나가 혼자서 상한을 넘으면 청크에 조용히 담지 않고 실패시킨다", () => {
    // Codex 리뷰 P2-2 회귀 테스트입니다. selectWorkUnitsForStageA가 예산 안의 묶음만 골라야
    // 하므로 정상 경로에서는 여기 도달하지 않지만, 그 불변조건이 깨지면 조용히 청크에 담아
    // 서버가 422로 거부하게 두는 대신 바로 실패시켜야 합니다.
    const oversized = {
      pullRequestNumber: 1,
      representativeSha: "sha-1",
      summary: {
        pullRequestNumber: 1,
        pullRequestTitle: "x".repeat(STAGE_A_CHUNK_MAX_BYTES + 1),
        commitCount: 1,
        spanDays: 1,
        additions: 1,
        deletions: 0,
        commitTitles: ["feat: 기능 추가"],
        changedFilePathCount: 1,
        topFilePaths: ["src/a.ts"],
      },
    };

    expect(() => splitUnitsIntoChunks([oversized], [])).toThrow();
  });

  it("실패는 재시도해도 같은 결과라 재시도 불가로 표시한다", () => {
    // 평범한 Error로 던지면 generateCandidates가 재시도 지점을 남겨(samePayloadAlwaysFails가
    // CandidateRequestError만 봅니다) 같은 입력으로 반드시 같은 실패를 반복하는 버튼을 줍니다.
    const oversized = {
      pullRequestNumber: 1,
      representativeSha: "sha-1",
      summary: {
        pullRequestNumber: 1,
        pullRequestTitle: "x".repeat(STAGE_A_CHUNK_MAX_BYTES + 1),
        commitCount: 1,
        spanDays: 1,
        additions: 1,
        deletions: 0,
        commitTitles: ["feat: 기능 추가"],
        changedFilePathCount: 1,
        topFilePaths: ["src/a.ts"],
      },
    };

    try {
      splitUnitsIntoChunks([oversized], []);
      throw new Error("실패해야 합니다");
    } catch (error) {
      expect(error).toBeInstanceOf(CandidateRequestError);
      expect((error as CandidateRequestError).kind).toBe("invalid_request");
      expect((error as CandidateRequestError).retryable).toBe(false);
    }
  });

  it("두 번째 이후 묶음이 혼자 상한을 넘어도 잡는다", () => {
    // 예전에는 초과 검사가 current === undefined일 때만 돌아서, 앞 청크에 못 들어가 새 청크의
    // 머리가 되는 묶음은 크기를 다시 재지 않았다. 혼자서 상한을 넘는 묶음이 그대로 라우트에 가서
    // 422를 받았다. 첫 묶음 가드만으로는 부족하다는 것이 Codex 리뷰의 지적이다.
    const small = toStageAUnits([COMMIT]).units[0];
    const oversized = {
      pullRequestNumber: 2,
      representativeSha: "sha-oversized",
      summary: {
        pullRequestNumber: 2,
        pullRequestTitle: "x".repeat(STAGE_A_CHUNK_MAX_BYTES + 1),
        commitCount: 1,
        spanDays: 1,
        additions: 1,
        deletions: 0,
        commitTitles: ["feat: 기능 추가"],
        changedFilePathCount: 1,
        topFilePaths: ["src/a.ts"],
      },
    };

    // 작은 묶음이 앞에 있어 current !== undefined인 상태로 초과 묶음을 만난다.
    expect(() => splitUnitsIntoChunks([small, oversized], [])).toThrow(CandidateRequestError);
  });

  it("JSON 이스케이프로 요청 본문만 넘는 묶음도 잡는다", () => {
    // 프롬프트 바이트는 상한 안이지만 JSON.stringify가 따옴표와 백슬래시를 이스케이프해 요청
    // 본문이 20,000바이트를 넘는 경우다. 선별은 요약 렌더 바이트로만 재므로 여기까지 온다.
    // 따옴표와 백슬래시를 소스에 리터럴로 두지 않고 만든다. JSON.stringify가 둘 다
    // 이스케이프해 요청 본문 바이트를 두 배로 만든다.
    // 쌍 하나가 프롬프트에서 2바이트, JSON에서 4바이트(둘 다 이스케이프)다. 요청 본문이
    // 상한을 조금 넘고 프롬프트는 상한 안에 드는 길이를 상한에서 유도한다.
    const pair = [String.fromCharCode(34), String.fromCharCode(92)].join("");
    const escaped = pair.repeat(Math.floor((STAGE_A_CHUNK_MAX_REQUEST_BYTES + 200) / 4));
    const unit = {
      pullRequestNumber: 3,
      representativeSha: "sha-escaped",
      summary: {
        pullRequestNumber: 3,
        pullRequestTitle: "PR",
        commitCount: 1,
        spanDays: 1,
        additions: 1,
        deletions: 0,
        commitTitles: [escaped],
        changedFilePathCount: 1,
        topFilePaths: ["src/a.ts"],
      },
    };
    const promptBytes = new TextEncoder().encode(
      renderStageAPrompt(buildStageAPayload(toStageARequest([unit], [], 1)))
    ).byteLength;
    const requestBytes = new TextEncoder().encode(
      JSON.stringify(toStageARequest([unit], [], 1))
    ).byteLength;

    // 전제 확인: 프롬프트는 상한 안이고 요청 본문만 넘는다.
    expect(promptBytes).toBeLessThanOrEqual(STAGE_A_CHUNK_MAX_BYTES);
    expect(requestBytes).toBeGreaterThan(STAGE_A_CHUNK_MAX_REQUEST_BYTES);
    expect(() => splitUnitsIntoChunks([unit], [])).toThrow(CandidateRequestError);
  });

  it("기여 항목을 프롬프트 바이트에 포함해 나눈다", () => {
    // 서버가 재는 프롬프트는 요약과 기여 항목을 합친 것입니다. 여기서 요약만 재면 서버가 거부할
    // 청크를 만들어 보냅니다. 실측에서 demian 요약 9,913바이트에 기여 항목 200자만 더해도
    // 10,530바이트가 되어 상한 10,500을 넘고 모든 청크가 422로 거부됐습니다.
    const commits = manyUnits(20);
    const units = toStageAUnits(commits).units;
    // 청크가 반드시 두 개 이상 되도록 전체 요약의 절반만 들어갈 예산을 남깁니다.
    const longItem = itemFillingBudgetExcept(Math.floor(promptBytesOf(commits, []) / 2));

    const withoutItems = splitUnitsIntoChunks(units, []);
    const withItems = splitUnitsIntoChunks(units, [longItem]);

    expect(withItems.length).toBeGreaterThan(withoutItems.length);
    for (const chunk of withItems) {
      const bytes = new TextEncoder().encode(
        renderStageAPrompt(buildStageAPayload(toStageARequest(chunk, [longItem], 1)))
      ).byteLength;
      expect(bytes).toBeLessThanOrEqual(STAGE_A_CHUNK_MAX_BYTES);
    }
    // 묶음을 하나도 잃지 않습니다.
    expect(withItems.flat().map(({ pullRequestNumber }) => pullRequestNumber))
      .toEqual(units.map(({ pullRequestNumber }) => pullRequestNumber));
  });
});

describe("fetchStageBCandidatesFromApi", () => {
  const output = {
    candidates: [
      { sha: "sha-1", relatedShas: [], evidence: "근거입니다.", citedFilePaths: ["src/a.ts"], source: "contribution_match" },
    ],
    insufficientCandidatesReason: "후보로 판단할 수 있는 커밋이 1개뿐입니다.",
    diffs: [{ sha: "sha-1", files: [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 2, changes: 12 }] }],
  };

  it("owner, repo, Stage A 후보만 전송하고 검증한 결과를 diffs와 함께 반환한다", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(output));

    await expect(fetchStageBCandidatesFromApi(REPOSITORY, [STAGE_A_CANDIDATE])).resolves.toEqual(output);
    expect(fetch).toHaveBeenCalledWith("/api/candidates/stage-b", expect.objectContaining({
      body: JSON.stringify({ ...REPOSITORY, candidates: [STAGE_A_CANDIDATE] }),
    }));
  });

  it("diffs가 없는 응답을 invalid_response로 거부한다", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ candidates: output.candidates, insufficientCandidatesReason: output.insufficientCandidatesReason })
    );
    await expectRequestError(fetchStageBCandidatesFromApi(REPOSITORY, [STAGE_A_CANDIDATE]), {
      stage: "stage_b",
      kind: "invalid_response",
    });
  });

  it("후보가 3개 미만인데 부족 사유가 없는 응답을 invalid_response로 거부한다", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ...output, insufficientCandidatesReason: null })
    );
    await expectRequestError(fetchStageBCandidatesFromApi(REPOSITORY, [STAGE_A_CANDIDATE]), {
      kind: "invalid_response",
    });
  });

  it("GitHub 조회 오류 kind를 그대로 보존해 diff 재조회 실패를 구분할 수 있게 한다", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: { kind: "repo_not_found", message: "Repository를 찾을 수 없습니다." } }, 404)
    );
    await expectRequestError(fetchStageBCandidatesFromApi(REPOSITORY, [STAGE_A_CANDIDATE]), {
      stage: "stage_b",
      kind: "repo_not_found",
    });
  });
});
