/**
 * 이슈 #19 실데이터 측정 스크립트. 수동 실행 전용이며 vitest 스위트에는 포함되지 않습니다.
 * 파일명이 `*.test.ts`가 아니므로 vitest 기본 include 패턴에 잡히지 않습니다.
 *
 * GITHUB_TOKEN=$(gh auth token) npx tsx --env-file=.env scripts/measure-pipeline.ts <owner> <repo> <phase>
 *
 * phase:
 *   commits   커밋 목록 페이지네이션 소요 시간과 블랙리스트 통과 수
 *   details   상세 조회 순차 소요 시간, changedFiles·patch 분포, 페이로드 크기
 *   parallel  상세 조회 병렬도별 소요 시간과 secondary rate limit 관측
 *   commit    단일 커밋 상세 조회. changedFiles 3000 상한 왜곡 관측용
 *   stage-a   실제 Groq 호출 소요 시간과 선정 결과 (GROQ_API_KEY 필요)
 *   stage-a-chunks  점수 선별·청크 분할·누락 복구 완주 측정
 *   stage-b   실제 Gemini 호출 소요 시간과 선정 결과 (GOOGLE_GENERATIVE_AI_API_KEY 필요)
 *
 * 옵션:
 *   --limit=N              입력 커밋 수
 *   --cache=<경로>          상세 조회 결과를 저장소 밖 임시 경로에 캐시해 반복 측정에서 재사용
 *   --model=<id>           Stage A 모델 오버라이드
 *   --stage-b-model=<id>   Stage B 모델 오버라이드
 *   --concurrency=1,2,4    parallel 단계의 병렬도 목록
 *   --skip-stage-a         Stage A를 건너뛰고 Stage B만 측정
 *   --sha=<40자 SHA>        commit 단계의 대상 커밋
 *   --item=<기여 항목>       Stage A 기여 항목. 여러 번 지정 가능
 *
 * 출력에는 수치와 요약만 담습니다. 토큰·키·응답 원문을 출력하지 않습니다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { APICallError } from "ai";
import { filterCommitsForDetail } from "../src/lib/github/commit-blacklist";
import { fetchAuthoredCommits, GITHUB_API_BASE, githubFetch } from "../src/lib/github/commits";
import { fetchCommitDetail } from "../src/lib/github/contributions";
import {
  buildStageAPayload,
  createStageAGenerate,
  selectStageACandidates,
  STAGE_A_MODEL,
  resolveChunkQuota,
  STAGE_A_TIMEOUT_MS,
  STAGE_A_RESET_SAFETY_MS,
  STAGE_A_TOKEN_RESERVE,
  type StageAInput,
  type StageAUnitInput,
} from "../src/features/experience-candidates/stage-a";
import {
  expandCandidatesToCommits,
  splitUnitsIntoChunks,
  toStageAUnits,
} from "../src/features/experience-candidates/candidate-client";
import { renderWorkUnitSummary } from "../src/features/experience-candidates/work-unit-summary";
import {
  buildStageBPayload,
  createStageBGenerate,
  selectStageBCandidates,
  STAGE_B_MAX_INPUT_COMMITS,
  STAGE_B_MODEL,
  STAGE_B_MAX_PATCH_CHARS,
  STAGE_B_MAX_TOTAL_PATCH_CHARS,
} from "../src/features/experience-candidates/stage-b";
import type { CommitDetail, CommitSummary, GitHubAuth } from "../src/lib/github/types";
import type { GenerateStageA } from "../src/features/experience-candidates/stage-a";
import type { StageACandidate } from "../src/features/experience-candidates/types";
import { ExperienceCandidateOutputError } from "../src/features/experience-candidates/errors";

const [owner, repo, phase = "commits", ...rest] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;

if (!owner || !repo || !token) {
  console.log("사용법: GITHUB_TOKEN=$(gh auth token) npx tsx scripts/measure-pipeline.ts <owner> <repo> <phase>");
  process.exit(1);
}

const auth: GitHubAuth = { owner, repo, token };
const numericOption = (name: string, fallback: number) => {
  const hit = rest.find((option) => option.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
};

const ms = () => performance.now();
const round = (value: number) => Math.round(value);

/**
 * probe 헤더는 숫자여야 한다. `githubFetch`는 상태 코드를 보지 않고 Response를 돌려주므로
 * 헤더가 없을 때 `Number(null)`이 0이 되고, 그 0이 잔량·소비량으로 조용히 측정에 섞인다.
 * probe는 모든 소비량 계산의 기준값이므로 값을 만들어내지 말고 즉시 실패시킨다.
 */
function rateLimitHeader(response: Response, name: string) {
  const raw = response.headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`rate limit probe 실패: ${name} 헤더가 없거나 숫자가 아니다`);
  }
  return value;
}

