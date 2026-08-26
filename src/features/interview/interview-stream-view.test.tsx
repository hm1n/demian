// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewStreamView } from "./interview-stream-view";
import { evidenceSnapshotFixture } from "./question-fixture";
import { encodeSseEvent } from "./sse";

afterEach(cleanup);

/** 테스트가 청크 도착 시점을 직접 정하려고 컨트롤러를 밖으로 꺼냅니다. */
function controllableResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: { ok: true, status: 200, body: stream } as unknown as Response,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      controller.close();
    },
  };
}

/** 프레임 배칭은 별도로 검증하므로 화면 테스트에서는 즉시 실행합니다. */
const renderOptions = {
  scheduleFrame: (callback: () => void) => {
    callback();
    return 0;
  },
  cancelFrame: () => {},
  sleep: async () => {},
};

function setScroll(container: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(container, "scrollHeight", { value: values.scrollHeight, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: values.clientHeight, configurable: true });
  container.scrollTop = values.scrollTop;
}

describe("InterviewStreamView", () => {
  it("첫 내용이 도착하기 전에는 준비 안내를 보여 준다", async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>(() => {}));

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);

    expect(await screen.findByText("질문을 준비하고 있습니다.")).toBeInTheDocument();
  });

  it("도착한 순서대로 내용을 이어 붙여 표시한다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "청크 경계를 " }));
    source.push(encodeSseEvent({ type: "chunk", seq: 2, text: "세 조건으로 닫은 이유" }));
    source.push(encodeSseEvent({ type: "done", seq: 2 }));

    expect(await screen.findByText("청크 경계를 세 조건으로 닫은 이유")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("질문이 모두 도착했습니다.")).toBeInTheDocument());
  });

  it("위로 스크롤하면 자동 스크롤을 멈추고 새 메시지 도착을 안내한다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "첫 문장" }));
    await screen.findByText("첫 문장");

    const log = screen.getByRole("log");
    setScroll(log, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(log);

    source.push(encodeSseEvent({ type: "chunk", seq: 2, text: " 둘째 문장" }));

    const button = await screen.findByRole("button", { name: "새 메시지 보기" });
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description).toHaveTextContent("자동 스크롤을 멈춘 동안 새 내용이 도착했습니다.");
  });

  it("하단으로 돌아오면 안내를 지우고 자동 스크롤을 재개한다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "첫 문장" }));
    await screen.findByText("첫 문장");

    const log = screen.getByRole("log");
    setScroll(log, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(log);
    source.push(encodeSseEvent({ type: "chunk", seq: 2, text: " 둘째 문장" }));
    const button = await screen.findByRole("button", { name: "새 메시지 보기" });

    setScroll(log, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 800 });
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "새 메시지 보기" })).not.toBeInTheDocument()
    );
    expect(log.scrollTop).toBe(1_000);
  });

  it("전송 중 끊기면 이미 도착한 내용을 지우지 않고 다시 시도할 방법을 준다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} retryDelaysMs={[]} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "이미 도착한 내용" }));
    await screen.findByText("이미 도착한 내용");
    source.close();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("질문을 받는 도중 연결이 끊겼습니다.");
    expect(screen.getByText("이미 도착한 내용")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "다시 시도" });
    const description = document.getElementById(retry.getAttribute("aria-describedby") ?? "");
    expect(description).toHaveTextContent("다시 시도하면 받은 지점부터 이어받습니다.");
  });

  it("다시 시도 버튼은 받은 지점부터 이어받는 요청을 보낸다", async () => {
    const first = controllableResponse();
    const second = controllableResponse();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} retryDelaysMs={[]} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    first.push(encodeSseEvent({ type: "chunk", seq: 1, text: "앞부분" }));
    await screen.findByText("앞부분");
    first.close();
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[1][1].headers["Last-Event-ID"]).toBe("1");
  });

  it("연결을 시작하지 못하면 시작 실패로 안내한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, body: null } as unknown as Response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("질문 스트리밍 연결을 시작하지 못했습니다.");
    expect(alert).toHaveTextContent("아직 받은 내용은 없습니다.");
  });

  it("서버가 보낸 분류에 맞는 안내를 보여 준다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
      json: () =>
        Promise.resolve({
          error: { kind: "llm_rate_limit", message: "질문 생성 호출 한도에 걸렸습니다." },
        }),
    } as unknown as Response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("질문 생성 호출 한도에 걸렸습니다.");
    expect(alert).toHaveTextContent("잠시 뒤에 다시 시도해 주세요.");
    // 한도 초과에 네트워크 확인 안내가 나가면 안 됩니다.
    expect(alert).not.toHaveTextContent("네트워크 상태를 확인");
  });

  it("자라나는 메시지가 아니라 상태와 새 메시지 안내를 낭독 대상으로 둔다", async () => {
    const { push, response } = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(response);

    render(<InterviewStreamView fetchImpl={fetchImpl} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    push(encodeSseEvent({ type: "chunk", seq: 1, text: "질문" }));
    await screen.findByText("질문");

    // 스트리밍 중에는 메시지 하나의 텍스트가 계속 자랍니다. 이 자리가 live region이면 스크린리더가
    // 커지는 질문 전체를 프레임마다 다시 읽습니다.
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off");

    const liveRegions = document.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBe(2);
    // 안내 문단은 내용이 비어 있어도 남아 있어야 합니다. live region은 붙어 있는 동안의 변경만
    // 알리므로, 내용을 담은 채 새로 나타나면 낭독되지 않는 스크린리더가 있습니다.
    expect(screen.queryByRole("button", { name: "새 메시지 보기" })).not.toBeInTheDocument();
  });
});

