/**
 * 꼬리 질문 경로의 근거 재전송 설계 네 가지를 입력 토큰으로 비교합니다. 수동 실행 스크립트이고
 * vitest 스위트에 포함되지 않습니다.
 *
 * 실행:
 *   GITHUB_TOKEN=$(gh auth token) npx tsx --env-file=<.env 경로> \
 *     src/features/interview/measurement/followup-question-cost.measure.mts --pr=61 --pr=56
 *
 * 옵션:
 *   --owner=<소유자>      기본 hm1n
 *   --repo=<저장소>       기본 demian
 *   --pr=<번호>           근거로 쓸 Pull Request. 여러 번 지정하면 크기가 다른 근거를 함께 잽니다.
 *   --max-commits=<N>     PR에서 가져올 커밋 수 상한. 기본 6
 *   --turns=<N>           비교할 최대 턴 수. 기본 10
 *   --model=<id>          토큰을 셀 모델. 기본 gemini-3.1-flash-lite
 *
 * 재는 것:
 *   - 설계별·턴별 입력 토큰. Gemini `countTokens`로 셉니다. 생성을 호출하지 않으므로 요금과
 *     일일 요청 쿼터를 쓰지 않습니다.
 *   - 그 토큰으로 계산한 인터뷰 한 번의 비용과 예산 10달러의 가능 횟수.
 *
 * 재지 않는 것(값을 가정으로 두는 것):
 *   - 사용자 답변 길이. 실제 사용자 답변이 아직 없습니다. 200·600·1,500자 세 구간으로 나눠
 *     각각의 결과를 냅니다.
 *   - 꼬리 질문의 출력 길이. 첫 질문 실측 178~213토큰의 위쪽인 200토큰을 매 턴 같은 값으로 둡니다
 *     (`llm-wiki/wiki/2026-09-02-LLM-비용-산정.md` 3절).
 *
 * 프롬프트는 운영 코드(`renderInterviewQuestionSystemPrompt`, `renderInterviewEvidencePrompt`)를
 * 그대로 씁니다. 여기서 다시 접으면 재는 대상과 배포되는 대상이 갈립니다.
 */

import {
  buildExperienceEvidenceSnapshot,
} from "../../experience-candidates/evidence-snapshot";
import type {
  CandidateDiff,
  ExperienceCandidateListItem,
  ExperienceEvidenceSnapshot,
  EvidenceSnapshotCommit,
  StageBCandidateResult,
} from "../../experience-candidates/types";
import {
  renderInterviewEvidencePrompt,
  renderInterviewQuestionSystemPrompt,
} from "../question-prompt";
import { GITHUB_API_BASE, githubFetch, parseJson } from "../../../lib/github/commits";
import { fetchCommitDetailBySha, withoutPatch } from "../../../lib/github/contributions";
import type { CandidateDataOutput, CommitDetail } from "../../../lib/github/types";

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const owner = flag("owner", "hm1n");
const repo = flag("repo", "demian");
const maxCommits = Number(flag("max-commits", "6"));
const maxTurns = Number(flag("turns", "10"));
const model = flag("model", "gemini-3.1-flash-lite");
const pullRequestNumbers = args
  .filter((arg) => arg.startsWith("--pr="))
  .map((arg) => Number(arg.split("=")[1]));
if (pullRequestNumbers.length === 0) pullRequestNumbers.push(61);

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) {
  console.error("GITHUB_TOKEN이 필요합니다. GITHUB_TOKEN=$(gh auth token) 형태로 넘겨 주세요.");
  process.exit(1);
}
const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!googleKey) {
  console.error("GOOGLE_GENERATIVE_AI_API_KEY가 필요합니다. --env-file로 넘겨 주세요.");
  process.exit(1);
}

/** 근거 스냅샷 상한입니다. 운영 기본값과 같습니다. */
const maxInputTokens = Number(flag("max-input-tokens", "5250"));

// ---------------------------------------------------------------------------
// 단가 (llm-wiki/wiki/2026-09-02-LLM-비용-산정.md 2절, 백만 토큰당 달러)
// ---------------------------------------------------------------------------