/**
 * core rate limit 사용량. `/rate_limit` 엔드포인트는 캐시된 값을 돌려줘(실측: 헤더가 4762를
 * 가리킬 때 4996을 응답) 소비량 계산에 쓸 수 없다. 권위 있는 값은 각 응답의
 * `x-ratelimit-used` 헤더뿐이므로 core 요청 하나를 던져 헤더를 읽는다.
 * 이 probe 자체가 1을 소비하므로 두 probe 사이의 실제 소비량은 `used 차이 - 1`이다.
 *
 * 비성공 응답(401 토큰 만료, 403 한도 소진·차단, 429)에서는 이 계산이 성립하지 않는다. 소비가
 * 1이 아닐 수 있고 헤더도 없을 수 있다. 측정을 이어가면 위조된 수치가 결과에 남으므로 던진다.
 */
async function coreRateLimit() {
  const response = await githubFetch(`${GITHUB_API_BASE}/user`, token!);
  if (!response.ok) {
    throw new Error(`rate limit probe 실패: GET /user 응답 ${response.status}`);
  }
  return {
    limit: rateLimitHeader(response, "x-ratelimit-limit"),
    remaining: rateLimitHeader(response, "x-ratelimit-remaining"),
    used: rateLimitHeader(response, "x-ratelimit-used"),
  };
}

/** probe 두 번 사이에 측정 대상이 실제로 소비한 요청 수. 뒤 probe 자신의 1을 제외한다. */
const consumed = (before: { used: number }, after: { used: number }) => after.used - before.used - 1;

/**
 * LLM 실패의 원인 계층을 펼친다. 파이프라인이 원인을 `ExperienceCandidateOutputError`로 감싸므로
 * 어떤 모델·스키마가 왜 거부됐는지는 cause를 따라가야 보인다. 응답 본문은 앞부분만 남긴다.
 */
function describeLlmFailure(error: unknown) {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    lines.push(`  cause[${depth}] ${current.name}: ${current.message.slice(0, 200)}`);
    if (APICallError.isInstance(current)) {
      lines.push(`  cause[${depth}] status=${current.statusCode} body=${String(current.responseBody).slice(0, 400)}`);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return lines.join("\n");
}

function percentile(sorted: readonly number[], fraction: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function distribution(label: string, values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  console.log(
    `${label}: n=${sorted.length} 합=${round(total)} 평균=${round(total / (sorted.length || 1))} ` +
      `중앙=${round(percentile(sorted, 0.5))} p90=${round(percentile(sorted, 0.9))} 최대=${round(sorted.at(-1) ?? 0)}`
  );
}

async function loadCommits() {
  const before = await coreRateLimit();
  const startedAt = ms();
  const { commits, repositoryHasCommits } = await fetchAuthoredCommits(auth);
  const elapsed = ms() - startedAt;
  const after = await coreRateLimit();
  const included = filterCommitsForDetail(commits);
  console.log(`[commits] ${owner}/${repo} 커밋 있음=${repositoryHasCommits}`);
  console.log(`[commits] 작성자 커밋=${commits.length} 블랙리스트 통과=${included.length} 제외=${commits.length - included.length}`);
  console.log(`[commits] 전체 페이지네이션 소요=${round(elapsed)}ms 예상 페이지 수=${Math.ceil(commits.length / 100)}`);
  console.log(`[commits] core rate limit 소비=${consumed(before, after)} 잔량=${after.remaining}/${after.limit}`);
  return { commits, included };
}

/** 상세 조회 1건의 소요 시간을 개별로 남겨 배치 크기 판단 근거를 만듭니다. */
async function fetchDetailsSequential(targets: readonly CommitSummary[]) {
  const details: CommitDetail[] = [];
  const durations: number[] = [];
  for (const commit of targets) {
    const startedAt = ms();
    details.push(await fetchCommitDetail(auth, commit));
    durations.push(ms() - startedAt);
  }
  return { details, durations };
}

/**
 * LLM 단계를 반복 측정할 때 상세 조회를 다시 하지 않도록 캐시한다. 커밋당 2요청·844ms라
 * 반복 측정이 rate limit을 불필요하게 소진한다. 캐시는 저장소 밖 임시 경로에만 쓴다.
 */
async function fetchDetailsCached(targets: readonly CommitSummary[]) {
  const cachePath = rest.find((option) => option.startsWith("--cache="))?.slice("--cache=".length);
  if (cachePath === undefined) return (await fetchDetailsSequential(targets)).details;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CommitDetail[];
    // 캐시는 전체를 담고 있으므로 요청한 대상만 골라낸다. 그러지 않으면 --limit이 무시된다.
    const wanted = new Set(targets.map(({ sha }) => sha));
    const picked = cached.filter(({ sha }) => wanted.has(sha));
    if (picked.length === targets.length) {
      console.log(`[cache] 상세 ${picked.length}건 재사용 (GitHub 요청 0회)`);
      return picked;
    }
    console.log(`[cache] 캐시 미스 ${targets.length - picked.length}건, 전체 재조회`);
  }
  const concurrency = numericOption("concurrency", 1);
  const queue = [...targets];
  const detailsBySha = new Map<string, CommitDetail>();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const commit = queue.shift();
      if (commit === undefined) return;
      detailsBySha.set(commit.sha, await fetchCommitDetail(auth, commit));
    }
  }));
  const details = targets.map(({ sha }) => detailsBySha.get(sha)!);
  writeFileSync(cachePath, JSON.stringify(details));
  console.log(`[cache] 상세 ${details.length}건 저장`);
  return details;
}

