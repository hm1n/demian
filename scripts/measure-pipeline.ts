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
  INITIAL_STAGE_A_CANDIDATE_LIMIT,
  selectStageACandidates,
  STAGE_A_MODEL,
  STAGE_A_TIMEOUT_MS,
} from "../src/features/experience-candidates/stage-a";
import {
  buildStageBPayload,
  createStageBGenerate,
  selectStageBCandidates,
  STAGE_B_MAX_CANDIDATES,
  STAGE_B_MODEL,
  STAGE_B_MAX_PATCH_CHARS,
  STAGE_B_MAX_TOTAL_PATCH_CHARS,
} from "../src/features/experience-candidates/stage-b";
import type { CommitDetail, CommitSummary, GitHubAuth } from "../src/lib/github/types";
import type { GenerateStageA } from "../src/features/experience-candidates/stage-a";
import type { StageACandidate } from "../src/features/experience-candidates/types";

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
 * core rate limit 사용량. `/rate_limit` 엔드포인트는 캐시된 값을 돌려줘(실측: 헤더가 4762를
 * 가리킬 때 4996을 응답) 소비량 계산에 쓸 수 없다. 권위 있는 값은 각 응답의
 * `x-ratelimit-used` 헤더뿐이므로 core 요청 하나를 던져 헤더를 읽는다.
 * 이 probe 자체가 1을 소비하므로 두 probe 사이의 실제 소비량은 `used 차이 - 1`이다.
 */
async function coreRateLimit() {
  const response = await githubFetch(`${GITHUB_API_BASE}/user`, token!);
  return {
    limit: Number(response.headers.get("x-ratelimit-limit")),
    remaining: Number(response.headers.get("x-ratelimit-remaining")),
    used: Number(response.headers.get("x-ratelimit-used")),
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
  const { details } = await fetchDetailsSequential(targets);
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
    commits: details.map(({ sha, message, additions, deletions, changedFiles, files }) => ({
      sha,
      message,
      additions,
      deletions,
      changedFiles,
      files,
    })),
    contributionItems: [],
  });
  const stageABytes = encoder.encode(JSON.stringify(stageA)).byteLength;
  console.log(
    `[payload] Stage A 입력 커밋=${details.length} 직렬화=${stageABytes}B (${(stageABytes / 1024).toFixed(1)}KB, 4.5MB의 ${((stageABytes / (4.5 * 1024 * 1024)) * 100).toFixed(2)}%)`
  );

  const capped = details.slice(0, STAGE_B_MAX_CANDIDATES);
  const candidates: StageACandidate[] = capped.map(({ sha }) => ({
    sha,
    source: "automatic_recommendation",
    contributionItem: null,
  }));
  const stageB = buildStageBPayload(capped, candidates);
  const stageBBytes = encoder.encode(JSON.stringify(stageB)).byteLength;
  const usedPatch = stageB.commits.reduce(
    (sum, commit) => sum + commit.files.reduce((inner, file) => inner + (file.patch?.length ?? 0), 0),
    0
  );
  const truncatedFiles = stageB.commits.reduce(
    (sum, commit) => sum + commit.files.filter((file) => file.patchTruncated === true).length,
    0
  );
  const droppedFiles = stageB.commits.reduce(
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
    `[details] 커밋 ${STAGE_B_MAX_CANDIDATES}개 순차 환산=${round((elapsed / (details.length || 1)) * STAGE_B_MAX_CANDIDATES)}ms`
  );
  reportDetailShape(details);
  reportPayloadSizes(details);
}

