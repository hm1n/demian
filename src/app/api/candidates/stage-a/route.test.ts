import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encryptGitHubToken,
  GITHUB_SESSION_COOKIE,
  GITHUB_SESSION_KEY_ENV,
} from "@/lib/github/auth-session";
import { ExperienceCandidateOutputError } from "@/features/experience-candidates/errors";
import { handleStageA, MAX_STAGE_A_BODY_BYTES } from "./route";

const body = { commits: [], contributionItems: [] };
const commit = {
  sha: "sha",
  message: "feat: 경량 입력",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
};

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
    const response = await handleStageA(request(body), async () => ({ decisions: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ candidates: [], unclassifiedShas: [] });
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

  it("patch가 포함된 요청은 크기 상한이 아니라 계약 위반 422로 거부한다", async () => {
    const response = await handleStageA(request({
      commits: [{
        ...commit,
        files: [{ ...commit.files[0], patch: "x".repeat(1024 * 1024) }],
      }],
      contributionItems: [],
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { kind: "invalid_request" } });
  });

  it("patch를 제외한 경량 메시지·stat 요청은 정상 처리한다", async () => {
    let received: unknown;
    const response = await handleStageA(
      request({ commits: [commit], contributionItems: [] }),
      async (payload) => {
        received = payload;
        return { decisions: [{ sha: "sha", contributionItem: null, recommended: false }] };
      }
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(received)).not.toContain("patch");
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
});