function reportDetailShape(details: readonly CommitDetail[]) {
  const changedFiles = details.map((detail) => detail.changedFiles);
  const patchChars = details.map((detail) =>
    detail.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0)
  );
  const perFilePatch = details.flatMap((detail) =>
    detail.files.flatMap((file) => (file.patch === undefined ? [] : [file.patch.length]))
  );
  const missingPatch = details.flatMap((detail) =>
    detail.files.filter((file) => file.patch === undefined)
  ).length;
  const totalFiles = details.reduce((sum, detail) => sum + detail.files.length, 0);

  distribution("[details] 커밋별 changedFiles", changedFiles);
  distribution("[details] 커밋별 patch 문자 수", patchChars);
  distribution("[details] 파일별 patch 문자 수", perFilePatch);
  console.log(`[details] 전체 파일=${totalFiles} patch 없는 파일=${missingPatch}`);

  // changedFiles 왜곡: 상세 응답의 파일 목록은 300개/페이지로 잘리고 3000개가 하드 상한이다.
  const at300 = details.filter((detail) => detail.changedFiles === 300);
  const at3000 = details.filter((detail) => detail.changedFiles >= 3000);
  console.log(`[details] changedFiles==300 커밋=${at300.length} changedFiles>=3000 커밋=${at3000.length}`);
  console.log(`[details] changedFiles 최대=${Math.max(0, ...changedFiles)} (3000 상한 왜곡 관측=${at3000.length > 0})`);

  const perFileOverLimit = perFilePatch.filter((length) => length > STAGE_B_MAX_PATCH_CHARS).length;
  console.log(
    `[details] STAGE_B_MAX_PATCH_CHARS(${STAGE_B_MAX_PATCH_CHARS}) 초과 파일=${perFileOverLimit}/${perFilePatch.length}`
  );

  const prCounts = details.map((detail) => detail.pullRequests.length);
  distribution("[details] 커밋별 PR 수", prCounts);
}

/** Stage A·B 페이로드의 직렬화 바이트 수. Vercel 요청 본문 4.5MB 상한과 비교합니다. */
function reportPayloadSizes(details: readonly CommitDetail[]) {
  const encoder = new TextEncoder();
  const stageA = buildStageAPayload({
    units: toStageAUnits(details).units,
    candidateLimit: 1,
    contributionItems: [],
  });
  const stageABytes = encoder.encode(JSON.stringify(stageA)).byteLength;
  console.log(
    `[payload] Stage A 입력 커밋=${details.length} 직렬화=${stageABytes}B (${(stageABytes / 1024).toFixed(1)}KB, 4.5MB의 ${((stageABytes / (4.5 * 1024 * 1024)) * 100).toFixed(2)}%)`
  );

  const capped = details.slice(0, STAGE_B_MAX_INPUT_COMMITS);
  const candidates: StageACandidate[] = capped.map(({ sha }) => ({
    sha,
    source: "automatic_recommendation",
    contributionItem: null,
  }));
  const stageB = buildStageBPayload(capped, candidates);
  const stageBBytes = encoder.encode(JSON.stringify(stageB)).byteLength;
  // 페이로드가 Pull Request 단위 묶음으로 바뀌었다(Codex 리뷰 P1-1). 커밋 단위 집계는 펼쳐서 센다.
  const stageBCommits = stageB.workUnits.flatMap((unit) => unit.commits);
  const usedPatch = stageBCommits.reduce(
    (sum, commit) => sum + commit.files.reduce((inner, file) => inner + (file.patch?.length ?? 0), 0),
    0
  );
  const truncatedFiles = stageBCommits.reduce(
    (sum, commit) => sum + commit.files.filter((file) => file.patchTruncated === true).length,
    0
  );
  const droppedFiles = stageBCommits.reduce(
    (sum, commit) => sum + commit.files.filter((file) => file.patch === undefined).length,
    0
  );
  console.log(
    `[payload] Stage B 입력 커밋=${capped.length} 직렬화=${stageBBytes}B (${(stageBBytes / 1024).toFixed(1)}KB) ` +
      `patch 사용=${usedPatch}/${STAGE_B_MAX_TOTAL_PATCH_CHARS}자`
  );
  console.log(
    `[payload] Stage B 절단 파일=${truncatedFiles} patch 생략 파일=${droppedFiles} 총량 상한 도달=${usedPatch >= STAGE_B_MAX_TOTAL_PATCH_CHARS}`
  );
}

async function runCommits() {
  await loadCommits();
}

async function runDetails() {
  const { included } = await loadCommits();
  const limit = numericOption("limit", included.length);
  const targets = included.slice(0, limit);
  const before = await coreRateLimit();
  const startedAt = ms();
  const { details, durations } = await fetchDetailsSequential(targets);
  const elapsed = ms() - startedAt;
  const after = await coreRateLimit();

  console.log(`[details] 순차 조회 커밋=${details.length} 총 소요=${round(elapsed)}ms 커밋당 평균=${round(elapsed / (details.length || 1))}ms`);
  distribution("[details] 커밋별 조회 소요(ms)", durations);
  console.log(`[details] core rate limit 소비=${consumed(before, after)} 잔량=${after.remaining}/${after.limit}`);
  console.log(
    `[details] 커밋 ${STAGE_B_MAX_INPUT_COMMITS}개 순차 환산=${round((elapsed / (details.length || 1)) * STAGE_B_MAX_INPUT_COMMITS)}ms`
  );
  reportDetailShape(details);
  reportPayloadSizes(details);
}