/** 병렬도를 바꿔가며 같은 커밋 집합을 조회하고 secondary rate limit 발생 여부를 본다. */
async function runParallel() {
  const { included } = await loadCommits();
  const limit = numericOption("limit", Math.min(STAGE_B_MAX_CANDIDATES, included.length));
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
function instrumentedStageAGenerate(model: string | undefined, expected: number): GenerateStageA {
  const generate = createStageAGenerate(model);
  return async (payload, abortSignal) => {
    const output = await generate(payload, abortSignal);
    const decisions = (output as { decisions?: { sha?: string }[] }).decisions ?? [];
    const returned = decisions.map((decision) => decision.sha);
    const unique = new Set(returned);
    const inputShas = new Set(
      (payload as { commits: readonly { readonly sha: string }[] }).commits.map(({ sha }) => sha)
    );
    const missing = [...inputShas].filter((sha) => !unique.has(sha)).length;
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
    const output = await selectStageACandidates(
      {
        commits: details.map(({ sha, message, additions, deletions, changedFiles, files }) => ({
          sha,
          message,
          additions,
          deletions,
          changedFiles,
          files,
        })),
        contributionItems,
      },
      instrumentedStageAGenerate(model, details.length)
    );
    const elapsed = ms() - startedAt;
    console.log(`[stage-a] 성공 소요=${round(elapsed)}ms 예산=${STAGE_A_TIMEOUT_MS}ms 사용률=${((elapsed / STAGE_A_TIMEOUT_MS) * 100).toFixed(1)}%`);
    console.log(
      `[stage-a] 후보=${output.candidates.length}/${INITIAL_STAGE_A_CANDIDATE_LIMIT} 미분류=${output.unclassifiedShas.length} ` +
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
    return { details, candidates: output.candidates };
  } catch (error) {
    const elapsed = ms() - startedAt;
    console.log(`[stage-a] 실패 소요=${round(elapsed)}ms kind=${(error as Error & { kind?: string }).kind ?? "unknown"} ${(error as Error).message}
${describeLlmFailure(error)}`);
    throw error;
  }
}

/**
 * Stage A를 건너뛰고 캐시한 상세를 그대로 후보로 써서 Stage B만 측정한다.
 * Stage A 출력이 실행마다 흔들려(실측) Stage B 소요·품질을 반복 비교할 수 없기 때문이다.
 */
async function stageBInputWithoutStageA() {
  const { included } = await loadCommits();
  const targets = included.slice(0, numericOption("limit", STAGE_B_MAX_CANDIDATES));
  const details = await fetchDetailsCached(targets);
  const candidates: StageACandidate[] = details.map(({ sha }) => ({
    sha,
    source: "automatic_recommendation",
    contributionItem: null,
  }));
  console.log(`[stage-b] Stage A 생략, 캐시 상세 ${details.length}건을 후보로 사용`);
  return { details, candidates };
}

/**
 * `buildStageBPayload`는 커밋 순서대로 patch 예산을 소비하므로 뒤쪽 후보가 굶을 수 있다.
 * 후보별로 실제 배정된 patch 문자 수를 순서대로 남겨 선정이 예산 배분에 편향되는지 본다.
 */
function reportPatchBudgetShare(commits: readonly CommitDetail[], candidates: readonly StageACandidate[]) {
  const payload = buildStageBPayload(commits, candidates);
  const shares = payload.commits.map((commit, index) => ({
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
  const { details, candidates } = rest.includes("--skip-stage-a")
    ? await stageBInputWithoutStageA()
    : await runStageA();
  const capped = candidates.slice(0, STAGE_B_MAX_CANDIDATES);
  console.log(`[stage-b] Stage A 후보=${candidates.length} STAGE_B_MAX_CANDIDATES=${STAGE_B_MAX_CANDIDATES} 422 유발=${candidates.length > STAGE_B_MAX_CANDIDATES}`);
  const commits = details.filter((detail) => capped.some(({ sha }) => sha === detail.sha));
  const patchShare = reportPatchBudgetShare(commits, capped);

  const startedAt = ms();
  try {
    const stageBModel = rest.find((option) => option.startsWith("--stage-b-model="))?.slice("--stage-b-model=".length);
    console.log(`[stage-b] 모델=${stageBModel ?? STAGE_B_MODEL}`);
    const output = await selectStageBCandidates(commits, capped, createStageBGenerate(stageBModel));
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
