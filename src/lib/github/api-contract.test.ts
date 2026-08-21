import { describe, expect, it, vi } from "vitest";
import { toAnalysisError } from "@/features/repository-analysis/repository-analysis";
import { apiFetch, errorResponse, readApiResponse } from "./api-contract";
import { decodeCommitCursor, encodeCommitCursor } from "./cursor";
import { GitHubFetchError, RepositoryContributionFetchError, type GitHubFetchErrorKind } from "./errors";
import type { CommitDetail } from "./types";

const DETAIL: CommitDetail = {
  sha: "a".repeat(40), title: "feat", author: "octocat", date: "2026-08-21", parentCount: 1,
  message: "feat", additions: 1, deletions: 0, changedFiles: 1, files: [], pullRequests: [],
};

describe("GitHub API 오류 계약", () => {
  it.each([
    ["rate_limit", 429], ["auth_revoked", 401], ["repo_not_found", 404],
    ["network", 502], ["server_error", 500],
  ] as const)("%s를 HTTP 경계 왕복 뒤 같은 화면 복구 계약으로 보존한다", async (kind, status) => {
    const response = errorResponse(new GitHubFetchError(kind, "failed"));
    expect(response.status).toBe(status);
    const restored = await readApiResponse(response).catch((error) => error);
    expect(toAnalysisError(restored, { step: "commits" }).kind).toBe(kind);
  });

  it("partial_failure의 근본 kind, 부분 상세, 진행 수치를 보존한다", async () => {
    const cause = new GitHubFetchError("rate_limit", "limited");
    const error = new RepositoryContributionFetchError("partial_failure", "partial", [DETAIL], { cause });
    const response = errorResponse(error, 3);
    expect(response.status).toBe(500);
    const body = await response.clone().json();
    expect(body).toMatchObject({ error: { kind: "partial_failure", causeKind: "rate_limit", completed: 1, total: 3, partialCommits: [DETAIL] } });
    const restored = await readApiResponse(response, true).catch((caught) => caught);
    expect(toAnalysisError(restored, { step: "details", total: 3 })).toMatchObject({ kind: "partial_failure", causeKind: "rate_limit", completed: 1, total: 3 });
  });

  it.each(["rate_limit", "auth_revoked", "repo_not_found", "network", "server_error", "partial_failure"] satisfies GitHubFetchErrorKind[])("%s body kind를 보존한다", async (kind) => {
    const restored = await readApiResponse(errorResponse(new GitHubFetchError(kind, "failed"))).catch((error) => error);
    expect(restored).toMatchObject({ kind });
  });

  it("JSON이 아니거나 형식이 다른 오류 응답을 server_error로 바꾼다", async () => {
    await expect(readApiResponse(new Response("broken", { status: 500 }))).rejects.toMatchObject({ kind: "server_error" });
    await expect(readApiResponse(Response.json({ nope: true }, { status: 500 }))).rejects.toMatchObject({ kind: "server_error" });
  });

  it("fetch throw를 network로 바꾼다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(apiFetch("/api/github/commits")).rejects.toMatchObject({ kind: "network" });
    vi.unstubAllGlobals();
  });
});

describe("커밋 커서", () => {
  it("고정 head SHA와 다음 페이지를 불투명 값으로 왕복한다", () => {
    const cursor = { headSha: "a".repeat(40), page: 21 };
    const encoded = encodeCommitCursor(cursor);
    expect(encoded).not.toContain(cursor.headSha);
    expect(decodeCommitCursor(encoded)).toEqual(cursor);
  });

  it.each(["broken", Buffer.from(JSON.stringify({ headSha: "main", page: 2 })).toString("base64url")])("위조·손상된 커서 %s를 거부한다", (cursor) => {
    expect(() => decodeCommitCursor(cursor)).toThrow("invalid cursor");
  });
});
