import { describe, expect, it, vi } from "vitest";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";
import {
  createInterviewStreamFetch,
  createInterviewStreamRequestBody,
  INTERVIEW_STREAM_ROUTE_ACCEPTS_SNAPSHOT,
} from "./interview-request";

const snapshot = {
  candidateSha: "a".repeat(40),
  source: "automatic_recommendation",
  origin: "repository",
  evidence: {
    text: "재시도 큐를 도입했습니다.",
    verifiability: { status: "unverifiable", aiSelected: true, detail: "AI가 작성한 해석입니다." },
  },
  representativeCommit: {
    sha: "a".repeat(40),
    role: "representative",
    indexed: true,
    title: "재시도 큐 도입",
    message: "재시도 큐 도입",
    pullRequests: [],
    files: [],
    verifiability: { status: "verified", aiSelected: false, detail: "Repository 응답 값입니다." },
  },
  relatedCommits: [],
  citedFilePaths: {
    paths: [],
    verifiability: { status: "verified", aiSelected: true, detail: "AI가 고른 값입니다." },
  },
  unverifiableItems: [],
  patchBudget: {
    maxInputTokens: 3_500,
    metadataTokens: 100,
    maxPatchBytes: 10_200,
    patchBytes: 0,
    truncatedByBudget: false,
  },
} satisfies ExperienceEvidenceSnapshot;

describe("createInterviewStreamRequestBody", () => {
  it("착수 전에 고정한 계약 그대로 스냅샷 한 개만 싣는다", () => {
    expect(JSON.parse(createInterviewStreamRequestBody(snapshot))).toEqual({ snapshot });
  });
});

describe("createInterviewStreamFetch", () => {
  it("route가 아직 본문을 받지 않는 동안에는 감싸지 않고 그대로 돌려준다", () => {
    const baseFetch = vi.fn();

    expect(createInterviewStreamFetch(snapshot, { baseFetch, enabled: false })).toBe(baseFetch);
  });

  it("현재 route 계약이 본문을 받지 않으므로 기본값도 감싸지 않는다", () => {
    // 지금 route는 GET만 내보냅니다. 이 값이 true가 되는 시점이 이슈 #63의 배선 지점입니다.
    expect(INTERVIEW_STREAM_ROUTE_ACCEPTS_SNAPSHOT).toBe(false);

    const baseFetch = vi.fn();
    expect(createInterviewStreamFetch(snapshot, { baseFetch })).toBe(baseFetch);
  });

  it("본문을 실을 때 전송 계층이 붙인 헤더와 signal을 덮지 않는다", async () => {
    const baseFetch = vi.fn().mockResolvedValue(new Response(null));
    const controller = new AbortController();
    const send = createInterviewStreamFetch(snapshot, { baseFetch, enabled: true });

    await send?.("/api/interview/stream", {
      signal: controller.signal,
      headers: { Accept: "text/event-stream", "Last-Event-ID": "6" },
    });

    const [url, init] = baseFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/interview/stream");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(createInterviewStreamRequestBody(snapshot));
    expect(init.signal).toBe(controller.signal);

    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Last-Event-ID")).toBe("6");
  });

  it("재연결로 다시 보낼 때도 같은 본문을 보낸다", async () => {
    const baseFetch = vi.fn().mockResolvedValue(new Response(null));
    const send = createInterviewStreamFetch(snapshot, { baseFetch, enabled: true });

    await send?.("/api/interview/stream");
    await send?.("/api/interview/stream", { headers: { "Last-Event-ID": "3" } });

    const [first, second] = baseFetch.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(second[1].body).toBe(first[1].body);
  });
});