/** 병렬도를 바꿔가며 같은 커밋 집합을 조회하고 secondary rate limit 발생 여부를 본다. */
async function runParallel() {
  const { included } = await loadCommits();
  const limit = numericOption("limit", Math.min(STAGE_B_MAX_INPUT_COMMITS, included.length));
  const targets = included.slice(0, limit);
  const listed = rest.find((option) => option.startsWith("--concurrency="));
  const concurrencies =
    listed === undefined
      ? [1, 2, 4, 8]
      : listed.slice("--concurrency=".length).split(",").map(Number);

  for (const concurrency of concurrencies) {
    const before = await coreRateLimit();
    const queue = [...targets];
    let failure: string | null = null;
    const startedAt = ms();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const commit = queue.shift();
          if (commit === undefined) return;
          try {
            await fetchCommitDetail(auth, commit);
          } catch (error) {
            failure ??= `${(error as Error & { kind?: string }).kind ?? "unknown"}: ${(error as Error).message}`;
          }
        }
      })
    );
    const elapsed = ms() - startedAt;
    const after = await coreRateLimit();
    console.log(
      `[parallel] 병렬도=${concurrency} 커밋=${targets.length} 총 소요=${round(elapsed)}ms ` +
        `커밋당=${round(elapsed / (targets.length || 1))}ms rate limit 소비=${consumed(before, after)} 잔량=${after.remaining}`
    );
    if (failure !== null) console.log(`[parallel] 병렬도=${concurrency} 실패 관측: ${failure}`);
  }
}

/**
 * Stage A의 "입력 SHA를 정확히 한 번씩" 계약은 모델이 지키지 못하면 schema_validation으로
 * 끝나 원인이 보이지 않는다. 검증 전에 실제 decision 수와 누락·중복 수를 남긴다.
 */
/**
 * 전수 응답 계약은 입력 묶음 수를 기준으로 잽니다.
 *
 * 이전에는 기대값으로 커밋 수를 받았습니다. 판단 단위가 PR 묶음으로 바뀌면서 `demian`에서
 * 묶음 15개를 커밋 90개와 비교하게 되어 계약 충족 판정이 구조적으로 항상 거짓이었습니다.
 * 같은 줄의 누락은 `payload.units`로 계산해 맞았으므로 한 줄 안에서 두 지표가 서로 모순했습니다.
 */
function instrumentedStageAGenerate(model: string | undefined): GenerateStageA {
  const generate = createStageAGenerate(model);
  return async (payload, abortSignal) => {
    const output = await generate(payload, abortSignal);
    const decisions =
      (output as { decisions?: { pullRequestNumber?: number }[] }).decisions ?? [];
    const returned = decisions.map((decision) => decision.pullRequestNumber);
    const unique = new Set(returned);
    const expected = payload.units.length;
    const inputNumbers = new Set(payload.units.map(({ pullRequestNumber }) => pullRequestNumber));
    const missing = [...inputNumbers].filter((number) => !unique.has(number)).length;
    console.log(
      `[stage-a] 모델 응답 decision=${returned.length}/${expected} 고유=${unique.size} ` +
        `누락=${missing} 중복=${returned.length - unique.size} 계약충족=${returned.length === expected && unique.size === expected && missing === 0}`
    );
    return output;
  };
}

