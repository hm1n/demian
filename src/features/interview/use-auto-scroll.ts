"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 하단에 붙어 있다고 볼 여유입니다. 스크롤 위치는 소수점과 확대 배율 때문에 정확히 0이 되지
 * 않으므로 여유를 둡니다.
 */
export const BOTTOM_THRESHOLD_PX = 48;

export interface AutoScrollState<T extends HTMLElement> {
  containerRef: React.RefObject<T | null>;
  /** 자동 스크롤이 켜져 있는지 여부입니다. 사용자가 위로 올리면 꺼집니다. */
  isPinnedToBottom: boolean;
  /** 자동 스크롤이 꺼진 동안 새 내용이 도착했는지 여부입니다. */
  hasUnreadContent: boolean;
  scrollToBottom: () => void;
  handleScroll: () => void;
}

/**
 * 자동 스크롤과 사용자의 수동 스크롤이 충돌하지 않게 합니다. 기능 정의서가 확정한 동작을
 * 그대로 구현합니다. 사용자가 위로 스크롤하면 자동 스크롤을 멈추고, 그동안 도착한 내용은
 * 안내로만 알리고, 사용자가 하단으로 돌아오면 자동 스크롤을 다시 시작합니다.
 *
 * `contentKey`는 화면 내용이 바뀔 때마다 값이 달라져야 합니다. 보통 도착한 청크 수를 넘깁니다.
 */
export function useAutoScroll<T extends HTMLElement>(contentKey: unknown): AutoScrollState<T> {
  const containerRef = useRef<T | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [hasUnreadContent, setHasUnreadContent] = useState(false);
  // 내용이 바뀌는 effect에서 최신 값을 읽어야 하는데 state는 effect 의존성에 넣으면 내용이
  // 바뀌지 않았는데도 다시 실행됩니다. 판정에 쓰는 값만 ref로 따로 둡니다.
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    pinnedRef.current = true;
    setIsPinnedToBottom(true);
    setHasUnreadContent(false);
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinned = distance <= BOTTOM_THRESHOLD_PX;
    pinnedRef.current = pinned;
    setIsPinnedToBottom(pinned);
    if (pinned) setHasUnreadContent(false);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    setHasUnreadContent(true);
  }, [contentKey]);

  return { containerRef, isPinnedToBottom, hasUnreadContent, scrollToBottom, handleScroll };
}
