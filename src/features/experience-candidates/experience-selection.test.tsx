// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";
import type { CandidateDiff, ExperienceCandidate, StageBCandidateResult } from "./types";
import { ExperienceCandidateList } from "./experience-candidate-list";
import {
  EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN,
  EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
} from "./evidence-snapshot";

const CONFIRM_LABEL = "이 경험으로 인터뷰 시작";
const BACK_LABEL = "← 후보 목록으로";

const commit = (
  sha: string,
  title: string,
  files: ReadonlyCommitDetail["files"] = [
    { path: `src/${sha}.ts`, status: "modified", additions: 10, deletions: 2, changes: 12 },
  ]
): ReadonlyCommitDetail => ({
  sha,
  title,
  author: "octocat",
  date: "2026-08-24T00:00:00Z",
  parentCount: 1,
  message: title,
  additions: 10,
  deletions: 2,
  changedFiles: files.length,
  files,
  pullRequests: [],
});

const candidate = (sha: string, overrides: Partial<ExperienceCandidate> = {}): ExperienceCandidate => ({
  sha,
  relatedShas: [],
  evidence: `${sha}의 Repository 근거입니다.`,
  citedFilePaths: [],
  source: "automatic_recommendation",
  ...overrides,
});

function renderList(
  candidateItems: readonly ExperienceCandidate[],
  commits: readonly ReadonlyCommitDetail[],
  diffs: readonly CandidateDiff[] = []
) {
  const data: CandidateDataOutput = {
    allCommits: commits,
    includedCommits: commits,
    repository: { fileTree: [], treeTruncated: false, languages: {} },
  };
  const candidates: StageBCandidateResult = {
    candidates: candidateItems,
    insufficientCandidatesReason: candidateItems.length < 3 ? "후보가 부족합니다." : null,
    diffs,
  };
  render(
    <ExperienceCandidateList
      repository={{ owner: "hm1n", repo: "demian" }}
      data={data}
      candidates={candidates}
      onSelectRepository={vi.fn()}
    />
  );
}

afterEach(cleanup);

