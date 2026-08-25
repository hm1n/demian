/**
 * 스트리밍 화면의 렌더링 비용을 측정합니다. 기능 정의서 `실시간 AI Streaming 응답`이 `확인 필요`로
 * 남긴 항목 가운데 리렌더링 범위, DOM 노드 수, Syntax Highlighting 비용이 대상입니다.
 *
 * 실행: `node src/features/interview/measurement/streaming-render-cost.measure.mts`
 * Chromium이 없으면 `npx playwright install chromium`이 먼저 필요합니다.
 *
 * 1부는 Node에서 CPU 비용을 잽니다. Markdown 파싱, React 렌더 트리 생성, Syntax Highlighting은
 * 모두 DOM이 필요 없는 순수 JS 작업이라 Node에서 잰 값이 브라우저에서도 그대로 의미를 가집니다.
 * 2부는 Playwright가 띄운 실제 Chromium에서 layout 비용을 잽니다. Node에서 잴 수 없는 항목,
 * 즉 DOM이 쌓였을 때의 append 비용과 스크롤 비용이 대상입니다.
 *
 * 측정 결과와 그에 따른 결정은 `llm-wiki/wiki/2026-08-25-스트리밍-렌더링-측정과-전송-계약.md`에
 * 있습니다.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { chromium } from "@playwright/test";
import { createHighlighter } from "shiki";

// ---------------------------------------------------------------------------
// 측정용 합성 코퍼스
// ---------------------------------------------------------------------------
// 실제 질문 생성 경로가 아직 없으므로(이슈 #59) 실제 응답 대신 Markdown 산문과 Code Block이 섞인
// 메시지를 고정된 규칙으로 만들어 씁니다. 같은 입력을 여러 방식에 그대로 먹여 비교하는 것이
// 목적이므로 난수를 쓰지 않습니다.

const CODE_LINES = [
  "export async function selectStageACandidates(input: StageAInput) {",
  "  const chunks = splitIntoChunks(input.commits);",
  "  const results: StageAChunkOutput[] = [];",
  "  for (const chunk of chunks) {",
  "    const output = await generate(chunk);",
  "    if (output.unclassifiedShas.length > 0) {",
  "      results.push(await retryMissing(chunk, output));",
  "      continue;",
  "    }",
  "    results.push(output);",
  "  }",
  "  return mergeChunkOutputs(results);",
  "}",
];

/** 실제 AI 질문 한 개 분량에 가깝게 산문 문단과 Code Block을 섞습니다. */
export function buildMessageMarkdown(index: number, codeBlocks = 1): string {
  const parts: string[] = [
    `## 질문 ${index + 1}`,
    "",
    `\`selectStageACandidates\`에서 청크 경계를 커밋 8개, 6,000바이트, 파일 32개 세 조건으로 함께 닫은 이유를 설명해 주세요. 세 조건 가운데 실제로 먼저 걸린 조건이 무엇이었는지도 함께 알려 주세요.`,
    "",
  ];
  for (let block = 0; block < codeBlocks; block += 1) {
    parts.push("```ts", ...CODE_LINES, "```", "");
    parts.push(
      `위 코드에서 \`retryMissing\` 재시도를 최대 2회로 제한한 근거를 커밋 이력과 함께 설명해 주세요. 항목은 다음과 같습니다.`,
      "",
      "- 재시도 횟수를 늘렸을 때의 비용",
      "- 누락 SHA가 1개일 때 재시도를 포기하는 판단",
      "- `partialOutput`을 버리지 않고 이어 붙이는 이유",
      "",
    );
  }
  return parts.join("\n");
}

/** 스트리밍 도착 단위를 흉내 냅니다. 토큰 단위 대신 실제 SSE 청크에 가까운 길이로 자릅니다. */
export function splitIntoChunks(markdown: string, chunkSize = 24): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < markdown.length; offset += chunkSize) {
    chunks.push(markdown.slice(offset, offset + chunkSize));
  }
  return chunks;
}