async function runStageA() {
  const { included } = await loadCommits();
  const limit = numericOption("limit", included.length);
  const targets = included.slice(0, limit);
  const details = await fetchDetailsCached(targets);
  const contributionItems = rest
    .filter((option) => option.startsWith("--item="))
    .map((option) => option.slice("--item=".length));
  const model = rest.find((option) => option.startsWith("--model="))?.slice("--model=".length);

  console.log(`[stage-a] 입력 커밋=${details.length} 기여 항목=${contributionItems.length} 모델=${model ?? STAGE_A_MODEL}`);
  reportPayloadSizes(details);

  const startedAt = ms();
  try {
    // 후보 상한은 프로덕션이 쓰는 값과 같아야 합니다. 전역 상한 20을 그대로 쓰면 클라이언트가
    // 실제로 보내는 쿼터와 다른 것을 재게 되고, Stage B로 넘어가는 후보 수도 달라집니다.
    // 기여 항목이 선별 예산을 먹는다. 프로덕션과 같게 넘겨야 같은 묶음 수를 잰다.
    const { units: stageAUnits, workUnits: stageAWorkUnits } = toStageAUnits(details, contributionItems);
    const stageAChunks = splitUnitsIntoChunks(stageAUnits, contributionItems);
    if (stageAChunks.length > 1) {
      console.log(`[stage-a] 경고: 선별 결과가 청크 ${stageAChunks.length}개다. 이 단계는 한 번에 보내므로 상한을 넘을 수 있다`);
    }
    const candidateLimit = Math.min(resolveChunkQuota(stageAChunks.length), stageAUnits.length);
    console.log(`[stage-a] 선별 입력묶음=${stageAUnits.length} 후보상한=${candidateLimit}`);
    const output = await selectStageACandidates(
      {
        units: stageAUnits,
        candidateLimit,
        contributionItems,
      },
      instrumentedStageAGenerate(model)
    );
    const elapsed = ms() - startedAt;
    console.log(`[stage-a] 성공 소요=${round(elapsed)}ms 예산=${STAGE_A_TIMEOUT_MS}ms 사용률=${((elapsed / STAGE_A_TIMEOUT_MS) * 100).toFixed(1)}%`);
    console.log(
      `[stage-a] 후보=${output.candidates.length}/${candidateLimit} 미분류=${output.unclassifiedShas.length} 판단불가=${output.unjudgedShas.length} ` +
        `기여항목매칭=${output.candidates.filter((candidate) => candidate.source === "contribution_match").length}`
    );
    // 품질 검증용. SHA와 분류만 남기고 모델 원문은 출력하지 않는다.
    for (const candidate of output.candidates) {
      const detail = details.find(({ sha }) => sha === candidate.sha);
      console.log(
        `[stage-a] 후보 ${candidate.sha.slice(0, 7)} ${candidate.source} item=${candidate.contributionItem ?? "-"} ` +
          `+${detail?.additions}/-${detail?.deletions} files=${detail?.changedFiles} | ${detail?.title}`
      );
    }
    return { details, candidates: output.candidates, workUnits: stageAWorkUnits };
  } catch (error) {
    const elapsed = ms() - startedAt;
    console.log(`[stage-a] 실패 소요=${round(elapsed)}ms kind=${(error as Error & { kind?: string }).kind ?? "unknown"} ${(error as Error).message}
${describeLlmFailure(error)}`);
    throw error;
  }
}

