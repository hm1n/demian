// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";
import { InterviewScreen } from "./interview-screen";
import { createTestStream, type TestStreamScenario } from "./test-stream";

afterEach(cleanup);

const snapshot = (overrides: Partial<ExperienceEvidenceSnapshot> = {}): ExperienceEvidenceSnapshot => ({
  candidateSha: "a".repeat(40),
  source: "automatic_recommendation",
  origin: "repository",
  evidence: {
    text: "재시도 큐를 도입해 실패한 요청을 다시 보냅니다.",
    verifiability: { status: "unverifiable", aiSelected: true, detail: "AI가 작성한 해석입니다." },
  },
  representativeCommit: {
    sha: "a".repeat(40),
    role: "representative",
    indexed: true,
    title: "재시도 큐 도입",
    message: "재시도 큐 도입",
    pullRequests: [],
    files: [
      {
        path: "src/queue.ts",
        status: "modified",
        additions: 12,
        deletions: 3,
        changes: 15,
        patch: "@@ -1,2 +1,3 @@\n+queue",
        patchTruncated: false,
        patchOmittedReason: null,
      },
    ],
    verifiability: { status: "verified", aiSelected: false, detail: "Repository 응답 값입니다." },
  },
  relatedCommits: [],
  citedFilePaths: {
    paths: ["src/queue.ts"],
    verifiability: { status: "verified", aiSelected: true, detail: "AI가 고른 값입니다." },
  },
  unverifiableItems: ["성능 개선 폭"],
  patchBudget: {
    maxInputTokens: 3_500,
    metadataTokens: 100,
    maxPatchBytes: 10_200,
    patchBytes: 24,
    truncatedByBudget: false,
  },
  ...overrides,
});

/** 실제 테스트 스트림을 응답 본문으로 씁니다. 화면부터 SSE 파싱까지 같은 경로를 지납니다. */
const testStreamFetch = (scenario: TestStreamScenario) =>
  vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    body: createTestStream({ scenario, delayMs: 0 }),
  }) as unknown as Response);

const pendingFetch = () => vi.fn().mockReturnValue(new Promise<Response>(() => {}));

describe("InterviewScreen", () => {
  it("확정한 경험의 대표 커밋 제목을 화면 제목으로 쓴다", () => {
    render(<InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={pendingFetch()} />);

    expect(screen.getByRole("heading", { name: "재시도 큐 도입" })).toBeInTheDocument();
  });

  it("대표 커밋 제목이 없으면 SHA로 대신한다", () => {
    render(
      <InterviewScreen
        snapshot={snapshot({
          representativeCommit: { ...snapshot().representativeCommit, indexed: false, title: null },
        })}
        onBack={vi.fn()}
        fetchImpl={pendingFetch()}
      />
    );

    expect(screen.getByRole("heading", { name: "대표 커밋 aaaaaaa" })).toBeInTheDocument();
  });

  it("첫 질문이 도착하기 전에는 준비 안내를 보여 준다", () => {
    render(<InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={pendingFetch()} />);

    expect(screen.getByText("질문을 준비하고 있습니다.")).toBeInTheDocument();
  });

  it("테스트 스트림으로 도착한 질문을 표시한다", async () => {
    render(
      <InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={testStreamFetch("normal")} />
    );

    expect(
      await screen.findByRole("heading", { name: /청크 경계를 세 조건으로 함께 닫은 이유/ })
    ).toBeInTheDocument();
    expect(await screen.findByText("질문이 모두 도착했습니다.")).toBeInTheDocument();
  });

  it("질문 생성 오류는 스트림 화면의 안내와 다시 시도를 그대로 쓴다", async () => {
    render(
      <InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={testStreamFetch("error")} />
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/질문 생성 호출 한도에 걸렸습니다/);
    const retry = screen.getByRole("button", { name: "다시 시도" });
    expect(retry).toHaveAccessibleDescription(/잠시 뒤에 다시 시도해 주세요/);
  });

  it("근거 패널을 질문 아래에 함께 보여 준다", () => {
    render(<InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={pendingFetch()} />);

    const stream = screen.getByRole("region", { name: "AI 질문 스트리밍" });
    const panel = screen.getByRole("region", { name: "이 질문의 근거" });
    expect(stream.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/대표 커밋 변경 파일 1개/)).toBeInTheDocument();
  });

  it("자라나는 질문을 낭독 대상으로 만들지 않는다", async () => {
    const { container } = render(
      <InterviewScreen snapshot={snapshot()} onBack={vi.fn()} fetchImpl={testStreamFetch("normal")} />
    );

    const message = await screen.findByRole("heading", { name: /청크 경계를 세 조건으로 함께 닫은 이유/ });
    // 질문이 놓이는 자리와 그 조상 어디에도 켜진 live region이 없어야 합니다. 있으면 스크린리더가
    // 프레임마다 자라나는 질문 전체를 다시 읽습니다.
    for (let node: HTMLElement | null = message; node !== null; node = node.parentElement) {
      const live = node.getAttribute("aria-live");
      expect(live === null || live === "off").toBe(true);
      if (node === container) break;
    }
  });

  it("후보 목록으로 돌아갈 수 있다", () => {
    const onBack = vi.fn();
    render(<InterviewScreen snapshot={snapshot()} onBack={onBack} fetchImpl={pendingFetch()} />);

    fireEvent.click(screen.getByRole("button", { name: "← 후보 목록으로" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("시나리오를 지정한 주소를 그대로 스트림에 넘긴다", () => {
    const fetchImpl = pendingFetch();
    render(
      <InterviewScreen
        snapshot={snapshot()}
        onBack={vi.fn()}
        streamUrl="/api/interview/stream?scenario=slow"
        fetchImpl={fetchImpl}
      />
    );

    expect(fetchImpl.mock.calls[0][0]).toBe("/api/interview/stream?scenario=slow");
  });
});