export function countTags(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// 1부. Node에서 재는 CPU 비용
// ---------------------------------------------------------------------------

const WARMUP = 5;
const REPEAT = 21;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function measure(label: string, run: () => void): number {
  for (let index = 0; index < WARMUP; index += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < REPEAT; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  const value = median(samples);
  console.log(`${label.padEnd(52)} ${value.toFixed(2)} ms`);
  return value;
}

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(createElement(Markdown, null, markdown));
}

console.log("## 1. 메시지 1개 렌더 비용 (Markdown 파싱 + React 렌더 트리)\n");
const single = buildMessageMarkdown(0);
console.log(`메시지 길이 ${single.length}자, Highlighting 없는 DOM 노드 ${countTags(renderMarkdown(single))}개`);
const singleCost = measure("메시지 1개 renderToStaticMarkup", () => renderMarkdown(single));

console.log("\n## 2. 누적 메시지 수에 따른 전체 리렌더 비용\n");
const accumulationCosts = new Map<number, number>();
for (const messageCount of [1, 5, 10, 20, 40, 80]) {
  const conversation = Array.from({ length: messageCount }, (_, index) => buildMessageMarkdown(index));
  const nodes = countTags(conversation.map(renderMarkdown).join(""));
  const cost = measure(
    `메시지 ${String(messageCount).padStart(2)}개 전체 리렌더 (노드 ${String(nodes).padStart(4)}개)`,
    () => { for (const markdown of conversation) renderMarkdown(markdown); }
  );
  console.log(`${"".padEnd(52)} 메시지당 ${(cost / messageCount).toFixed(2)} ms`);
  accumulationCosts.set(messageCount, cost);
}

console.log("\n## 3. 스트리밍 1회분 비용: 전체 리렌더 vs 마지막 메시지만 리렌더\n");
const streamingMarkdown = buildMessageMarkdown(99);
const chunks = splitIntoChunks(streamingMarkdown);
const settled = Array.from({ length: 20 }, (_, index) => buildMessageMarkdown(index));
console.log(`청크 ${chunks.length}개 (24자 단위), 이미 쌓인 메시지 ${settled.length}개 기준`);

// 스트리밍 중간 지점을 고정해 두고 청크 1개가 더 도착하는 순간만 잽니다. 반복 실행 사이에
// 누적 길이가 늘어나면 회차마다 다른 대상을 재게 되므로 누적 상태를 밖에 두지 않습니다.
const halfway = chunks.slice(0, Math.floor(chunks.length / 2)).join("");
const nextChunk = chunks[Math.floor(chunks.length / 2)];
const naive = measure("전체 리렌더: 청크 1개 도착당", () => {
  for (const markdown of settled) renderMarkdown(markdown);
  renderMarkdown(halfway + nextChunk);
});
const memoized = measure("마지막 메시지만 리렌더: 청크 1개 도착당", () => {
  renderMarkdown(halfway + nextChunk);
});
console.log(`\n청크 ${chunks.length}개를 모두 흘렸을 때 누적: ` +
  `전체 ${(naive * chunks.length).toFixed(0)}ms vs 마지막만 ${(memoized * chunks.length).toFixed(0)}ms`);

console.log("\n## 3-1. 스트리밍 메시지가 길어질 때의 청크당 재파싱 비용\n");
for (const codeBlocks of [1, 2, 4, 8]) {
  const growing = buildMessageMarkdown(0, codeBlocks);
  measure(`메시지 ${String(growing.length).padStart(5)}자 (Code Block ${codeBlocks}개) 재파싱`, () => {
    renderMarkdown(growing);
  });
}

console.log("\n## 4. Syntax Highlighting 비용 (shiki)\n");
const initStart = performance.now();
const highlighter = await createHighlighter({ themes: ["github-light"], langs: ["ts"] });
console.log(`createHighlighter(themes 1개, langs 1개)`.padEnd(52) +
  ` ${(performance.now() - initStart).toFixed(2)} ms (최초 1회)`);

const codeBlock = streamingMarkdown.split("```ts")[1].split("```")[0].trim();
const highlightHtml = highlighter.codeToHtml(codeBlock, { lang: "ts", theme: "github-light" });
const highlightCost = measure("codeToHtml 1회 (13줄 TypeScript)", () => {
  highlighter.codeToHtml(codeBlock, { lang: "ts", theme: "github-light" });
});
console.log(`${"".padEnd(52)} 결과 노드 ${countTags(highlightHtml)}개`);

const codeChunks = splitIntoChunks(codeBlock, 24);
const streamingHighlight = measure(`미완성 코드에 청크마다 highlight (${codeChunks.length}청크)`, () => {
  let partial = "";
  for (const chunk of codeChunks) {
    partial += chunk;
    highlighter.codeToHtml(partial, { lang: "ts", theme: "github-light" });
  }
});

console.log("\n## 5. 요약\n");
console.log(`메시지 1개 렌더 ${singleCost.toFixed(2)}ms, Highlighting 제외 노드 ${countTags(renderMarkdown(single))}개`);
console.log(`Code Block 1개 highlight 시 노드 ${countTags(highlightHtml)}개, 메시지당 실질 노드 약 ${countTags(renderMarkdown(single)) - 2 + countTags(highlightHtml)}개`);
console.log(`메시지 80개 전체 리렌더 ${(accumulationCosts.get(80) ?? 0).toFixed(2)}ms`);
console.log(`리렌더 범위 축소 효과 ${(naive / memoized).toFixed(1)}배`);
console.log(`highlight를 완료 후 1회로 미루는 효과 ${(streamingHighlight / highlightCost).toFixed(1)}배`);

// ---------------------------------------------------------------------------
// 2부. 실제 Chromium에서 재는 layout 비용
// ---------------------------------------------------------------------------

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
