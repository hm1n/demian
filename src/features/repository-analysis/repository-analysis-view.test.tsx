// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeRepository,
  generateCandidates,
  type AnalysisError,
  type AnalysisState,
  type CandidateRetryPoint,
  type StageASelectionState,
} from "./repository-analysis";
import { parseContributionItems, RepositoryAnalysisView } from "./repository-analysis-view";

vi.mock("./repository-analysis", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository-analysis")>();
  return { ...original, analyzeRepository: vi.fn(), generateCandidates: vi.fn() };
});

const analyzeMock = vi.mocked(analyzeRepository);
const generateMock = vi.mocked(generateCandidates);

const RETRY_POINT: CandidateRetryPoint = {
  repository: { owner: "octocat", repo: "hello-world" },
  contributionItems: [],
  data: { allCommits: [], includedCommits: [], repository: { fileTree: [], treeTruncated: false, languages: {} } },
};
const GITHUB_TOKEN = "github_pat_secret_value";
/** 이 화면 안내 스위트는 Stage A 선별 표시 자체가 아니라 후보 목록 표시를 검증하므로 빈 값을 씁니다. */
const EMPTY_STAGE_A_SELECTION: StageASelectionState = {
  excludedCommits: [],
  excludedUnits: [],
  thresholdScore: 0,
  unjudgedShas: [],
};

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
  analyzeMock.mockImplementation(async (_auth, _items, onStateChange) => onStateChange(state));
}