async function runStageAChunks() {
  const { included } = await loadCommits();
  const targets = included.slice(0, numericOption("limit", included.length));
  const chunkModel = rest.find((option) => option.startsWith("--model="))?.slice("--model=".length);
  const baseGenerate = createStageAGenerate(chunkModel);
  let totalTokens = 0;
  let generateCalls = 0;
  // selectStageACandidates가 전수 응답 위반으로 던지면 그 호출의 토큰이 반환값에 실리지
  // 않는다. 복구 호출만 세면 실제 소비를 과소집계하므로 generate 자체를 감싸서 센다.
  const chunkGenerate: GenerateStageA = async (payload, abortSignal) => {
    const output = await baseGenerate(payload, abortSignal);
    generateCalls += 1;
    // GenerateStageA는 검증 전이라 unknown을 돌려준다. 토큰만 좁혀서 읽는다.
    const observed = (output as { __rateLimit?: { usedTokens?: number } | null } | null)?.__rateLimit;
    totalTokens += observed?.usedTokens ?? 0;
    return output;
  };
  console.log(`[stage-a-chunks] 모델=${chunkModel ?? STAGE_A_MODEL}`);
  const details = await fetchDetailsCached(targets);
  const candidates: StageACandidate[] = [];
  const unclassified = new Set<string>();
  const answeredShas: string[] = [];
  let calls = 0;
  let recoveryCalls = 0;
  const recoveredShaSet = new Set<string>();
  let rateLimitFailures = 0;
  let providerFailures = 0;
  let modelOutputFailures = 0;
  let trimmedCandidates = 0;
  const unjudgedShaSet = new Set<string>();
  const startedAt = ms();

  const call = async (chunk: readonly StageAUnitInput[], limit: number) => {
    const callStartedAt = ms();
    const input: StageAInput = { units: chunk, contributionItems: [], candidateLimit: limit };
    // 라우트의 `selectWithRecovery`와 같은 동작을 재현합니다. 여기가 갈리면 측정이 프로덕션과
    // 다른 것을 재게 됩니다.
    const degrade = (
      partial: { candidates: StageACandidate[]; unclassifiedShas: string[] },
      unjudged: readonly string[]
    ) => {
      unjudged.forEach((sha) => unjudgedShaSet.add(sha));
      return {
        candidates: partial.candidates,
        unclassifiedShas: partial.unclassifiedShas,
        unjudgedShas: [...unjudged],
        rateLimit: null,
      };
    };
    const recover = async (current: typeof input, attempts = 2): ReturnType<typeof selectStageACandidates> => {
      try {
        return await selectStageACandidates(current, chunkGenerate);
      } catch (error) {
        if (error instanceof ExperienceCandidateOutputError && error.kind === "schema_validation" &&
          !error.partialOutput && attempts > 0) {
          modelOutputFailures += 1;
          console.log(`[stage-a-chunks] 모델 출력 실패, 같은 입력 재시도 남은시도=${attempts}`);
          return await recover(current, attempts - 1);
        }
        if (!(error instanceof ExperienceCandidateOutputError) || !error.missingShas?.length ||
          !error.partialOutput) throw error;
        const partial = {
          candidates: [...error.partialOutput.candidates],
          unclassifiedShas: [...error.partialOutput.unclassifiedShas],
        };
        if (attempts === 0) {
          console.log(`[stage-a-chunks] 판단 불가 호출=${calls + 1} SHA=${error.missingShas.map((sha) => sha.slice(0, 7)).join(",")}`);
          return degrade(partial, error.missingShas);
        }
        recoveryCalls += 1;
        console.log(`[stage-a-chunks] 누락 복구 호출=${calls + 1} 남은시도=${attempts} SHA=${error.missingShas.map((sha) => sha.slice(0, 7)).join(",")}`);
        const missing = new Set(error.missingShas);
        let recovered: Awaited<ReturnType<typeof selectStageACandidates>>;
        try {
          recovered = await recover({
            ...current,
            units: current.units.filter(({ representativeSha }) => missing.has(representativeSha)),
            candidateLimit: Math.max(1, current.candidateLimit - partial.candidates.length),
          }, attempts - 1);
        } catch (recoveryError) {
          if (APICallError.isInstance(recoveryError)) throw recoveryError;
          providerFailures += 1;
          console.log(`[stage-a-chunks] 복구 호출 실패, 부분 응답 보존 호출=${calls + 1}`);
          return degrade(partial, error.missingShas);
        }
        error.missingShas.forEach((sha) => recoveredShaSet.add(sha));
        const merged = [...partial.candidates, ...recovered.candidates];
        const overflow = Math.max(0, merged.length - current.candidateLimit);
        if (overflow > 0) trimmedCandidates += overflow;
        const ranked = merged
          .map((candidate, index) => ({ candidate, index }))
          .sort((left, right) => {
            const priority = (item: { candidate: StageACandidate }) =>
              item.candidate.source === "contribution_match" ? 0 : 1;
            return priority(left) - priority(right) || left.index - right.index;
          });
        return {
          candidates: ranked.slice(0, current.candidateLimit)
            .sort((l, r) => l.index - r.index).map(({ candidate }) => candidate),
          unclassifiedShas: [
            ...partial.unclassifiedShas,
            ...recovered.unclassifiedShas,
            ...ranked.slice(current.candidateLimit).map(({ candidate }) => candidate.sha),
          ],
          unjudgedShas: recovered.unjudgedShas,
          rateLimit: recovered.rateLimit,
        };
      }
    };
    let output: Awaited<ReturnType<typeof selectStageACandidates>>;
    for (;;) {
      try {
        output = await recover(input);
        break;
      } catch (error) {
        let cause: unknown = error;
        let retryAfterMs: number | null = null;
        while (cause instanceof Error) {
          if (APICallError.isInstance(cause)) {
            const match = cause.responseBody?.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
            if (match) retryAfterMs = Number(match[1] ?? 0) * 60_000 + Number(match[2]) * 1_000;
          }
          cause = (cause as { cause?: unknown }).cause;
        }
        if (retryAfterMs === null) throw error;
        rateLimitFailures += 1;
        console.log(`[stage-a-chunks] provider 한도 대기=${round(retryAfterMs)}ms 발생=${rateLimitFailures}`);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs + STAGE_A_RESET_SAFETY_MS));
      }
    }
    calls += 1;
    console.log(
      `[stage-a-chunks] 호출=${calls} LLM호출=${generateCalls} 입력묶음=${chunk.length} 쿼터=${limit} 후보=${output.candidates.length} ` +
      `소요=${round(ms() - callStartedAt)}ms 토큰=${output.rateLimit?.usedTokens ?? 0} ` +
      `잔여=${output.rateLimit?.remainingTokens ?? -1} reset=${output.rateLimit?.resetAfterMs ?? -1}ms`
    );
    return output;
  };
  const pause = async (rateLimit: Awaited<ReturnType<typeof call>>["rateLimit"]) => {
    if (rateLimit && rateLimit.remainingTokens < STAGE_A_TOKEN_RESERVE) {
      await new Promise((resolve) => setTimeout(resolve, rateLimit.resetAfterMs + STAGE_A_RESET_SAFETY_MS));
    }
  };

  const { units, excludedCommits, excludedUnits, thresholdScore } = toStageAUnits(details);
  const initialChunks = splitUnitsIntoChunks(units, []);
  const quota = resolveChunkQuota(initialChunks.length);
  console.log(
    `[stage-a-chunks] 커밋=${details.length} 묶음=${units.length} 제외=${excludedCommits.length} ` +
    `청크=${initialChunks.length} 쿼터=${quota} 최대후보=${initialChunks.length * quota}`
  );
  console.log(
    `[stage-a-chunks] 선별 입력묶음=${units.length} 제외묶음=${excludedUnits.length} 경계점수=${thresholdScore} ` +
    `프롬프트바이트=${Buffer.byteLength(units.map(({ summary }) => renderWorkUnitSummary(summary)).join("\n"), "utf8")}`
  );
  for (let index = 0; index < initialChunks.length; index += 1) {
    const chunk = initialChunks[index];
    const output = await call(chunk, Math.min(quota, chunk.length));
    candidates.push(...output.candidates);
    output.unclassifiedShas.forEach((sha) => unclassified.add(sha));
    answeredShas.push(...output.candidates.map(({ sha }) => sha), ...output.unclassifiedShas);
    if (index + 1 < initialChunks.length) await pause(output.rateLimit);
  }

  // 전수 응답 계약은 묶음 단위다. 커밋 수와 비교하면 묶기로 줄어든 차이가 누락으로 잡힌다.
  // 중복은 집합 크기가 아니라 원본 배열 길이와의 차이로만 드러난다.
  const finalShas = new Set(answeredShas);
  console.log(
    `[stage-a-chunks] 완료 입력=${details.length} 호출=${calls} LLM호출=${generateCalls} 총소요=${round(ms() - startedAt)}ms ` +
    `총토큰=${totalTokens} 최종후보=${candidates.length}/${initialChunks.length * quota} 묶음=${units.length} 누락=${units.length - finalShas.size} ` +
    `중복=${answeredShas.length - finalShas.size} 복구호출=${recoveryCalls} 복구SHA=${recoveredShaSet.size} ` +
    `판단불가=${unjudgedShaSet.size} 복구실패=${providerFailures} 출력실패=${modelOutputFailures} 트림=${trimmedCandidates} provider한도=${rateLimitFailures}`
  );

  // 어떤 묶음이 뽑혔는지 남긴다. SHA만 찍으면 선정 결과가 설명할 만한 작업인지 사람이
  // 판단할 수 없다. 후보 SHA는 묶음 대표 SHA이므로 입력 묶음에서 그대로 되찾을 수 있다.
  const unitBySha = new Map(units.map((unit) => [unit.representativeSha, unit]));
  for (const { sha, source, contributionItem } of candidates) {
    const unit = unitBySha.get(sha);
    const matched = contributionItem === null ? "" : ` 기여=${contributionItem}`;
    console.log(
      `[stage-a-chunks] 후보 PR#${unit?.pullRequestNumber ?? "?"} ${source}${matched} ` +
      `${unit?.summary.pullRequestTitle ?? sha}`
    );
  }
}

