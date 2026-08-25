// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BOTTOM_THRESHOLD_PX, useAutoScroll } from "./use-auto-scroll";

afterEach(cleanup);

function Probe({ contentKey }: { contentKey: number }) {
  const { containerRef, isPinnedToBottom, hasUnreadContent, handleScroll, scrollToBottom } =
    useAutoScroll<HTMLDivElement>(contentKey);
  return (
    <div>
      <div data-testid="log" ref={containerRef} onScroll={handleScroll} />
      <p data-testid="state">{`${isPinnedToBottom}:${hasUnreadContent}`}</p>
      <button type="button" onClick={scrollToBottom}>
        하단으로
      </button>
    </div>
  );
}

function setScroll(container: HTMLElement, scrollTop: number) {
  Object.defineProperty(container, "scrollHeight", { value: 1_000, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 200, configurable: true });
  container.scrollTop = scrollTop;
}

describe("useAutoScroll", () => {
  it("하단에 붙어 있으면 새 내용이 도착할 때 자동으로 내려간다", () => {
    const { rerender } = render(<Probe contentKey={0} />);
    const log = screen.getByTestId("log");
    setScroll(log, 800);

    rerender(<Probe contentKey={1} />);

    expect(log.scrollTop).toBe(1_000);
    expect(screen.getByTestId("state")).toHaveTextContent("true:false");
  });

  it("위로 스크롤하면 자동 스크롤을 멈추고 새 내용 도착만 알린다", () => {
    const { rerender } = render(<Probe contentKey={0} />);
    const log = screen.getByTestId("log");
    setScroll(log, 0);
    act(() => {
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    rerender(<Probe contentKey={1} />);

    expect(log.scrollTop).toBe(0);
    expect(screen.getByTestId("state")).toHaveTextContent("false:true");
  });

  it("경계값 안쪽은 하단에 붙어 있는 것으로 본다", () => {
    const { result } = renderHook(() => useAutoScroll<HTMLDivElement>(0));
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 1_000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 200, configurable: true });
    result.current.containerRef.current = container;

    container.scrollTop = 800 - BOTTOM_THRESHOLD_PX;
    act(() => result.current.handleScroll());
    expect(result.current.isPinnedToBottom).toBe(true);

    container.scrollTop = 800 - BOTTOM_THRESHOLD_PX - 1;
    act(() => result.current.handleScroll());
    expect(result.current.isPinnedToBottom).toBe(false);
  });

  it("하단으로 돌아오면 안내를 지우고 자동 스크롤을 재개한다", () => {
    const { rerender } = render(<Probe contentKey={0} />);
    const log = screen.getByTestId("log");
    setScroll(log, 0);
    act(() => {
      log.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    rerender(<Probe contentKey={1} />);
    expect(screen.getByTestId("state")).toHaveTextContent("false:true");

    act(() => {
      screen.getByRole("button", { name: "하단으로" }).click();
    });

    expect(screen.getByTestId("state")).toHaveTextContent("true:false");
    expect(log.scrollTop).toBe(1_000);
  });
});