const PRICE = {
  input: 0.25,
  output: 1.5,
  cachedInput: 0.025,
  /** 명시적 캐싱의 스토리지 요금입니다. 토큰 100만 개를 한 시간 두는 값입니다. */
  cacheStoragePerHour: 1.0,
} as const;

/** 꼬리 질문 한 번의 출력 토큰입니다. 첫 질문 실측 178~213의 위쪽을 씁니다. */
const OUTPUT_TOKENS_PER_TURN = 200;

/** 인터뷰 하나가 캐시를 붙들고 있는 시간입니다. 캐싱 설계의 스토리지 몫을 재는 데만 씁니다. */
const CACHE_LIFETIME_HOURS = 0.5;

// ---------------------------------------------------------------------------
// 답변 길이 구간
// ---------------------------------------------------------------------------
// 실제 사용자 답변이 없으므로 길이만 세 구간으로 둡니다. 문장은 이 인터뷰에서 나올 법한 한국어
// 답변이고, 목표 글자 수에 닿을 때까지 이어 붙입니다. 비용은 토큰 수로만 결정되므로 여기서
// 중요한 것은 어휘가 아니라 길이입니다.

const ANSWER_SEED = [
  "SSE로 간 이유는 질문이 한 방향으로만 흐르기 때문입니다. WebSocket을 쓰면 연결 상태와 재연결을 직접 관리해야 하는데 우리가 보내는 건 서버에서 클라이언트로 가는 텍스트 조각뿐이라 그 비용이 이득 없이 늘어납니다.",
  "재연결은 Last-Event-ID로 이어받게 했습니다. 다만 실제 생성 스트림은 같은 질문을 다시 만들 수 없어서 이어받기를 끄고 처음부터 다시 생성하도록 갈랐습니다.",
  "프레임마다 모아서 반영하는 방식은 측정하고 나서 넣었습니다. 4,919자 메시지 재파싱이 2.94밀리초였고 한 프레임에 청크가 여러 개 도착하면 같은 파싱을 반복하게 되니까요.",
  "처음에는 청크마다 setState를 불렀는데 긴 메시지에서 입력 지연이 눈에 띄었습니다. 버퍼에 쌓고 requestAnimationFrame에서 한 번만 반영하도록 바꾸고 나서 그 지연이 사라졌습니다.",
] as const;

function buildAnswer(targetChars: number): string {
  let text = "";
  let index = 0;
  while (text.length < targetChars) {
    text += (text === "" ? "" : " ") + ANSWER_SEED[index % ANSWER_SEED.length];
    index += 1;
  }
  return text.slice(0, targetChars);
}

const ANSWER_LENGTHS = [200, 600, 1500] as const;

/**
 * 꼬리 질문 본문 자리입니다. 첫 질문 실측 출력과 같은 자리를 차지하도록 두고, 실제 토큰 수는
 * `countTokens`로 확인해 출력합니다.
 */
const QUESTION_TEXT = [
  "`src/features/interview/use-interview-stream.ts`에서 도착한 청크를 바로 반영하지 않고 `bufferRef`에 모았다가 프레임마다 한 번만 `setMessages`를 부르도록 두셨습니다.",
  "",
  "이 구조를 고르기 전에 어떤 방식을 먼저 시도했고, 무엇을 보고 프레임 단위 합치기로 옮겼는지 설명해 주세요. 함께 다뤄 주셨으면 하는 항목입니다.",
  "",
  "- `flushNow`가 예약된 프레임을 취소하고 즉시 반영하는 경로를 따로 둔 이유",
  "- `frameScheduledRef`를 handle 값과 따로 둔 판단의 배경",
  "- 이 선택으로 무엇이 나빠질 수 있다고 봤는지",
].join("\n");

// ---------------------------------------------------------------------------
// 근거 스냅샷 조립
// ---------------------------------------------------------------------------
// `question-generation.measure.mts`와 같은 방식입니다. 합성 diff로는 patch 몫과 실제 토큰의 관계를
// 잴 수 없습니다.