/**
 * Stage A를 건너뛰고 캐시한 상세를 그대로 후보로 써서 Stage B만 측정한다.
 * Stage A 출력이 실행마다 흔들려(실측) Stage B 소요·품질을 반복 비교할 수 없기 때문이다.
 */
async function stageBInputWithoutStageA() {
  const { included } = await loadCommits();
  const targets = included.slice(0, numericOption("limit", STAGE_B_MAX_INPUT_COMMITS));
  const details = await fetchDetailsCached(targets);
  // 커밋 하나하나를 후보로 두면 프로덕션과 다른 것을 잰다. 프로덕션 후보는 PR 묶음이다.
  const { units, workUnits } = toStageAUnits(details);
  const candidates: StageACandidate[] = units.map(({ representativeSha }) => ({
    sha: representativeSha,
    source: "automatic_recommendation",
    contributionItem: null,
  }));
  console.log(`[stage-b] Stage A 생략, 캐시 상세 ${details.length}건에서 묶음 ${candidates.length}개를 후보로 사용`);
  return { details, candidates, workUnits };
}

/**
 * `buildStageBPayload`는 커밋 순서대로 patch 예산을 소비하므로 뒤쪽 후보가 굶을 수 있다.
 * 후보별로 실제 배정된 patch 문자 수를 순서대로 남겨 선정이 예산 배분에 편향되는지 본다.
 */
function reportPatchBudgetShare(commits: readonly CommitDetail[], candidates: readonly StageACandidate[]) {
  const payload = buildStageBPayload(commits, candidates);
  const shares = payload.workUnits.flatMap((unit) => unit.commits).map((commit, index) => ({
    index,
    sha: commit.sha,
    chars: commit.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0),
    starved: commit.files.length > 0 && commit.files.every((file) => file.patch === undefined),
  }));
  const funded = shares.filter(({ chars }) => chars > 0).length;
  console.log(`[budget] 후보 ${shares.length}개 중 patch 배정받음=${funded} 완전히 굶음=${shares.filter(({ starved }) => starved).length}`);
  console.log(
    `[budget] 순서별 배정 문자: ${shares.map(({ index, chars }) => `${index}:${chars}`).join(" ")}`
  );
  return new Map(shares.map(({ sha, chars }) => [sha, chars]));
}

