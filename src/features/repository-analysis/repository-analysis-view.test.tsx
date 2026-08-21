// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeRepository, type AnalysisError, type AnalysisState } from "./repository-analysis";
import { parseContributionItems, RepositoryAnalysisView } from "./repository-analysis-view";

vi.mock("./repository-analysis", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository-analysis")>();
  return { ...original, analyzeRepository: vi.fn() };
});

const analyzeMock = vi.mocked(analyzeRepository);
const GITHUB_TOKEN = "github_pat_secret_value";

function fillRepository() {
  fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "octocat" } });
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "hello-world" } });
  fireEvent.change(screen.getByLabelText(/^GitHub token/), { target: { value: GITHUB_TOKEN } });
}

async function submitRepository() {
  fillRepository();
  fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));
  await waitFor(() => expect(analyzeMock).toHaveBeenCalled());
}

function mockState(state: AnalysisState) {
  analyzeMock.mockImplementation(async (_auth, onStateChange) => onStateChange(state));
}

beforeEach(() => {
  analyzeMock.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
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
  ] as const)("세 단계 중 %s 상태를 구분해 표시한다", async (state, step, copy) => {
    mockState(state);
    render(<RepositoryAnalysisView />);
    await submitRepository();
    expect(screen.getByRole("status")).toHaveTextContent(step);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
  });
});

describe("RepositoryAnalysisView 기여 항목", () => {
  it.each([
    ["푸시 알림 구현\n게시판 기능 구현", ["푸시 알림 구현", "게시판 기능 구현"]],
    ["", []],
    ["  푸시 알림 구현  \n\n  ", ["푸시 알림 구현"]],
  ])("입력 있음·없음·일부 상태를 줄 단위 목록으로 파싱한다", (value, expected) => {
    expect(parseContributionItems(value)).toEqual(expected);
  });

  it("기여 항목 입력 여부와 무관하게 기존 Repository 분석을 시작한다", async () => {
    render(<RepositoryAnalysisView />);
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "푸시 알림 구현" } });
    await submitRepository();
    expect(analyzeMock).toHaveBeenCalledWith(
      { owner: "octocat", repo: "hello-world" },
      expect.any(Function)
    );
  });

  it("오류 후 수정한 기여 항목을 재시도해도 현재 입력값을 유지한다", async () => {
    mockState({ status: "error", error: { kind: "network", title: "네트워크 실패", message: "연결 확인", recovery: "retry" } });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "게시판 기능 구현" } });
    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));
    expect(screen.getByLabelText(/^본인 기여 항목/)).toHaveValue("게시판 기능 구현");
  });

  it("다른 Repository를 선택하면 이전 Repository의 기여 항목을 지운다", async () => {
    mockState({ status: "empty", kind: "no_commits" });
    render(<RepositoryAnalysisView />);
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "푸시 알림 구현" } });
    await submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "다른 Repository 선택" }));
    expect(screen.getByLabelText(/^본인 기여 항목/)).toHaveValue("");
  });
});

describe("RepositoryAnalysisView Empty", () => {
  it.each([
    ["no_commits", "분석할 커밋이 없습니다"],
    ["no_author_commits", "본인이 작성한 커밋이 없습니다"],
    ["no_analyzable_commits", "이 저장소는 분석하기 어렵습니다"],
  ] as const)("%s를 별도 안내로 표시한다", async (kind, title) => {
    mockState({ status: "empty", kind });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다른 Repository 선택" })).toBeInTheDocument();
  });

  it("다른 Repository를 선택하면 이미 만든 인증 세션을 재사용한다", async () => {
    mockState({ status: "empty", kind: "no_commits" });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "다른 Repository 선택" }));
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "hm1n" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "demian" } });
    fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(2));
    expect(analyzeMock.mock.calls[1][0]).toEqual({ owner: "hm1n", repo: "demian" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("기존 세션이 있어도 새 토큰을 입력하면 세션 쿠키를 교체한다", async () => {
    mockState({ status: "empty", kind: "no_commits" });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "다른 Repository 선택" }));
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "hm1n" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "demian" } });
    fireEvent.change(screen.getByLabelText(/^GitHub token/), { target: { value: "new_token" } });
    fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ token: "new_token" }),
    }));
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

  it.each(errors)("%s 오류에 맞는 안내와 복구 버튼을 표시한다", async (error, action) => {
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-kind", error.kind);
    expect(screen.getByRole("alert")).toHaveTextContent(error.message);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });

  it("네트워크·서버 오류의 재시도 버튼은 같은 Repository를 전체 재조회한다", async () => {
    const error: AnalysisError = { kind: "network", title: "네트워크 실패", message: "연결 확인", recovery: "retry" };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));
    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(2));
    expect(analyzeMock.mock.calls[1][0]).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("인증 재진행을 선택하면 쿠키와 기존 토큰을 지우고 새 인증 입력을 기다린다", async () => {
    const error: AnalysisError = { kind: "auth_revoked", title: "인증 취소", message: "인증 필요", recovery: "reauthenticate" };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    fireEvent.click(screen.getByRole("button", { name: "GitHub 인증 다시 하기" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue("");
    expect(fetch).toHaveBeenLastCalledWith("/api/auth/session", { method: "DELETE" });
  });

  it("쿠키 삭제 요청이 거부되어도 로컬 인증 정보를 지우고 재입력을 허용한다", async () => {
    const error: AnalysisError = { kind: "auth_revoked", title: "인증 취소", message: "인증 필요", recovery: "reauthenticate" };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));

    fireEvent.click(screen.getByRole("button", { name: "GitHub 인증 다시 하기" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue("");
    expect(screen.getByLabelText(/^GitHub token/)).toBeRequired();
  });

  it("세션 발급 네트워크 실패는 토큰을 보존하고 재시도한다", async () => {
    render(<RepositoryAnalysisView />);
    fillRepository();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));

    expect(await screen.findByRole("alert")).toHaveAttribute("data-error-kind", "network");
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue(GITHUB_TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({
      body: JSON.stringify({ token: GITHUB_TOKEN }),
    }));
  });

  it("세션 발급 500 응답은 토큰을 보존하고 재시도한다", async () => {
    render(<RepositoryAnalysisView />);
    fillRepository();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));

    expect(await screen.findByRole("alert")).toHaveAttribute("data-error-kind", "server_error");
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue(GITHUB_TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenLastCalledWith("/api/auth/session", expect.objectContaining({
      body: JSON.stringify({ token: GITHUB_TOKEN }),
    }));
  });

  it("세션 응답과 DOM에 입력한 토큰을 남기지 않는다", async () => {
    mockState({ status: "empty", kind: "no_commits" });
    render(<RepositoryAnalysisView />);
    await submitRepository();
    expect(screen.getByLabelText(/^GitHub token/)).toHaveValue("");
    expect(document.body.textContent).not.toContain(GITHUB_TOKEN);
  });
});
