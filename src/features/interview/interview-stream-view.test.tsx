// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewStreamView } from "./interview-stream-view";
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
