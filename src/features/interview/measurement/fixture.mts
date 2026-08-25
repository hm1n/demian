/**
 * 측정용 합성 대화 코퍼스입니다. 실제 질문 생성 경로가 아직 없으므로(이슈 #59) 실제 응답 대신
 * Markdown 산문과 Code Block이 섞인 메시지를 고정된 규칙으로 만들어 씁니다. 같은 입력을 여러
 * 방식에 그대로 먹여 비교하는 것이 목적이므로 난수를 쓰지 않습니다.
 */

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
