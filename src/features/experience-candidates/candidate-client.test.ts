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
import { STAGE_A_CHUNK_MAX_BYTES } from "./stage-a";
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
    const output = { candidates: [STAGE_A_CANDIDATE], unclassifiedShas: ["sha-2"], rateLimit: null };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(output));

    await expect(fetchStageACandidatesFromApi([COMMIT], ["푸시 알림 구현"])).resolves.toEqual({
      candidates: output.candidates,
      unclassifiedShas: output.unclassifiedShas,
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
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ candidates: [{ sha: 1 }], unclassifiedShas: [] }));
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

  it("청크마다 쿼터를 보내고 쿼터 합이 전역 상한을 넘지 않는다", async () => {
    const commits = manyUnits(25);
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = parseRequest(init);
      return jsonResponse({
        candidates: [],
        unclassifiedShas: request.units.map(({ representativeSha }) => representativeSha),
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
      candidates: [], unclassifiedShas: [], rateLimit: null,
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
