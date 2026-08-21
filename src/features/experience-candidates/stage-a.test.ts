import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { ExperienceCandidateOutputError } from "./errors";
import { buildStageAPayload, selectStageACandidates, type StageAInput } from "./stage-a";

const input: StageAInput = {
  contributionItems: ["인증 구현"],
  commits: [
    {
      sha: "matched",
      title: "인증 추가",
      author: "me",
      date: "2026-08-21",
      parentCount: 1,
      message: "feat: 인증 구현",
      additions: 20,
      deletions: 2,
      changedFiles: 1,
      files: [{
        path: "src/auth.ts",
        status: "modified",
        additions: 20,
        deletions: 2,
        changes: 22,
        patch: "secret diff",
      }],
      pullRequests: [],
    },
    {
      sha: "automatic",
      title: "오류 처리",
      author: "me",
      date: "2026-08-21",
      parentCount: 1,
      message: "fix: 오류 처리",
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      files: [{
        path: "src/error.ts",
        status: "modified",
        additions: 5,
        deletions: 1,
        changes: 6,
      }],
      pullRequests: [],
    },
    {
      sha: "unclassified",
      title: "문서",
      author: "me",
      date: "2026-08-21",
      parentCount: 1,
      message: "docs: 문서",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }],
      pullRequests: [],
    },
  ],
};

describe("Stage A 후보 선별", () => {
  it("기여 항목 매칭과 미분류 자동 추천을 한 경로에서 조합한다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: "인증 구현", recommended: true },
      { sha: "automatic", contributionItem: null, recommended: true },
      { sha: "unclassified", contributionItem: null, recommended: false },
    ] }));

    expect(output).toEqual({
      candidates: [
        { sha: "matched", source: "contribution_match", contributionItem: "인증 구현" },
        { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
      ],
      unclassifiedShas: ["unclassified"],
    });
  });

  it("기여 항목이 없으면 추천된 SHA를 자동 추천 후보로 만든다", async () => {
    const output = await selectStageACandidates(
      { ...input, contributionItems: [] },
      async () => ({ decisions: input.commits.map(({ sha }) => ({ sha, contributionItem: null, recommended: sha === "automatic" })) })
    );
    expect(output.candidates).toEqual([
      { sha: "automatic", source: "automatic_recommendation", contributionItem: null },
    ]);
  });

  it("기여 항목만 있으면 일치한 SHA를 해당 항목 후보로 만든다", async () => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: "인증 구현", recommended: false },
    ] }));
    expect(output.candidates[0]).toEqual({
      sha: "matched",
      source: "contribution_match",
      contributionItem: "인증 구현",
    });
  });

  it.each(["미분류", "존재하지 않는 항목"])("%s 라벨은 후보가 아닌 미분류로 처리한다", async (label) => {
    const output = await selectStageACandidates(input, async () => ({ decisions: [
      { sha: "matched", contributionItem: label, recommended: true },
    ] }));
    expect(output.candidates).toEqual([]);
    expect(output.unclassifiedShas).toContain("matched");
  });

  it("실제 LLM payload에서 patch와 불필요한 메타데이터를 제외한다", () => {
    const payload = buildStageAPayload(input);
    expect(JSON.stringify(payload)).not.toContain("patch");
    expect(payload.commits[0]).toEqual({
      sha: "matched",
      message: "feat: 인증 구현",
      additions: 20,
      deletions: 2,
      changedFiles: 1,
      files: [{ path: "src/auth.ts", status: "modified", additions: 20, deletions: 2, changes: 22 }],
    });
  });

  it("구조 위반과 환각 SHA를 서로 다른 kind로 전체 거부한다", async () => {
    await expect(selectStageACandidates(input, async () => ({ decisions: "invalid" }))).rejects.toMatchObject({ kind: "schema_validation" });
    await expect(selectStageACandidates(input, async () => ({ decisions: [
      { sha: "invented", contributionItem: null, recommended: true },
    ] }))).rejects.toMatchObject({ kind: "unknown_sha", unknownShas: ["invented"] });
  });

  it.each([
    [new TypeError("fetch failed"), "llm_network"],
    [new DOMException("timeout", "TimeoutError"), "llm_timeout"],
    [new APICallError({ message: "unauthorized", url: "https://api.groq.com", requestBodyValues: {}, statusCode: 401 }), "llm_auth"],
    [new APICallError({ message: "limited", url: "https://api.groq.com", requestBodyValues: {}, statusCode: 429 }), "llm_rate_limit"],
    [new Error("unknown"), "llm_failure"],
  ] as const)("LLM 호출 실패 %#을 구분한다", async (error, kind) => {
    await expect(selectStageACandidates(input, async () => { throw error; })).rejects.toEqual(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({ kind })
    );
  });
});
