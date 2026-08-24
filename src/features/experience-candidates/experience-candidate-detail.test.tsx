// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";
import type { ExperienceCandidate, StageBCandidateResult } from "./types";
import { ExperienceCandidateDetail } from "./experience-candidate-detail";

const representative: ReadonlyCommitDetail = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "후보 상세 구현",
  author: "octocat",
  date: "2026-08-24T00:00:00Z",
  parentCount: 1,
  message: "후보 상세 구현",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  files: [
    { path: "src/detail.tsx", status: "modified", additions: 10, deletions: 2, changes: 12 },
    { path: "src/missing.ts", status: "added", additions: 2, deletions: 0, changes: 2 },
  ],
  pullRequests: [{ number: 46, title: "후보 상세", state: "open", url: "https://example.com/pr/46", baseBranch: "develop", headBranch: "feature" }],
};

const related: ReadonlyCommitDetail = {
  ...representative,
  sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  title: "관련 근거 추가",
};

const candidate: ExperienceCandidate = {
  sha: representative.sha,
  relatedShas: [related.sha],
  evidence: "상세 근거를 표시합니다.",
  citedFilePaths: ["src/detail.tsx"],
  source: "automatic_recommendation",
};

const data: CandidateDataOutput = {
  allCommits: [representative, related],
  includedCommits: [representative, related],
  repository: { fileTree: [], treeTruncated: false, languages: {} },
};

function renderDetail(
  candidates: StageBCandidateResult,
  candidateData: CandidateDataOutput = data,
  commit: ReadonlyCommitDetail = representative
) {
  const selectedCandidate = candidates.candidates[0];
  render(
    <ExperienceCandidateDetail
      repository={{ owner: "hm1n", repo: "demian" }}
      data={candidateData}
      candidates={candidates}
      item={{
        candidate: selectedCandidate,
        commit,
        origin: "repository",
        normalizedRelatedShas: [...new Set(selectedCandidate.relatedShas.filter((sha) => sha !== selectedCandidate.sha))],
        normalizedCitedFilePaths: [...new Set(selectedCandidate.citedFilePaths)],
      }}
      onBack={vi.fn()}
    />
  );
}

afterEach(cleanup);

describe("ExperienceCandidateDetail", () => {
  it("완전한 파일 목록과 절단·미포함 diff를 함께 표시한다", () => {
    renderDetail({
      candidates: [candidate],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [{
        sha: representative.sha,
        files: [{ path: "src/detail.tsx", status: "modified", additions: 10, deletions: 2, changes: 12, patch: "@@ -1 +1 @@\n-old\n+new", patchTruncated: true }],
      }],
    });

    expect(screen.getByText("변경 파일 2개")).toBeInTheDocument();
    expect(screen.getByText("src/missing.ts")).toBeInTheDocument();
    expect(screen.getByText("diff 미포함")).toBeInTheDocument();
    expect(screen.getAllByText("diff 절단")).toHaveLength(2);
    expect(screen.getByText(/일부 diff가 예산에 맞게 절단/)).toBeInTheDocument();
    expect(screen.getByText(/\+new/)).toBeInTheDocument();
  });

  it("patch가 없는 예산 절단 파일도 일반 미포함과 구분해 표시한다", () => {
    const exhaustedCommit: ReadonlyCommitDetail = {
      ...representative,
      changedFiles: 1,
      files: [{ path: "src/exhausted.ts", status: "modified", additions: 0, deletions: 1, changes: 1 }],
    };
    renderDetail(
      {
        candidates: [candidate],
        insufficientCandidatesReason: "하나뿐입니다.",
        diffs: [{
          sha: representative.sha,
          files: [{ path: "src/exhausted.ts", status: "modified", additions: 0, deletions: 1, changes: 1, patchTruncated: true }],
        }],
      },
      { ...data, includedCommits: [exhaustedCommit, related] },
      exhaustedCommit
    );

    expect(screen.getAllByText("diff 절단")).toHaveLength(2);
    expect(screen.queryByText("diff 미포함")).not.toBeInTheDocument();
    expect(screen.getByText("patch 예산이 소진되어 diff 본문이 미포함되었습니다.")).toBeInTheDocument();
  });

  it("관련 커밋을 상한 없이 제목·SHA·PR 번호와 링크로 표시한다", () => {
    renderDetail({
      candidates: [{ ...candidate, relatedShas: [related.sha, related.sha, representative.sha] }],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(screen.getByRole("heading", { name: "관련 커밋 1개" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "관련 근거 추가" })).toHaveAttribute(
      "href",
      `https://github.com/hm1n/demian/commit/${related.sha}`
    );
    expect(screen.getByText("bbbbbbb")).toBeInTheDocument();
    expect(screen.getAllByText("PR #46")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "후보 상세 구현" })).not.toBeInTheDocument();
  });

  it("evidence 문장은 확인 불가로, 파일·diff·관련 커밋·PR 정보는 확인 가능으로 구분해 안내한다", () => {
    renderDetail({
      candidates: [candidate],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(screen.getByText("확인 불가 · AI가 작성한 해석입니다")).toBeInTheDocument();
    expect(
      screen.getByText(
        "확인 가능 · 변경 파일, 코드 변경 내역, PR 정보는 Repository 응답 값이고, 관련 커밋은 대표 커밋과 같은 PR에 속한다는 관계까지 확인됩니다"
      )
    ).toBeInTheDocument();
  });

  it("관련 커밋 목록이 있으면 AI가 고른 결과이고 PR 소속 관계까지만 확인됨을 안내한다", () => {
    renderDetail({
      candidates: [candidate],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(
      screen.getByText(
        "AI 선택 · 대표 커밋과 같은 PR에 속한다는 관계까지만 확인되고, 근거로서 관련 있다는 판단은 확인 불가입니다"
      )
    ).toBeInTheDocument();
  });

  it("관련 커밋이 없으면 AI 선택 안내를 표시하지 않는다", () => {
    renderDetail({
      candidates: [{ ...candidate, relatedShas: [] }],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(
      screen.queryByText(/대표 커밋과 같은 PR에 속한다는 관계까지만 확인되고/)
    ).not.toBeInTheDocument();
  });

  it("Repository로 확인할 수 없는 고정 목록을 항상 표시한다", () => {
    renderDetail({
      candidates: [candidate],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(screen.getByRole("heading", { name: "Repository로 확인할 수 없는 항목" })).toBeInTheDocument();
    expect(screen.getByText("성능 개선 폭")).toBeInTheDocument();
    expect(screen.getByText("사용자 영향")).toBeInTheDocument();
    expect(screen.getByText("다른 대안과의 비교")).toBeInTheDocument();
    expect(screen.getByText("협업·논의 배경")).toBeInTheDocument();
    expect(screen.getByText("커밋 메시지에 적힌 수치·비교·의도가 실제로 그러했는지")).toBeInTheDocument();
  });

  it("관련 커밋과 diff가 없으면 안내하되 파일 목록과 PR 정보는 유지한다", () => {
    renderDetail({
      candidates: [{ ...candidate, relatedShas: [] }],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    });

    expect(screen.getByText("표시할 코드 변경 내역이 없습니다")).toBeInTheDocument();
    expect(screen.getByText("관련 커밋이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("src/detail.tsx")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #46 · 후보 상세" })).toHaveAttribute("href", "https://example.com/pr/46");
  });
});