describe("InterviewStreamView 실제 생성 경로", () => {
  const snapshot = evidenceSnapshotFixture();

  it("근거 스냅샷을 POST 본문으로 보낸다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} snapshot={snapshot} {...renderOptions} />);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ snapshot });
  });

  it("이어받을 수 없다고 안내하고 다시 시도는 처음부터 새로 만든다", async () => {
    const first = controllableResponse();
    const second = controllableResponse();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);

    render(
      <InterviewStreamView
        fetchImpl={fetchImpl}
        snapshot={snapshot}
        retryDelaysMs={[]}
        {...renderOptions}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    first.push(encodeSseEvent({ type: "chunk", seq: 1, text: "앞부분" }));
    await screen.findByText("앞부분");
    first.close();

    const retry = await screen.findByRole("button", { name: "다시 시도" });
    const description = document.getElementById(retry.getAttribute("aria-describedby") ?? "");
    expect(description).toHaveTextContent("처음부터 새로 만듭니다");
    expect(description).not.toHaveTextContent("받은 지점부터 이어받습니다");

    fireEvent.click(retry);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    // 이어받기 헤더를 보내면 서버가 거절합니다. 이미 표시된 앞부분도 지웁니다. 남겨 두면 새로 만든
    // 질문이 그 뒤에 붙어 한 메시지 안에서 서로 다른 질문이 이어집니다.
    expect(fetchImpl.mock.calls[1][1].headers["Last-Event-ID"]).toBeUndefined();
    await waitFor(() => expect(screen.queryByText("앞부분")).not.toBeInTheDocument());
  });

  it("청크 없이 끝난 스트림은 완료가 아니라 오류로 알린다", async () => {
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} snapshot={snapshot} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    source.push(encodeSseEvent({ type: "done", seq: 0 }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("질문을 만들지 못했습니다.");
    expect(alert).toHaveTextContent("질문 내용이 한 조각도 오지 않았습니다.");
    expect(screen.queryByText("질문이 모두 도착했습니다.")).not.toBeInTheDocument();
  });

  it("청크를 받은 뒤 생성 오류가 나면 다시 시도가 내용을 지운다고 알린다", async () => {
    // 이어받을 수 없는 경로에서 "이미 받은 내용은 그대로 두었습니다"를 읽고 다시 시도를 누르면
    // 읽던 질문이 사라집니다. 안내와 실제 동작이 어긋납니다.
    const source = controllableResponse();
    const fetchImpl = vi.fn().mockResolvedValue(source.response);

    render(<InterviewStreamView fetchImpl={fetchImpl} snapshot={snapshot} {...renderOptions} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    source.push(encodeSseEvent({ type: "chunk", seq: 1, text: "앞부분" }));
    await screen.findByText("앞부분");
    source.push(
      encodeSseEvent({
        type: "error",
        kind: "llm_rate_limit",
        message: "질문 생성 호출 한도에 걸렸습니다.",
      })
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("지금까지 받은 내용은 사라집니다");
    expect(alert).not.toHaveTextContent("이미 받은 내용은 그대로 두었습니다");
  });

  it("서버 설정 실패를 전송 실패로 뭉개지 않는다", async () => {
    // `server_error`가 아는 분류에 없으면 수신부가 전송 실패로 떨어뜨려 서버 설정 문제에
    // 네트워크 확인 안내가 나갑니다.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      json: () =>
        Promise.resolve({
          error: { kind: "server_error", message: "서버 설정 문제로 질문 생성을 시작하지 못했습니다." },
        }),
    } as unknown as Response);

    render(<InterviewStreamView fetchImpl={fetchImpl} snapshot={snapshot} {...renderOptions} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("서버 설정에 문제가 있어 요청을 처리하지 못했습니다.");
    expect(alert).toHaveTextContent("다시 시도해도 같은 결과가 나옵니다.");
    expect(alert).not.toHaveTextContent("네트워크 상태를 확인");
  });

  it("같은 근거로는 풀리지 않는 실패에는 재시도를 권하지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      body: null,
      json: () =>
        Promise.resolve({ error: { kind: "llm_auth", message: "LLM 인증에 실패했습니다." } }),
    } as unknown as Response);

    render(<InterviewStreamView fetchImpl={fetchImpl} snapshot={snapshot} {...renderOptions} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("다시 시도해도 같은 결과가 나옵니다");
  });
});