describe("경험 선택 확정과 인터뷰 진입점", () => {
  it("상세 화면의 선택 액션으로 인터뷰 대상을 확정한다", () => {
    renderList([candidate("aaa")], [commit("aaa", "재시도 큐 도입")]);

    fireEvent.click(screen.getByRole("button", { name: /재시도 큐 도입/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    expect(screen.getByText("인터뷰 대상 확정")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "재시도 큐 도입" })).toBeInTheDocument();
    expect(screen.getByText("질문은 아직 생성되지 않습니다")).toBeInTheDocument();
    expect(screen.getByText(/대표 커밋 변경 파일 1개/)).toBeInTheDocument();
  });

  it("목록으로 돌아가 다른 경험을 확정하면 확정 상태가 교체된다", () => {
    renderList(
      [candidate("aaa"), candidate("bbb")],
      [commit("aaa", "재시도 큐 도입"), commit("bbb", "지연 시간 조정")]
    );

    fireEvent.click(screen.getByRole("button", { name: /재시도 큐 도입/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    expect(screen.getByRole("heading", { name: "재시도 큐 도입" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: /지연 시간 조정/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    expect(screen.getByRole("heading", { name: "지연 시간 조정" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "재시도 큐 도입" })).not.toBeInTheDocument();
  });

  it("최종 후보가 없으면 선택 액션을 노출하지 않는다", () => {
    renderList([], []);

    expect(screen.queryByRole("button", { name: CONFIRM_LABEL })).not.toBeInTheDocument();
  });

  it("대표 커밋을 색인에서 찾지 못하면 무엇이 부족한지 알리고 목록으로 돌아갈 수 있다", () => {
    renderList([candidate("abcdef123456")], []);

    fireEvent.click(screen.getByRole("button", { name: /커밋 색인 실패 · abcdef1/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-selection-error", "representative_commit_not_indexed");
    expect(alert).toHaveTextContent("대표 커밋을 커밋 색인에서 찾지 못해");
    expect(screen.queryByText("인터뷰 대상 확정")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    expect(screen.getByText(/경험 후보 1개를 선정했습니다/)).toBeInTheDocument();
  });

  it("대표 커밋에 변경 파일이 없으면 근거가 없다고 알린다", () => {
    renderList([candidate("aaa")], [commit("aaa", "빈 커밋", [])]);

    fireEvent.click(screen.getByRole("button", { name: /빈 커밋/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-selection-error",
      "no_repository_evidence"
    );
  });

  it("목록으로 돌아가면 이전 실패 안내가 남지 않는다", () => {
    renderList([candidate("aaa")], [commit("aaa", "빈 커밋", [])]);

    fireEvent.click(screen.getByRole("button", { name: /빈 커밋/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: /빈 커밋/ }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("선택 액션의 접근성 이름이 확인 가능·불가 안내를 가리지 않는다", () => {
    renderList([candidate("aaa")], [commit("aaa", "접근성 검증")]);

    fireEvent.click(screen.getByRole("button", { name: /접근성 검증/ }));
    const action = screen.getByRole("button", { name: CONFIRM_LABEL });

    expect(action).toHaveAccessibleName(CONFIRM_LABEL);
    expect(action).toHaveAccessibleDescription(/확인 불가 · AI가 작성한 해석입니다/);
    expect(action).toHaveAccessibleDescription(/확인 가능/);
  });

  it("확정 화면은 AI가 고른 개수를 확인 가능으로 표시하지 않는다", () => {
    renderList(
      [candidate("aaa", { relatedShas: ["bbb"], citedFilePaths: ["src/aaa.ts"] })],
      [commit("aaa", "근거 표시 경계"), commit("bbb", "관련 커밋")]
    );

    fireEvent.click(screen.getByRole("button", { name: /근거 표시 경계/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    const relatedItem = screen.getByText(/관련 커밋 1개/);
    expect(relatedItem).toHaveTextContent("AI 선택");
    expect(relatedItem).not.toHaveTextContent("확인 가능");

    const citedItem = screen.getByText(/인용 파일 1개/);
    expect(citedItem).toHaveTextContent("AI 선택");
    expect(citedItem).not.toHaveTextContent("확인 가능");

    // 관련 커밋 파일까지 합친 개수를 확인 가능으로 표시하면 AI 선택이 Repository 사실로 보입니다.
    const changedFilesItem = screen.getByText(/대표 커밋 변경 파일 1개/);
    expect(changedFilesItem).toHaveTextContent("확인 가능");
    expect(changedFilesItem).not.toHaveTextContent("AI 선택");
    expect(screen.queryByText(/^변경 파일 2개$/)).not.toBeInTheDocument();
  });

  it("근거 상한 때문에 patch를 자르면 확정 화면이 그 사실을 알린다", () => {
    renderList(
      [candidate("aaa")],
      [commit("aaa", "상한 절단")],
      [
        {
          sha: "aaa",
          files: [
            {
              path: "src/aaa.ts",
              status: "modified",
              additions: 10,
              deletions: 2,
              changes: 12,
              patch: "x".repeat(
                EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN
              ),
            },
          ],
        },
      ]
    );

    fireEvent.click(screen.getByRole("button", { name: /상한 절단/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    expect(screen.getByText(/코드\s*변경 내역 일부를 잘랐습니다/)).toBeInTheDocument();
  });

  it("근거가 입력 상한을 넘으면 무엇이 부족한지 알린다", () => {
    renderList(
      [candidate("aaa")],
      [{ ...commit("aaa", "거대한 커밋 메시지"), message: "긴 커밋 메시지 ".repeat(5_000) }]
    );

    fireEvent.click(screen.getByRole("button", { name: /거대한 커밋 메시지/ }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-selection-error", "evidence_input_too_large");
    expect(alert).toHaveTextContent("코드 변경 내역을 모두 빼도");
  });
});