async function fetchPullRequestCommitShas(pullRequestNumber: number): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullRequestNumber}/commits?per_page=100`;
  const response = await githubFetch(url, githubToken!);
  if (!response.ok) {
    throw new Error(`PR #${pullRequestNumber} 커밋 목록 조회 실패: ${response.status}`);
  }
  const commits = await parseJson<{ sha: string }[]>(response, "PR 커밋 목록");
  return commits.map(({ sha }) => sha);
}

function toDiff(detail: CommitDetail): CandidateDiff {
  return {
    sha: detail.sha,
    files: detail.files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
    })),
  };
}

async function buildSnapshot(pullRequestNumber: number): Promise<ExperienceEvidenceSnapshot> {
  const shas = (await fetchPullRequestCommitShas(pullRequestNumber)).slice(0, maxCommits);
  if (shas.length === 0) throw new Error(`PR #${pullRequestNumber}에 커밋이 없습니다.`);

  const details: CommitDetail[] = [];
  for (const sha of shas) {
    details.push(await fetchCommitDetailBySha({ owner, repo, token: githubToken! }, sha));
  }

  const [representative, ...related] = details;
  const citedFilePaths = representative.files
    .slice()
    .sort((left, right) => right.changes - left.changes)
    .slice(0, 2)
    .map(({ path }) => path);
  const candidate = {
    sha: representative.sha,
    relatedShas: related.map(({ sha }) => sha),
    evidence: `Pull Request #${pullRequestNumber}의 커밋 ${details.length}개가 같은 문제를 함께 다뤘고, 변경 파일과 diff에서 판단 근거를 확인할 수 있습니다.`,
    citedFilePaths,
    source: "automatic_recommendation" as const,
  };
  const item: ExperienceCandidateListItem = {
    candidate,
    commit: withoutPatch(representative),
    origin: "repository",
    normalizedRelatedShas: candidate.relatedShas,
    normalizedCitedFilePaths: citedFilePaths,
  };
  const data: CandidateDataOutput = {
    allCommits: [],
    includedCommits: details.map(withoutPatch),
    repository: { fileTree: [], treeTruncated: false, languages: {} },
  };
  const candidates: StageBCandidateResult = {
    candidates: [candidate],
    insufficientCandidatesReason: null,
    diffs: details.map(toDiff),
  };
  const result = buildExperienceEvidenceSnapshot(
    item,
    data,
    candidates,
    maxInputTokens,
    renderInterviewEvidencePrompt
  );
  if (!result.ok) throw new Error(`PR #${pullRequestNumber} 스냅샷 조립 실패: ${result.reason}`);
  return result.snapshot;
}

/**
 * patch 본문만 걷어낸 축약 근거입니다. 설계 D가 매 턴 싣는 값이고, 커밋 제목·메시지·파일 목록·
 * 확인 수준은 그대로 둡니다. 부재 사유를 `not_provided`로 두어 "본문 없음"과 본문이 함께 실리지
 * 않게 합니다(`question-request.ts`의 배타성 조건과 같은 규칙입니다).
 */
function stripPatches(snapshot: ExperienceEvidenceSnapshot): ExperienceEvidenceSnapshot {
  const strip = (commit: EvidenceSnapshotCommit): EvidenceSnapshotCommit => ({
    ...commit,
    files: commit.files.map((file) => ({
      ...file,
      patch: null,
      patchTruncated: false,
      patchOmittedReason: "not_provided" as const,
    })),
  });
  return {
    ...snapshot,
    representativeCommit: strip(snapshot.representativeCommit),
    relatedCommits: snapshot.relatedCommits.map(strip),
    patchBudget: { ...snapshot.patchBudget, patchBytes: 0, truncatedByBudget: false },
  };
}

// ---------------------------------------------------------------------------
// 토큰 세기
// ---------------------------------------------------------------------------

interface Content {
  readonly role: "user" | "model";
  readonly parts: readonly { readonly text: string }[];
}

const text = (value: string): Content["parts"] => [{ text: value }];

async function countTokens(system: string, contents: readonly Content[]): Promise<number> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${googleKey}`;
  const body = {
    generateContentRequest: {
      model: `models/${model}`,
      systemInstruction: { parts: text(system) },
      contents,
    },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`countTokens 실패 ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const parsed = (await response.json()) as { totalTokens?: number };
  if (typeof parsed.totalTokens !== "number") throw new Error("countTokens 응답에 totalTokens가 없습니다.");
  return parsed.totalTokens;
}

