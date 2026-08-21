// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeRepository, type AnalysisError, type AnalysisState } from "./repository-analysis";
import { RepositoryAnalysisView } from "./repository-analysis-view";

vi.mock("./repository-analysis", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository-analysis")>();
  return { ...original, analyzeRepository: vi.fn() };
});

const analyzeMock = vi.mocked(analyzeRepository);

function submitRepository() {
  fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "octocat" } });
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "hello-world" } });
  fireEvent.change(screen.getByLabelText(/^GitHub token/), { target: { value: "token" } });
  fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));
}

function mockState(state: AnalysisState) {
  analyzeMock.mockImplementation(async (_auth, onStateChange) => onStateChange(state));
}

beforeEach(() => {
  analyzeMock.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RepositoryAnalysisView Loading", () => {
  it.each([
    [{ status: "loading", loading: { step: "commits" } }, "1단계", "전체 커밋을 조회하고 있습니다"],
    [{ status: "loading", loading: { step: "details", completed: 2, total: 5, phase: "commit_details" } }, "2단계", "5개 중 2개를 확인했습니다."],
    [{ status: "loading", loading: { step: "deriving" } }, "3단계", "파생 지표를 계산하고 있습니다"],
  ] as const)("세 단계 중 %s 상태를 구분해 표시한다", (state, step, copy) => {
    mockState(state);
    render(<RepositoryAnalysisView />);
    submitRepository();
    expect(screen.getByRole("status")).toHaveTextContent(step);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
  });
});

describe("RepositoryAnalysisView 기여 항목", () => {
  it("입력한 기여 항목을 줄 단위 목록으로 전달한다", () => {
    const onContributionItemsSubmit = vi.fn();
    render(<RepositoryAnalysisView onContributionItemsSubmit={onContributionItemsSubmit} />);
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "푸시 알림 구현\n게시판 기능 구현" } });
    submitRepository();
    expect(onContributionItemsSubmit).toHaveBeenCalledWith(["푸시 알림 구현", "게시판 기능 구현"]);
  });

  it("기여 항목을 생략해도 기존 Repository 분석을 시작한다", () => {
    const onContributionItemsSubmit = vi.fn();
    render(<RepositoryAnalysisView onContributionItemsSubmit={onContributionItemsSubmit} />);
    submitRepository();
    expect(onContributionItemsSubmit).toHaveBeenCalledWith([]);
    expect(analyzeMock).toHaveBeenCalledWith(
      { owner: "octocat", repo: "hello-world", token: "token" },
      expect.any(Function)
    );
  });

  it("일부 행만 입력하면 빈 행을 제외해 전달한다", () => {
    const onContributionItemsSubmit = vi.fn();
    render(<RepositoryAnalysisView onContributionItemsSubmit={onContributionItemsSubmit} />);
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "  푸시 알림 구현  \n\n  " } });
    submitRepository();
    expect(onContributionItemsSubmit).toHaveBeenCalledWith(["푸시 알림 구현"]);
  });
});

describe("RepositoryAnalysisView Empty", () => {
  it.each([
    ["no_commits", "분석할 커밋이 없습니다"],
    ["no_analyzable_commits", "이 저장소는 분석하기 어렵습니다"],
  ] as const)("%s를 별도 안내로 표시한다", (kind, title) => {
    mockState({ status: "empty", kind });
    render(<RepositoryAnalysisView />);
    submitRepository();
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다른 Repository 선택" })).toBeInTheDocument();
  });
});

describe("RepositoryAnalysisView Error", () => {
  const errors: Array<[AnalysisError, string]> = [
    [{ kind: "rate_limit", title: "호출 한도", message: "잠시 후 재시도", recovery: "retry" }, "전체 조회 다시 시도"],
    [{ kind: "auth_revoked", title: "인증 취소", message: "인증 필요", recovery: "reauthenticate" }, "GitHub 인증 다시 하기"],
    [{ kind: "repo_not_found", title: "미존재", message: "이름 확인", recovery: "select_repository" }, "Repository 다시 선택"],
    [{ kind: "partial_failure", causeKind: "rate_limit", title: "일부 실패", message: "3개 중 1개 수집", recovery: "retry", completed: 1, total: 3 }, "전체 조회 다시 시도"],
    [{ kind: "network", title: "네트워크 실패", message: "연결 확인", recovery: "retry" }, "전체 조회 다시 시도"],
    [{ kind: "server_error", title: "서버 실패", message: "잠시 후", recovery: "retry" }, "전체 조회 다시 시도"],
  ];

  it.each(errors)("%s 오류에 맞는 안내와 복구 버튼을 표시한다", (error, action) => {
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    submitRepository();
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-kind", error.kind);
    expect(screen.getByRole("alert")).toHaveTextContent(error.message);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });

  it("네트워크·서버 오류의 재시도 버튼은 같은 Repository를 전체 재조회한다", () => {
    const error: AnalysisError = { kind: "network", title: "네트워크 실패", message: "연결 확인", recovery: "retry" };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));
    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(analyzeMock.mock.calls[1][0]).toEqual({ owner: "octocat", repo: "hello-world", token: "token" });
  });

  it("인증 재진행을 선택하면 기존 토큰을 지우고 새 인증 입력을 기다린다", () => {
    const error: AnalysisError = { kind: "auth_revoked", title: "인증 취소", message: "인증 필요", recovery: "reauthenticate" };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 인증 다시 하기" }));
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
