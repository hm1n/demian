import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandidateRequestError,
  fetchStageACandidatesFromApi,
  fetchStageBCandidatesFromApi,
  toStageARequest,
} from "./candidate-client";
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
  pullRequests: [{ number: 1, title: "PR", state: "merged", url: "https://example.test", baseBranch: "main", headBranch: "feat" }],
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toStageARequest", () => {
  it("경량 계약 필드만 남기고 patch, PR, 작성자 정보를 제거한다", () => {
    const request = toStageARequest([COMMIT], ["푸시 알림 구현"]);

    expect(request).toEqual({
      mode: "initial",
      commits: [{
        sha: "sha-1",
        message: "feat: add analysis",
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        files: [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 2, changes: 12 }],
      }],
      contributionItems: ["푸시 알림 구현"],
    });
    expect(JSON.stringify(request)).not.toContain("patch");
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
      body: JSON.stringify(toStageARequest([COMMIT], ["푸시 알림 구현"])),
    }));
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

  it("8개 경계로 모든 커밋을 한 번씩 판단하고 후보 초과를 감소 재판단한다", async () => {
    const commits = Array.from({ length: 25 }, (_, index) => ({ ...COMMIT, sha: `sha-${index}` }));
    const initialShas: string[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        mode: "initial" | "reduce";
        commits: { sha: string }[];
        candidateLimit?: number;
      };
      if (request.mode === "initial") initialShas.push(...request.commits.map(({ sha }) => sha));
      const selected = request.commits.slice(0, request.candidateLimit ?? request.commits.length);
      return jsonResponse({
        candidates: selected.map(({ sha }) => ({ sha, source: "automatic_recommendation", contributionItem: null })),
        unclassifiedShas: request.commits.slice(selected.length).map(({ sha }) => sha),
        rateLimit: { remainingTokens: 0, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    const output = await fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined);

    expect(initialShas).toEqual(commits.map(({ sha }) => sha));
    expect(new Set(initialShas).size).toBe(25);
    expect(output.candidates.length).toBeLessThanOrEqual(20);
    expect(vi.mocked(fetch).mock.calls.slice(0, 4).map(([, init]) =>
      (JSON.parse(String(init?.body)) as { commits: unknown[] }).commits.length
    )).toEqual([8, 8, 8, 1]);
  });

  it("실패 전 완료 청크 체크포인트로 재개해 이미 판단한 SHA를 다시 보내지 않는다", async () => {
    const commits = Array.from({ length: 13 }, (_, index) => ({ ...COMMIT, sha: `sha-${index}` }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        candidates: [], unclassifiedShas: commits.slice(0, 8).map(({ sha }) => sha),
        rateLimit: { remainingTokens: 0, resetAfterMs: 1, usedTokens: 100 },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: { kind: "llm_failure", message: "실패" } }, 502));

    let checkpoint: import("./types").StageACheckpoint | undefined;
    try {
      await fetchStageACandidatesFromApi(commits, [], () => undefined, undefined, async () => undefined);
    } catch (error) {
      checkpoint = (error as CandidateRequestError).checkpoint;
    }
    expect(checkpoint?.processedShas).toHaveLength(8);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      candidates: [], unclassifiedShas: commits.slice(8).map(({ sha }) => sha), rateLimit: null,
    }));
    await fetchStageACandidatesFromApi(commits, [], () => undefined, checkpoint, async () => undefined);
    const resumed = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as { commits: { sha: string }[] };
    expect(resumed.commits.map(({ sha }) => sha)).toEqual(commits.slice(8).map(({ sha }) => sha));
  });

  it("커밋 수보다 먼저 바이트 경계에 닿으면 경계 커밋을 다음 청크로 보존한다", async () => {
    const commits = Array.from({ length: 3 }, (_, index) => ({
      ...COMMIT,
      sha: `sha-${index}`,
      message: "x".repeat(2_500),
    }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { commits: { sha: string }[] };
      return jsonResponse({
        candidates: [],
        unclassifiedShas: request.commits.map(({ sha }) => sha),
        rateLimit: { remainingTokens: 8_000, resetAfterMs: 1, usedTokens: 100 },
      });
    });

    const output = await fetchStageACandidatesFromApi(commits, []);

    expect(output.unclassifiedShas).toEqual(commits.map(({ sha }) => sha));
    expect(vi.mocked(fetch).mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { commits: unknown[] }).commits.length
    )).toEqual([2, 1]);
  });

  it("파일 수 경계에서도 커밋을 누락하거나 중복하지 않는다", async () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ ...COMMIT.files[0], path: `src/${index}.ts` }));
    const commits = Array.from({ length: 4 }, (_, index) => ({ ...COMMIT, sha: `sha-${index}`, files }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { commits: { sha: string }[] };
      return jsonResponse({ candidates: [], unclassifiedShas: request.commits.map(({ sha }) => sha), rateLimit: {
        remainingTokens: 8_000, resetAfterMs: 1, usedTokens: 100,
      } });
    });

    const output = await fetchStageACandidatesFromApi(commits, []);

    expect(output.unclassifiedShas).toEqual(commits.map(({ sha }) => sha));
    expect(vi.mocked(fetch).mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { commits: unknown[] }).commits.length
    )).toEqual([3, 1]);
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