// ---------------------------------------------------------------------------
// 설계
// ---------------------------------------------------------------------------
// 설계 이름은 근거를 매 턴 실을지로 갈립니다. API가 상태를 갖지 않으므로 "대화를 잇는다"는 것은
// 매 호출에 이력을 다시 싣는다는 뜻이고, 근거도 이력 안에 남겨 두면 매 턴 다시 실립니다.

type DesignId = "A" | "B" | "D";

const DESIGN_LABEL: Record<DesignId, string> = {
  A: "A. 근거 전량을 매 턴 유지",
  B: "B. 근거를 첫 턴에만 싣고 이후 폐기",
  D: "D. patch를 뺀 축약 근거를 매 턴 유지",
};

/**
 * 턴 `turn`의 꼬리 질문을 만들 때 모델에 실리는 대화입니다.
 *
 * 턴 1은 첫 질문이므로 꼬리 질문은 턴 2부터입니다. 이력은 `근거 → 질문 → 답변`이 반복되는 형태이고
 * 설계에 따라 근거 자리만 달라집니다.
 */
function buildContents(
  design: DesignId,
  turn: number,
  evidenceFull: string,
  evidenceLite: string,
  answer: string
): readonly Content[] {
  const contents: Content[] = [];
  const evidence = design === "D" ? evidenceLite : evidenceFull;
  if (design !== "B") {
    contents.push({ role: "user", parts: text(evidence) });
  } else if (turn === 1) {
    contents.push({ role: "user", parts: text(evidenceFull) });
  } else {
    // 근거를 뺀 자리에 무엇을 남길지도 설계입니다. 아무것도 남기지 않으면 모델이 무엇에 대한
    // 인터뷰인지조차 모르므로, 후보 커밋과 인용 파일 경로만 남깁니다.
    contents.push({
      role: "user",
      parts: text(
        [
          "# 인터뷰 대상",
          "아래 대화는 이 저장소 경험 하나에 대한 인터뷰입니다. 근거 본문은 이 대화에 실려 있지 않습니다.",
          "근거에 없는 파일, 함수, 수치를 만들어 쓰지 마세요.",
        ].join("\n")
      ),
    });
  }
  for (let index = 1; index < turn; index += 1) {
    contents.push({ role: "model", parts: text(QUESTION_TEXT) });
    contents.push({ role: "user", parts: text(answer) });
  }
  return contents;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

interface TurnCost {
  readonly turn: number;
  readonly inputTokens: number;
}

function usd(value: number): string {
  return `${value.toFixed(5)}달러`;
}

async function measurePullRequest(pullRequestNumber: number): Promise<void> {
  const snapshot = await buildSnapshot(pullRequestNumber);
  const system = renderInterviewQuestionSystemPrompt();
  const evidenceFull = renderInterviewEvidencePrompt(snapshot);
  const evidenceLite = renderInterviewEvidencePrompt(stripPatches(snapshot));

  const systemTokens = await countTokens(system, [{ role: "user", parts: text("") }]);
  const fullTokens = await countTokens(system, [{ role: "user", parts: text(evidenceFull) }]);
  const liteTokens = await countTokens(system, [{ role: "user", parts: text(evidenceLite) }]);
  const questionTokens = await countTokens("", [{ role: "model", parts: text(QUESTION_TEXT) }]);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`PR #${pullRequestNumber} · 커밋 ${1 + snapshot.relatedCommits.length}개 · 모델 ${model}`);
  console.log(`${"=".repeat(78)}`);
  console.log(
    `시스템+빈 사용자 메시지 ${systemTokens}토큰 / 근거 전량 포함 ${fullTokens}토큰 / 축약 근거 포함 ${liteTokens}토큰`
  );
  console.log(
    `근거 몫: 전량 ${fullTokens - systemTokens}토큰, 축약 ${liteTokens - systemTokens}토큰 ` +
      `(patch 바이트 ${snapshot.patchBudget.patchBytes}, 상한 절단 ${snapshot.patchBudget.truncatedByBudget})`
  );
  console.log(`꼬리 질문 본문 자리 ${questionTokens}토큰 (첫 질문 실측 178~213 대비)`);

  for (const answerChars of ANSWER_LENGTHS) {
    const answer = buildAnswer(answerChars);
    const answerTokens = await countTokens("", [{ role: "user", parts: text(answer) }]);
    console.log(`\n--- 답변 ${answerChars}자 (${answerTokens}토큰) ---`);
    console.log(
      ["설계", "턴별 입력 토큰(2턴/5턴/10턴)", "인터뷰 총 입력", "인터뷰 회당", "10달러"].join(" | ")
    );

    const totals: Record<string, number> = {};
    for (const design of ["A", "B", "D"] as DesignId[]) {
      const costs: TurnCost[] = [];
      for (let turn = 2; turn <= maxTurns; turn += 1) {
        const contents = buildContents(design, turn, evidenceFull, evidenceLite, answer);
        costs.push({ turn, inputTokens: await countTokens(system, contents) });
      }
      const totalInput = costs.reduce((sum, cost) => sum + cost.inputTokens, 0);
      const totalOutput = costs.length * OUTPUT_TOKENS_PER_TURN;
      const cost = (totalInput * PRICE.input + totalOutput * PRICE.output) / 1_000_000;
      totals[design] = cost;
      const pick = (turn: number) => costs.find((entry) => entry.turn === turn)?.inputTokens ?? 0;
      console.log(
        [
          DESIGN_LABEL[design],
          `${pick(2)}/${pick(5)}/${pick(Math.min(10, maxTurns))}`,
          `${totalInput}토큰`,
          usd(cost),
          `${Math.floor(10 / cost)}회`,
        ].join(" | ")
      );
    }

    // 설계 C는 A와 같은 입력이고 접두사(시스템+근거)만 캐시 단가로 계산합니다. 접두사는 인터뷰
    // 내내 바뀌지 않으므로 캐시가 맞습니다.
    const prefixTokens = fullTokens;
    let cachedCost = 0;
    for (let turn = 2; turn <= maxTurns; turn += 1) {
      const contents = buildContents("A", turn, evidenceFull, evidenceLite, buildAnswer(answerChars));
      const total = await countTokens(system, contents);
      const uncached = Math.max(0, total - prefixTokens);
      cachedCost +=
        (prefixTokens * PRICE.cachedInput + uncached * PRICE.input + OUTPUT_TOKENS_PER_TURN * PRICE.output) /
        1_000_000;
    }
    const storage = (prefixTokens * PRICE.cacheStoragePerHour * CACHE_LIFETIME_HOURS) / 1_000_000;
    const cCost = cachedCost + storage;
    console.log(
      [
        `C. A + 명시적 캐싱(${CACHE_LIFETIME_HOURS}시간)`,
        "-",
        "-",
        `${usd(cCost)} (스토리지 ${usd(storage)} 포함)`,
        `${Math.floor(10 / cCost)}회`,
      ].join(" | ")
    );
    console.log(
      `A 대비: B ${(((totals.B - totals.A) / totals.A) * 100).toFixed(1)}%, ` +
        `D ${(((totals.D - totals.A) / totals.A) * 100).toFixed(1)}%, ` +
        `C ${(((cCost - totals.A) / totals.A) * 100).toFixed(1)}%`
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `턴 상한 ${maxTurns} · 출력 ${OUTPUT_TOKENS_PER_TURN}토큰/턴 가정 · 단가 입력 ${PRICE.input} / 출력 ${PRICE.output} / 캐시 ${PRICE.cachedInput} (백만 토큰당 달러)`
  );
  for (const pullRequestNumber of pullRequestNumbers) {
    // 근거가 상한을 넘겨 스냅샷을 만들지 못하는 PR도 비교 대상입니다. 그 사실 자체가 결과이므로
    // 한 건의 실패로 나머지 측정을 멈추지 않습니다.
    try {
      await measurePullRequest(pullRequestNumber);
    } catch (error) {
      console.log(`\nPR #${pullRequestNumber} 측정 실패: ${(error as Error).message}`);
    }
  }
}

await main();
