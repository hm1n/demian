/**
 * 실제 Chromium에서 누적 DOM의 layout 비용을 측정합니다. `render-cost.measure.mts`가 재지 못하는
 * 항목, 즉 메시지가 쌓였을 때 스트리밍 1청크가 유발하는 layout 비용과 스크롤 비용을 봅니다.
 * 가상 스크롤(`@tanstack/react-virtual`) 도입 여부가 이 값에 걸려 있습니다.
 *
 * 실행: `node src/features/interview/measurement/dom-cost.measure.mts`
 * Chromium이 없으면 `npx playwright install chromium`이 먼저 필요합니다.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { chromium } from "@playwright/test";
import { createHighlighter } from "shiki";
import { buildMessageMarkdown } from "./fixture.mts";

const highlighter = await createHighlighter({ themes: ["github-light"], langs: ["ts"] });

/** 측정 대상은 렌더 결과 DOM이므로 Markdown과 Highlighting을 미리 끝낸 HTML을 만듭니다. */
function buildMessageHtml(index: number): string {
  const markdown = buildMessageMarkdown(index);
  const html = renderToStaticMarkup(createElement(Markdown, null, markdown));
  const code = markdown.split("```ts")[1].split("```")[0].trim();
  const highlighted = highlighter.codeToHtml(code, { lang: "ts", theme: "github-light" });
  return `<article class="message">${html.replace(/<pre>[\s\S]*?<\/pre>/, highlighted)}</article>`;
}

const messageHtml = buildMessageHtml(0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
await page.setContent(`<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 14px/1.65 system-ui, sans-serif; }
  #log { height: 720px; overflow-y: auto; padding: 16px; }
  .message { border-top: 1px solid #eee; padding: 12px 0; }
  pre { overflow-x: auto; padding: 12px; border-radius: 8px; }
</style>
<div id="log"></div>`);

const results = await page.evaluate(
  ({ messageHtml, sizes }) => {
    const log = document.getElementById("log")!;
    // 강제 동기 layout을 일으켜 append 비용에 layout을 포함시킵니다. 읽지 않으면 브라우저가
    // layout을 다음 프레임으로 미뤄 측정값이 실제 체감 비용보다 작게 나옵니다.
    const forceLayout = () => log.scrollHeight;

    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)];
    };

    const rows: {
      messages: number;
      nodes: number;
      appendMs: number;
      streamChunkMs: number;
      scrollToBottomMs: number;
    }[] = [];

    let appended = 0;
    for (const size of sizes) {
      while (appended < size) {
        log.insertAdjacentHTML("beforeend", messageHtml);
        appended += 1;
      }
      forceLayout();

      // Chromium은 performance.now()를 0.1ms 단위로 잘라 주므로 1회 측정으로는 분해능이
      // 부족합니다. 여러 번을 한 묶음으로 재고 나눕니다.
      const BATCH = 20;

      // 1) 메시지 1개가 더 붙는 비용
      const appendSamples: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const start = performance.now();
        for (let index = 0; index < BATCH; index += 1) {
          log.insertAdjacentHTML("beforeend", messageHtml);
          forceLayout();
        }
        appendSamples.push((performance.now() - start) / BATCH);
        for (let index = 0; index < BATCH; index += 1) log.lastElementChild!.remove();
        forceLayout();
      }

      // 2) 스트리밍 중 마지막 메시지 안에 텍스트 1청크가 추가되는 비용
      log.insertAdjacentHTML("beforeend", `<article class="message"><p id="streaming"></p></article>`);
      const streaming = document.getElementById("streaming")!;
      const streamSamples: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        streaming.textContent = "";
        forceLayout();
        const start = performance.now();
        for (let index = 0; index < BATCH; index += 1) {
          streaming.append(document.createTextNode("스트리밍 청크 텍스트 24자입니다. "));
          forceLayout();
        }
        streamSamples.push((performance.now() - start) / BATCH);
      }
      log.lastElementChild!.remove();
      forceLayout();

      // 3) 자동 스크롤 1회 비용
      const scrollSamples: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const start = performance.now();
        for (let index = 0; index < BATCH; index += 1) {
          log.scrollTop = index % 2 === 0 ? 0 : log.scrollHeight;
          forceLayout();
        }
        scrollSamples.push((performance.now() - start) / BATCH);
      }

      rows.push({
        messages: size,
        nodes: log.querySelectorAll("*").length,
        appendMs: median(appendSamples),
        streamChunkMs: median(streamSamples),
        scrollToBottomMs: median(scrollSamples),
      });
    }
    return rows;
  },
  { messageHtml, sizes: [1, 5, 10, 20, 40, 80, 160] }
);

console.log("## 실제 Chromium DOM 비용 (viewport 900x720, 메시지당 Code Block 1개)\n");
console.log("메시지 | DOM 노드 | 메시지 1개 append | 스트리밍 청크 1개 | 하단 자동 스크롤");
console.log("--- | --- | --- | --- | ---");
for (const row of results) {
  console.log(
    `${String(row.messages).padStart(3)} | ${String(row.nodes).padStart(5)} | ` +
      `${row.appendMs.toFixed(2)} ms | ${row.streamChunkMs.toFixed(3)} ms | ${row.scrollToBottomMs.toFixed(3)} ms`
  );
}

await browser.close();
