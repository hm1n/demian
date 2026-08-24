// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";
import type { ExperienceCandidate, StageBCandidateResult } from "./types";
import { createExperienceCandidateListItems, ExperienceCandidateList } from "./experience-candidate-list";

const commit = (sha: string, title: string, pullRequests: ReadonlyCommitDetail["pullRequests"] = []): ReadonlyCommitDetail => ({
  sha,
  title,
  author: "octocat",
  date: "2026-08-24T00:00:00Z",
  parentCount: 1,
  message: title,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  files: [],
  pullRequests,
});

const candidate = (sha: string, overrides: Partial<ExperienceCandidate> = {}): ExperienceCandidate => ({
  sha,
  relatedShas: [],
  evidence: `${sha}의 Repository 근거입니다.`,
  citedFilePaths: [],
  source: "automatic_recommendation",
  ...overrides,
});

function renderList(candidateItems: readonly ExperienceCandidate[], commits: readonly ReadonlyCommitDetail[], reason: string | null) {
  const data: CandidateDataOutput = {
    allCommits: commits,
    includedCommits: commits,
    repository: { fileTree: [], treeTruncated: false, languages: {} },
  };
  const candidates: StageBCandidateResult = { candidates: candidateItems, insufficientCandidatesReason: reason, diffs: [] };
  render(<ExperienceCandidateList repository={{ owner: "hm1n", repo: "demian" }} data={data} candidates={candidates} onSelectRepository={vi.fn()} />);
}

afterEach(cleanup);

describe("ExperienceCandidateList", () => {
  it("화면 표시 모델의 각 후보에 Repository 출처를 담는다", () => {
    const commits = [commit("a", "상태 머신 구현")];
    const data: CandidateDataOutput = {
      allCommits: commits,
      includedCommits: commits,
      repository: { fileTree: [], treeTruncated: false, languages: {} },
    };
    const candidates: StageBCandidateResult = {
      candidates: [candidate("a")],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    };

    expect(createExperienceCandidateListItems(data, candidates)[0]).toMatchObject({ origin: "repository" });
    render(<ExperienceCandidateList repository={{ owner: "hm1n", repo: "demian" }} data={data} candidates={candidates} onSelectRepository={vi.fn()} />);
    expect(screen.getByText("출처: Repository")).toBeInTheDocument();
  });

  it("출처 배지가 검증을 주장하지 않고 근거 문장의 작성 주체와 후속 범위를 안내한다", () => {
    renderList([candidate("a")], [commit("a", "상태 머신 구현")], "하나뿐입니다.");

    expect(screen.queryByText("Repository 근거")).not.toBeInTheDocument();
    expect(screen.getByText("AI 작성 요약 · 확인 가능·불가 구분은 후속 제공")).toBeInTheDocument();
  });

  it("후보 3개의 제목과 출처를 표시하고 부족 사유는 숨긴다", () => {
    const commits = [commit("a", "상태 머신 구현"), commit("b", "오류 계약 정의"), commit("c", "응답 검증 추가")];
    renderList(commits.map(({ sha }) => candidate(sha)), commits, null);

    expect(screen.getByText(/경험 후보 3개를 선정했습니다/)).toBeInTheDocument();
    expect(screen.getAllByText("출처: Repository")).toHaveLength(3);
    expect(screen.queryByText("후보를 3개 채우지 않은 이유")).not.toBeInTheDocument();
  });

  it("후보 1개의 SHA를 색인해 제목과 PR 번호 및 부족 사유를 표시한다", () => {
    const commits = [commit("representative", "후보 목록 구현", [{ number: 45, title: "후보 목록", state: "open", url: "https://example.com/45", baseBranch: "develop", headBranch: "feature" }])];
    renderList([candidate("representative", { source: "contribution_match" })], commits, "독립적인 근거가 하나뿐입니다.");

    expect(screen.getByText("후보 목록 구현")).toBeInTheDocument();
    expect(screen.getByText("PR #45")).toBeInTheDocument();
    expect(screen.getByText("기여 항목 일치")).toBeInTheDocument();
    expect(screen.getByText(/독립적인 근거가 하나뿐입니다/)).toBeInTheDocument();
  });

  it("관련 커밋과 인용 파일이 없으면 각각 0개로 표시한다", () => {
    renderList([candidate("a")], [commit("a", "빈 근거 규모")], "하나뿐입니다.");

    expect(screen.getByText("관련 커밋 0개")).toBeInTheDocument();
    expect(screen.getByText("인용 파일 0개")).toBeInTheDocument();
    expect(screen.getByText("PR 정보 없음")).toBeInTheDocument();
  });

  it("관련 SHA와 인용 파일을 원본 순서대로 중복 제거하고 대표 SHA는 관련 커밋에서 제외한다", () => {
    const commits = [commit("representative", "근거 정규화")];
    const candidateItem = candidate("representative", {
      relatedShas: ["related-b", "representative", "related-a", "related-b"],
      citedFilePaths: ["src/b.ts", "src/a.ts", "src/b.ts"],
    });
    const data: CandidateDataOutput = {
      allCommits: commits,
      includedCommits: commits,
      repository: { fileTree: [], treeTruncated: false, languages: {} },
    };
    const candidates: StageBCandidateResult = {
      candidates: [candidateItem],
      insufficientCandidatesReason: "하나뿐입니다.",
      diffs: [],
    };

    expect(createExperienceCandidateListItems(data, candidates)[0]).toMatchObject({
      candidate: candidateItem,
      normalizedRelatedShas: ["related-b", "related-a"],
      normalizedCitedFilePaths: ["src/b.ts", "src/a.ts"],
    });
    render(<ExperienceCandidateList repository={{ owner: "hm1n", repo: "demian" }} data={data} candidates={candidates} onSelectRepository={vi.fn()} />);
    expect(screen.getByText("관련 커밋 2개")).toBeInTheDocument();
    expect(screen.getByText("인용 파일 2개")).toBeInTheDocument();
  });

  it("대표 SHA를 커밋 색인에서 찾지 못하면 목록과 상세에서 계약 파손을 드러낸다", () => {
    renderList([candidate("abcdef123456")], [], "하나뿐입니다.");

    expect(screen.getByText("커밋 색인 실패 · abcdef1")).toBeInTheDocument();
    expect(screen.getByText("커밋 색인 실패")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /커밋 색인 실패 · abcdef1/ }));
    expect(screen.getByRole("heading", { name: "커밋 색인 실패 · abcdef1" })).toBeInTheDocument();
    expect(screen.getByText("대표 커밋을 커밋 색인에서 찾지 못했습니다.")).toBeInTheDocument();
  });

  it("후보 상세에 진입했다가 목록으로 돌아온다", () => {
    renderList([candidate("a")], [commit("a", "상세 전환")], "하나뿐입니다.");

    fireEvent.click(screen.getByRole("button", { name: /상세 전환/ }));
    expect(screen.getByRole("heading", { name: "상세 전환" })).toBeInTheDocument();
    expect(screen.getByText("표시할 코드 변경 내역이 없습니다")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "← 후보 목록으로" }));
    expect(screen.getByText(/경험 후보 1개를 선정했습니다/)).toBeInTheDocument();
  });
});
