/**
 * Markdown·Code Block 누적 메시지의 렌더링 비용을 측정합니다. 기능 정의서가 `확인 필요`로 남긴
 * 네 항목 가운데 리렌더링 범위, DOM 노드 수, Syntax Highlighting 비용 세 가지가 대상입니다.
 *
 * 실행: `node src/features/interview/measurement/render-cost.measure.mts`
 *
 * 이 스크립트는 브라우저의 layout·paint를 재지 않습니다. React 렌더 트리 생성, Markdown 파싱,
 * Syntax Highlighting은 모두 순수 JS CPU 작업이라 Node에서 잰 값이 그대로 의미를 가집니다.
 * layout·paint 비용은 `dom-cost.measure.mts`가 실제 Chromium에서 따로 측정합니다.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { createHighlighter } from "shiki";
import { buildMessageMarkdown, countTags, splitIntoChunks } from "./fixture.mts";

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
