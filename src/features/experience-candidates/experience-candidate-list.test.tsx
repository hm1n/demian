// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";
import type { ExperienceCandidate, StageBCandidateResult } from "./types";
import {
  createExperienceCandidateListItems,
  ExperienceCandidateList,
  type StageASelectionDisplay,
} from "./experience-candidate-list";
import type { ExcludedCommit } from "./work-unit";
import type { ExcludedWorkUnit } from "./work-unit-selection";
import type { WorkUnit } from "./work-unit";

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

const excludedCommit = (sha: string, title: string): ExcludedCommit => ({ sha, title, reason: "no_pull_request" });

function workUnit(number: number): WorkUnit<ReadonlyCommitDetail> {
  return {
    pullRequestNumber: number,
    pullRequest: { number, title: `묶음 제목 ${number}`, state: "closed", baseBranch: "develop", headBranch: `f-${number}` },
    commits: [commit(`sha-unit-${number}`, `묶음 제목 ${number}`)],
  };
}

function excludedUnit(
  number: number,
  score: number,
  reason: ExcludedWorkUnit<ReadonlyCommitDetail>["reason"],
  signals: ExcludedWorkUnit<ReadonlyCommitDetail>["signals"] = []
): ExcludedWorkUnit<ReadonlyCommitDetail> {
  return { unit: workUnit(number), score, reason, signals };
}

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

  it("출처 배지가 검증을 주장하지 않고 근거 문장이 확인 불가임을 안내한다", () => {
    renderList([candidate("a")], [commit("a", "상태 머신 구현")], "하나뿐입니다.");

    expect(screen.queryByText("Repository 근거")).not.toBeInTheDocument();
    expect(screen.getByText("확인 불가 · AI가 작성한 해석입니다")).toBeInTheDocument();
  });

  it("출처(origin)와 검증 여부(확인 가능·불가)를 서로 다른 축으로 표시한다", () => {
    renderList([candidate("a")], [commit("a", "상태 머신 구현")], "하나뿐입니다.");

    expect(screen.getByText("출처: Repository")).toBeInTheDocument();
    expect(screen.getByText("확인 가능")).toBeInTheDocument();
    expect(screen.getByText("확인 불가 · AI가 작성한 해석입니다")).toBeInTheDocument();
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

  it("카드 버튼의 접근성 이름은 제목과 출처만 담고 근거 문장·안내·지표까지 이어 붙이지 않는다", () => {
    renderList([candidate("a")], [commit("a", "접근성 이름 검증")], "하나뿐입니다.");

    expect(screen.getByRole("button", { name: "접근성 이름 검증 · 출처: Repository" })).toBeInTheDocument();
  });

  it("카드 버튼은 짧은 이름과 별개로 근거 문장·확인 가능·불가 안내·지표를 접근성 설명으로 계속 노출한다", () => {
    const commits = [
      commit("a", "접근성 설명 검증", [{ number: 9, title: "설명", state: "open", url: "https://example.com/9", baseBranch: "develop", headBranch: "feature" }]),
    ];
    renderList([candidate("a", { source: "contribution_match" })], commits, "하나뿐입니다.");

    const button = screen.getByRole("button", { name: "접근성 설명 검증 · 출처: Repository" });
    expect(button).toHaveAccessibleDescription(/기여 항목 일치/);
    expect(button).toHaveAccessibleDescription(/확인 불가 · AI가 작성한 해석입니다/);
    expect(button).toHaveAccessibleDescription(/확인 가능/);
    expect(button).toHaveAccessibleDescription(/PR #9/);
  });

  it("인용 파일·관련 커밋 개수는 AI 선택으로 표시하고 확인 가능 태그는 PR 정보 앞에만 둔다", () => {
    const commits = [
      commit("a", "표시 범위 검증", [{ number: 8, title: "표시 범위", state: "open", url: "https://example.com/8", baseBranch: "develop", headBranch: "feature" }]),
    ];
    renderList([candidate("a", { citedFilePaths: ["src/unrelated.ts"], relatedShas: [] })], commits, "하나뿐입니다.");

    const citedFilesEl = screen.getByText("인용 파일 1개");
    expect(citedFilesEl.previousElementSibling).toHaveTextContent("AI 선택");

    const relatedCommitsEl = screen.getByText("관련 커밋 0개");
    expect(relatedCommitsEl.nextElementSibling).toHaveTextContent("확인 가능");

    const prEl = screen.getByText("PR #8");
    expect(prEl.previousElementSibling).toHaveTextContent("확인 가능");
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

const EMPTY_SELECTION: StageASelectionDisplay = {
  excludedCommits: [],
  excludedUnits: [],
  thresholdScore: 0,
  unjudgedShas: [],
};

function renderListWithSelection(stageASelection: StageASelectionDisplay) {
  const commits = [commit("a", "선별 화면 검증")];
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
  render(
    <ExperienceCandidateList
      repository={{ owner: "hm1n", repo: "demian" }}
      data={data}
      candidates={candidates}
      stageASelection={stageASelection}
      onSelectRepository={vi.fn()}
    />
  );
}

describe("ExperienceCandidateList의 Stage A 제외 표시(이슈 #58 Task 8·9)", () => {
  it("제외된 값이 전부 비어 있으면 제외 구획을 렌더하지 않는다", () => {
    renderListWithSelection(EMPTY_SELECTION);

    expect(screen.queryByRole("heading", { name: "1차 선별에서 제외된 항목" })).not.toBeInTheDocument();
  });

  it("stageASelection을 넘기지 않아도 목록이 정상 렌더된다", () => {
    renderList([candidate("a")], [commit("a", "선택 없이 렌더")], "하나뿐입니다.");

    expect(screen.queryByRole("heading", { name: "1차 선별에서 제외된 항목" })).not.toBeInTheDocument();
    expect(screen.getByText("선택 없이 렌더")).toBeInTheDocument();
  });

  it("PR 없는 커밋 건수와 사유를 표시하고 펼치면 SHA 7자와 제목을 보여준다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      excludedCommits: [excludedCommit("abcdef1234567", "잡무 커밋"), excludedCommit("0123456789abcdef", "오타 수정")],
    });

    expect(screen.getByText("Pull Request에 속하지 않아 제외한 커밋 2건")).toBeInTheDocument();
    expect(screen.getByText(/커밋 하나만으로는 설명할 경험을 판단하기 어려워/)).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("잡무 커밋")).toBeInTheDocument();
    expect(screen.getByText("0123456")).toBeInTheDocument();
  });

  it("PR 없는 커밋이 0건이면 그 구획을 렌더하지 않는다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      excludedUnits: [excludedUnit(1, 1, "below_score_threshold")],
      thresholdScore: 1,
    });

    expect(screen.queryByText(/제외한 커밋/)).not.toBeInTheDocument();
  });

  it("점수 컷에서 밀린 묶음을 점수 내림차순으로 보여주고 PR·제목·점수·신호를 표시한다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      thresholdScore: 3,
      excludedUnits: [
        excludedUnit(1, 1, "below_score_threshold", ["many_commits"]),
        excludedUnit(2, 2, "below_score_threshold", ["many_files", "long_span"]),
      ],
    });

    expect(screen.getByText("점수 3점 미만 2묶음을 판단 대상에서 제외했습니다")).toBeInTheDocument();
    expect(screen.getByText("PR #2")).toBeInTheDocument();
    expect(screen.getByText("PR #1")).toBeInTheDocument();
    expect(screen.getByText("2점 · 휴리스틱")).toBeInTheDocument();
    expect(screen.getByText("고친 파일이 많습니다")).toBeInTheDocument();
    expect(screen.getByText("여러 날에 걸쳐 작업했습니다")).toBeInTheDocument();

    // 컷 바로 아래(점수가 더 높은) 묶음이 먼저 나옵니다.
    const items = screen.getAllByText(/^PR #\d+$/);
    expect(items.map((el) => el.textContent)).toEqual(["PR #2", "PR #1"]);
  });

  it("분량 상한 제외와 점수 컷 제외를 서로 다른 구획으로 나눠 보여준다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      thresholdScore: 2,
      excludedUnits: [
        excludedUnit(1, 2, "below_score_threshold"),
        excludedUnit(2, 5, "over_byte_budget"),
      ],
    });

    expect(screen.getByText("점수 2점 미만 1묶음을 판단 대상에서 제외했습니다")).toBeInTheDocument();
    expect(screen.getByText("한 번에 보낼 수 있는 분량을 넘어 1묶음을 제외했습니다")).toBeInTheDocument();
  });

  it("모델이 판단하지 못한 묶음 건수를 표시한다", () => {
    renderListWithSelection({ ...EMPTY_SELECTION, unjudgedShas: ["deadbeef00112233"] });

    expect(screen.getByText("모델이 판단하지 못한 묶음 1건")).toBeInTheDocument();
    expect(screen.getByText(/제외한 것이 아니라 판단이 없는 상태입니다/)).toBeInTheDocument();
    expect(screen.getByText("deadbee")).toBeInTheDocument();
  });

  it("점수는 확인 가능 태그를 쓰지 않고 PR 정보는 확인 가능 태그로 표시한다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      thresholdScore: 1,
      excludedUnits: [excludedUnit(1, 1, "below_score_threshold")],
    });

    const scoreEl = screen.getByText("1점 · 휴리스틱");
    expect(scoreEl).not.toHaveTextContent("확인 가능");
    const prEl = screen.getByText("PR #1");
    expect(prEl.previousElementSibling).toHaveTextContent("확인 가능");
  });

  it("제외 구획은 키보드로 펼치고 접을 수 있고 펼침 상태가 details의 open 속성으로 드러난다", () => {
    renderListWithSelection({
      ...EMPTY_SELECTION,
      excludedCommits: [excludedCommit("abcdef1234567", "잡무 커밋")],
    });

    const details = screen.getByText("Pull Request에 속하지 않아 제외한 커밋 1건").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Pull Request에 속하지 않아 제외한 커밋 1건"));
    expect(details).toHaveAttribute("open");

    fireEvent.click(screen.getByText("Pull Request에 속하지 않아 제외한 커밋 1건"));
    expect(details).not.toHaveAttribute("open");
  });

  it("andbread처럼 제외 묶음이 많아도 목록이 스크롤 영역에 담겨 후보 목록을 밀어내지 않는다", () => {
    const many = Array.from({ length: 56 }, (_, index) => excludedUnit(index + 1, 1, "below_score_threshold"));
    renderListWithSelection({ ...EMPTY_SELECTION, thresholdScore: 2, excludedUnits: many });

    expect(screen.getByText("점수 2점 미만 56묶음을 판단 대상에서 제외했습니다")).toBeInTheDocument();
    const details = screen.getByText("점수 2점 미만 56묶음을 판단 대상에서 제외했습니다").closest("details");
    const list = details?.querySelector("ul");
    expect(list?.className).toMatch(/scrollableList/);
  });
});