beforeEach(() => {
  analyzeMock.mockReset();
  generateMock.mockReset();
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
      [{ status: "loading", loading: { step: "stage_a", completed: 2, total: 5, waitingForRateLimit: false } }, "4단계", "경험 후보를 1차 선별하고 있습니다"],
    [{ status: "loading", loading: { step: "stage_b" } }, "5·6단계", "diff·PR 근거를 수집하고 최종 후보를 판단하고 있습니다"],
  ] as const)("각 단계의 %s 상태를 구분해 표시한다", async (state, step, copy) => {
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

  it("기여 항목을 줄 단위 목록으로 파싱해 분석 파이프라인에 전달한다", async () => {
    render(<RepositoryAnalysisView />);
    fireEvent.change(screen.getByLabelText(/^본인 기여 항목/), { target: { value: "푸시 알림 구현\n게시판 기능 구현" } });
    await submitRepository();
    expect(analyzeMock).toHaveBeenCalledWith(
      { owner: "octocat", repo: "hello-world" },
      ["푸시 알림 구현", "게시판 기능 구현"],
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
    ["no_stage_a_candidates", "설명할 만한 경험 후보를 찾지 못했습니다"],
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

describe("RepositoryAnalysisView 후보 생성 상태", () => {
  it("최종 후보 0개 Empty에 서버가 보낸 부족 사유와 기준 유지 안내를 함께 표시한다", async () => {
    mockState({ status: "empty", kind: "no_final_candidates", reason: "실제 diff 근거로 설명할 수 있는 커밋이 없습니다." });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByRole("heading", { name: "최종 경험 후보를 만들지 못했습니다" })).toBeInTheDocument();
    expect(screen.getByText("실제 diff 근거로 설명할 수 있는 커밋이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText(/기준을 완화하거나 후보를 임의로 채우지 않습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다른 Repository 선택" })).toBeInTheDocument();
    // 후보 0개는 이 Empty가 처리하므로 후보 목록과 선택 액션에 도달하지 않습니다(이슈 #55).
    expect(screen.queryByRole("button", { name: "이 경험으로 인터뷰 시작" })).not.toBeInTheDocument();
  });

  it("후보가 3개 미만인 성공 상태에 생성 개수와 부족 사유를 안내한다", async () => {
    mockState({
      status: "success",
      data: RETRY_POINT.data,
      candidates: {
        candidates: [
          { sha: "a1b2c3d4e5", relatedShas: [], evidence: "상태 머신을 구현했습니다.", citedFilePaths: [], source: "contribution_match" },
          { sha: "f6e5d4c3b2", relatedShas: [], evidence: "오류 계약을 정의했습니다.", citedFilePaths: [], source: "automatic_recommendation" },
        ],
        insufficientCandidatesReason: "나머지 커밋은 diff 근거가 부족합니다.",
        diffs: [],
      },
      stageASelection: EMPTY_STAGE_A_SELECTION,
    });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByText(/경험 후보 2개를 선정했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/나머지 커밋은 diff 근거가 부족합니다/)).toBeInTheDocument();
    expect(screen.getByText(/기준을 완화하거나 후보를\s*임의로 채우지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText("기여 항목 일치")).toBeInTheDocument();
    expect(screen.getByText("자동 추천")).toBeInTheDocument();
    expect(screen.getByText("상태 머신을 구현했습니다.")).toBeInTheDocument();
  });

  it("입력 필드를 수정해도 상세 링크는 분석한 Repository를 유지한다", async () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockState({
      status: "success",
      data: RETRY_POINT.data,
      candidates: {
        candidates: [{ sha, relatedShas: [], evidence: "근거입니다.", citedFilePaths: [], source: "automatic_recommendation" }],
        insufficientCandidatesReason: "하나뿐입니다.",
        diffs: [],
      },
      stageASelection: EMPTY_STAGE_A_SELECTION,
    });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "wrong-owner" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "wrong-repo" } });
    fireEvent.click(screen.getByRole("button", { name: /커밋 색인 실패 · aaaaaaa/ }));

    expect(screen.getByRole("link", { name: "대표 커밋 aaaaaaa" })).toHaveAttribute(
      "href",
      `https://github.com/octocat/hello-world/commit/${sha}`
    );
  });

  it("후보가 3개이면 부족 사유 안내 없이 후보 목록을 표시한다", async () => {
    const candidate = { relatedShas: [], evidence: "근거입니다.", citedFilePaths: [], source: "automatic_recommendation" } as const;
    mockState({
      status: "success",
      data: RETRY_POINT.data,
      candidates: {
        candidates: [
          { ...candidate, sha: "sha-a-40" },
          { ...candidate, sha: "sha-b-40" },
          { ...candidate, sha: "sha-c-40" },
        ],
        insufficientCandidatesReason: null,
        diffs: [],
      },
      stageASelection: EMPTY_STAGE_A_SELECTION,
    });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByText(/경험 후보 3개를 선정했습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/후보를 3개 채우지 않은 이유/)).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: "llm_call_failure", title: "LLM 호출에 실패했습니다", message: "잠시 후", recovery: "retry" }],
    [{ kind: "llm_schema_violation", title: "LLM 응답이 출력 계약을 지키지 않았습니다", message: "버림", recovery: "retry" }],
    [{ kind: "llm_hallucination_rejected", title: "실제 Repository 근거와 맞지 않는 판단을 거부했습니다", message: "버림", recovery: "retry" }],
  ] as AnalysisError[][])("후보 생성 오류 %s에 후보 생성 재시도 버튼을 표시한다", async (error) => {
    mockState({ status: "error", error, retryPoint: RETRY_POINT });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByRole("alert")).toHaveAttribute("data-error-kind", error.kind);
    expect(screen.getByRole("button", { name: "후보 생성 다시 시도" })).toBeInTheDocument();
  });

  it("retryPoint가 있는 오류의 재시도는 전체 재조회 대신 실패한 단계부터 다시 시작한다", async () => {
    const error: AnalysisError = { kind: "llm_call_failure", title: "실패", message: "재시도", recovery: "retry" };
    mockState({ status: "error", error, retryPoint: RETRY_POINT });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    fireEvent.click(screen.getByRole("button", { name: "후보 생성 다시 시도" }));

    await waitFor(() => expect(generateMock).toHaveBeenCalledWith(RETRY_POINT, expect.any(Function)));
    expect(analyzeMock).toHaveBeenCalledTimes(1);
  });

  it("diff 재조회 실패는 원인에 맞는 복구 동작을 표시한다", async () => {
    const error: AnalysisError = {
      kind: "diff_refetch_failure",
      causeKind: "auth_revoked",
      title: "후보의 diff·PR 근거를 다시 조회하지 못했습니다",
      message: "인증을 다시 진행해 주세요.",
      recovery: "reauthenticate",
    };
    mockState({ status: "error", error, retryPoint: RETRY_POINT });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByRole("alert")).toHaveAttribute("data-error-kind", "diff_refetch_failure");
    expect(screen.getByRole("button", { name: "GitHub 인증 다시 하기" })).toBeInTheDocument();
  });

  it("요청 크기 초과는 Repository 재선택으로 복구한다", async () => {
    const error: AnalysisError = {
      kind: "request_too_large",
      title: "분석 데이터가 요청 한도를 초과했습니다",
      message: "더 작은 Repository를 선택해 주세요.",
      recovery: "select_repository",
    };
    mockState({ status: "error", error, retryPoint: RETRY_POINT });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    expect(screen.getByRole("button", { name: "Repository 다시 선택" })).toBeInTheDocument();
  });

  it("계약 위반 오류는 retryPoint 없이 전체 조회 재시도로 처음부터 입력을 다시 구성한다", async () => {
    const error: AnalysisError = {
      kind: "server_error",
      title: "후보 생성 요청이 서버 계약과 맞지 않았습니다",
      message: "같은 입력을 그대로 다시 보내지 않고 Repository 조회부터 다시 구성해 재시도합니다.",
      recovery: "retry",
    };
    mockState({ status: "error", error });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    fireEvent.click(screen.getByRole("button", { name: "전체 조회 다시 시도" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(2));
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("인증 재진행 후에는 retryPoint를 버리고 처음부터 다시 분석한다", async () => {
    const error: AnalysisError = {
      kind: "diff_refetch_failure",
      causeKind: "auth_revoked",
      title: "후보의 diff·PR 근거를 다시 조회하지 못했습니다",
      message: "인증을 다시 진행해 주세요.",
      recovery: "reauthenticate",
    };
    mockState({ status: "error", error, retryPoint: RETRY_POINT });
    render(<RepositoryAnalysisView />);
    await submitRepository();

    fireEvent.click(screen.getByRole("button", { name: "GitHub 인증 다시 하기" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    fillRepository();
    fireEvent.click(screen.getByRole("button", { name: "Repository 분석 시작" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledTimes(2));
    expect(generateMock).not.toHaveBeenCalled();
  });
});
