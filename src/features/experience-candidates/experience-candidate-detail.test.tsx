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

function renderDetail(candidates: StageBCandidateResult) {
  const selectedCandidate = candidates.candidates[0];
  render(
    <ExperienceCandidateDetail
      repository={{ owner: "hm1n", repo: "demian" }}
      data={data}
      candidates={candidates}
      item={{
        candidate: selectedCandidate,
        commit: representative,
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
    expect(screen.getByText("diff 절단")).toBeInTheDocument();
    expect(screen.getByText(/일부 diff가 예산에 맞게 절단/)).toBeInTheDocument();
    expect(screen.getByText(/\+new/)).toBeInTheDocument();
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