async function runStageB() {
  const { details, candidates, workUnits } = rest.includes("--skip-stage-a")
    ? await stageBInputWithoutStageA()
    : await runStageA();
  // 프로덕션은 후보 묶음을 대표 커밋 여럿으로 펼쳐서 Stage B에 넣는다(`candidate-client.ts`의
  // `fetchStageBCandidatesFromApi`). 예전에는 여기서 묶음당 SHA 하나를 그대로 잘라 써서 조회
  // 시간과 patch 몫을 운영 입력이 아닌 것에서 재고 있었다(Codex 리뷰 P2-3).
  const expanded = expandCandidatesToCommits(candidates, workUnits, STAGE_B_MAX_INPUT_COMMITS);
  const commits = details.filter((detail) => expanded.some(({ sha }) => sha === detail.sha));

  // 같은 PR에서 커밋 여러 개가 실제로 펼쳐졌는지 확인한다. 하나도 없으면 이 측정은 커밋 단위
  // 입력과 구별되지 않으므로 운영 경로를 검증하지 못한다.
  const commitsByPullRequest = new Map<number, string[]>();
  for (const detail of commits) {
    for (const pullRequest of detail.pullRequests) {
      const bucket = commitsByPullRequest.get(pullRequest.number) ?? [];
      bucket.push(detail.sha);
      commitsByPullRequest.set(pullRequest.number, bucket);
    }
  }
  const multiCommitUnits = [...commitsByPullRequest.entries()].filter(([, shas]) => shas.length > 1);
  const uniqueShas = new Set(expanded.map(({ sha }) => sha)).size;

  console.log(
    `[stage-b] 후보 묶음=${candidates.length} 펼친 커밋=${expanded.length}/${STAGE_B_MAX_INPUT_COMMITS} ` +
      `SHA 중복=${expanded.length - uniqueShas} 상세=${commits.length}건`
  );
  console.log(
    `[stage-b] PR 수=${commitsByPullRequest.size} 커밋 2개 이상 PR=${multiCommitUnits.length}` +
      (multiCommitUnits.length === 0
        ? "  경고: 펼쳐도 PR마다 커밋 1개뿐이다. 운영 입력을 검증하지 못한다"
        : `  최대=${Math.max(...multiCommitUnits.map(([, shas]) => shas.length))}커밋`)
  );
  const patchShare = reportPatchBudgetShare(commits, expanded);

  const startedAt = ms();
  try {
    const stageBModel = rest.find((option) => option.startsWith("--stage-b-model="))?.slice("--stage-b-model=".length);
    console.log(`[stage-b] 모델=${stageBModel ?? STAGE_B_MODEL}`);
    const output = await selectStageBCandidates(commits, expanded, createStageBGenerate(stageBModel));
    const elapsed = ms() - startedAt;
    console.log(`[stage-b] 성공 소요=${round(elapsed)}ms 최종 후보=${output.candidates.length}`);
    for (const candidate of output.candidates) {
      const detail = details.find(({ sha }) => sha === candidate.sha);
      console.log(
        `[stage-b] 선정 ${candidate.sha.slice(0, 7)} related=${candidate.relatedShas.length} ` +
          `citedFiles=${candidate.citedFilePaths.length} evidence=${candidate.evidence.length}자 ` +
          `배정patch=${patchShare.get(candidate.sha) ?? 0}자 | ${detail?.title}`
      );
      console.log(`[stage-b]   PR=${detail?.pullRequests.map(({ number }) => `#${number}`).join(",") || "없음"}`);
      for (const relatedSha of candidate.relatedShas) {
        const related = details.find(({ sha }) => sha === relatedSha);
        console.log(`[stage-b]   related ${relatedSha.slice(0, 7)} PR=${related?.pullRequests.map(({ number }) => `#${number}`).join(",") || "없음"} | ${related?.title}`);
      }
    }
    if (output.insufficientCandidatesReason !== null) {
      console.log(`[stage-b] 후보 부족 사유 있음(길이=${output.insufficientCandidatesReason.length}자)`);
    }
  } catch (error) {
    const elapsed = ms() - startedAt;
    console.log(`[stage-b] 실패 소요=${round(elapsed)}ms kind=${(error as Error & { kind?: string }).kind ?? "unknown"} ${(error as Error).message}
${describeLlmFailure(error)}`);
    throw error;
  }
}

/**
 * 단일 커밋 상세를 조회해 changedFiles 상한 왜곡을 직접 관측한다.
 * 파일이 3000개를 넘는 커밋은 측정 대상 Repository에 없어 공개 대형 커밋으로 기전을 확인한다.
 */
async function runCommit() {
  const sha = rest.find((option) => option.startsWith("--sha="))?.slice("--sha=".length);
  if (sha === undefined) {
    console.log("--sha=<40자 SHA> 가 필요합니다.");
    return;
  }
  const before = await coreRateLimit();
  const startedAt = ms();
  const detail = await fetchCommitDetail(auth, {
    sha,
    title: "",
    author: "",
    date: "",
    parentCount: 0,
  });
  const elapsed = ms() - startedAt;
  const after = await coreRateLimit();
  const patchChars = detail.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);
  console.log(`[commit] ${sha.slice(0, 8)} 조회 소요=${round(elapsed)}ms 요청 소비=${consumed(before, after)}`);
  console.log(
    `[commit] changedFiles=${detail.changedFiles} additions=${detail.additions} deletions=${detail.deletions} ` +
      `patch 총 문자=${patchChars}`
  );
  console.log(
    `[commit] 3000 상한 도달=${detail.changedFiles >= 3000} ` +
      `(도달 시 changedFiles는 포화하지만 additions/deletions는 실제 총량을 유지해 신호가 불일치한다)`
  );
}

const phases: Record<string, () => Promise<unknown>> = {
  commits: runCommits,
  commit: runCommit,
  details: runDetails,
  parallel: runParallel,
  "stage-a": runStageA,
  "stage-a-chunks": runStageAChunks,
  "stage-b": runStageB,
};

const run = phases[phase];
if (run === undefined) {
  console.log(`알 수 없는 phase: ${phase}. 사용 가능: ${Object.keys(phases).join(", ")}`);
  process.exit(1);
}
run().catch((error: unknown) => {
  console.log(`측정 중단: ${(error as Error).message}`);
  process.exitCode = 1;
});
