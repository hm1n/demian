import type {
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceVerifiability,
  ExperienceEvidenceSnapshot,
} from "@/features/experience-candidates/types";

/**
 * 첫 질문 생성 프롬프트입니다. 근거 스냅샷을 그대로 소비하고 커밋과 diff를 다시 조립하지
 * 않습니다(`llm-wiki/wiki/2026-08-24-선택경험-근거-인계-계약.md`).
 *
 * 프롬프트 문구를 두 갈래로 둔 이유는 Stage A의 실측 때문입니다. 같은 지시를 한 문단에 두느냐
 * 갈라 두느냐만 바꿔 전수 응답률이 0/3에서 3/4로 바뀌었습니다
 * (`llm-wiki/wiki/2026-08-25-Stage-A-청크-폐기와-점수-선별-전환.md`). 그래서 여기서도 문구를
 * 실측 없이 확정하지 않고 두 변형을 측정 스크립트가 같은 근거로 비교할 수 있게 둡니다.
 *
 * 근거 본문은 같은 내용을 두 번 싣지 않습니다. 2026-08-28 실측에서 커밋 6개·파일 27개 경험의
 * patch 몫이 168바이트까지 굶었고, 그 원인이 커밋마다 반복되는 확인 수준 문장(1,215바이트), 같은
 * Pull Request의 반복(1,008바이트), `title`과 같은 `message`(369바이트), 파일마다 반복되는 patch
 * 부재 문장(약 1,300바이트)이었습니다
 * (`llm-wiki/raw/2026-08-28-근거-스냅샷-메타데이터-항목별-비용.md`).
 */
export type InterviewPromptVariant = "merged" | "split";

/** 실측으로 확정한 프롬프트 변형입니다. 근거는 위키 문서에 있습니다. */
export const INTERVIEW_QUESTION_PROMPT_VARIANT: InterviewPromptVariant = "split";

const RULES = {
  role: "당신은 개발자가 자기 코드 경험을 스스로 설명하도록 돕는 면접관입니다. 이력서나 코드 설명을 대신 쓰지 않습니다.",
  count:
    "질문은 정확히 1개만 만듭니다. 여러 질문을 나열하지 말고, 하나의 질문 안에서 함께 다뤘으면 하는 항목만 목록으로 덧붙입니다.",
  grounding:
    "질문은 아래 근거에 실제로 있는 커밋 제목, 커밋 메시지, 파일 경로, patch 본문만 인용합니다. 근거에 없는 파일, 함수, 수치, 라이브러리를 만들어 쓰지 않습니다.",
  verifiability:
    "`확인 불가` 또는 `AI가 고른 값`으로 표시된 항목은 Repository 사실로 전제하지 않습니다. 그 항목을 물을 때는 사실로 단정하는 대신 사용자에게 확인하는 형태로 묻습니다. patch가 잘렸다고 표시된 경우 전체 diff를 본 것으로 단정하지 않습니다.",
  quality:
    "단순 암기나 일반론으로 답할 수 있는 질문은 만들지 않습니다. 이 코드를 쓴 사람만 답할 수 있는 질문, 즉 기술 선택의 이유와 그때 고려한 대안을 근거와 함께 설명하게 하는 질문을 만듭니다.",
  format:
    "한국어로 답합니다. Markdown을 쓰고, 코드를 인용할 때만 코드 블록을 씁니다. 질문 본문은 4문장 이내로 씁니다. 답을 대신 쓰지 않습니다.",
} as const;

/**
 * 같은 규칙을 한 문단에 모아 둔 변형입니다.
 *
 * Stage A에서 이 형태가 "최대 N개"를 "N개만"으로 읽히게 만든 적이 있어 비교 대상으로 둡니다.
 */
const MERGED_SYSTEM_PROMPT = Object.values(RULES).join(" ");

/**
 * 규칙을 문단으로 갈라 둔 변형입니다. 가장 중요한 규칙을 첫 문단에 단독으로 둡니다.
 */
const SPLIT_SYSTEM_PROMPT = [
  RULES.role,
  `가장 중요한 규칙입니다. ${RULES.count}`,
  RULES.grounding,
  RULES.verifiability,
  RULES.quality,
  RULES.format,
].join("\n\n");

export function renderInterviewQuestionSystemPrompt(
  variant: InterviewPromptVariant = INTERVIEW_QUESTION_PROMPT_VARIANT
): string {
  return variant === "merged" ? MERGED_SYSTEM_PROMPT : SPLIT_SYSTEM_PROMPT;
}

/**
 * 두 변형 가운데 큰 시스템 프롬프트의 바이트입니다.
 *
 * 프롬프트 바이트 상한을 근거 상한에서 유도하려면 시스템 프롬프트 몫을 알아야 합니다. 문구를 고치면
 * 이 값이 따라 움직이므로 상수를 손으로 갱신할 필요가 없습니다. 변형을 늘리면 여기에 함께 넣습니다.
 */
export const INTERVIEW_QUESTION_SYSTEM_PROMPT_MAX_BYTES = Math.max(
  ...(["split", "merged"] as const).map(
    (variant) =>
      new TextEncoder().encode(renderInterviewQuestionSystemPrompt(variant)).byteLength
  )
);

function renderVerifiability(verifiability: EvidenceVerifiability): string {
  const status = verifiability.status === "verified" ? "확인 가능" : "확인 불가";
  const selected = verifiability.aiSelected ? ", AI가 고른 값" : "";
  return `확인 수준(${status}${selected}): ${verifiability.detail}`;
}

/**
 * 같은 확인 수준을 가리키는 값인지 봅니다. 커밋마다 같은 문장을 반복해 싣던 것을 한 번으로 줄이려면
 * 문장이 같은지 판정해야 합니다.
 */
function verifiabilityKey(verifiability: EvidenceVerifiability): string {
  return `${verifiability.status}|${verifiability.aiSelected}|${verifiability.detail}`;
}

/**
 * 확인 수준 범례에서 이 커밋을 부를 이름입니다. `commitVerifiability`가 role과 indexed만으로 문장을
 * 정하므로(`evidence-snapshot.ts`) 같은 이름의 커밋은 같은 문장을 갖습니다. 커밋 제목 줄이 이미
 * `대표 커밋`과 `관련 커밋`을 적으므로 이 이름으로 범례를 찾아갈 수 있습니다.
 */
function commitVerifiabilityLabel(commit: EvidenceSnapshotCommit): string {
  if (!commit.indexed) return "색인에서 찾지 못한 커밋";
  return commit.role === "representative" ? "대표 커밋" : "관련 커밋";
}

interface VerifiabilityLegend {
  /** 범례에 실을 줄입니다. 같은 이름의 커밋이 여러 개여도 문장은 한 번만 나옵니다. */
  readonly lines: readonly string[];
  /** 범례로 묶지 못해 커밋 자리에 그대로 적어야 하는 sha 집합입니다. */
  readonly inlineShas: ReadonlySet<string>;
}

/**
 * 커밋 확인 수준을 범례로 모읍니다.
 *
 * 같은 이름의 커밋이 서로 다른 문장을 들고 오면 묶지 않고 그 커밋 자리에 그대로 적습니다. 스냅샷은
 * 클라이언트에서 와이어를 타고 오므로 이름과 문장이 어긋난 값이 들어올 수 있고, 그때 문장을 하나로
 * 뭉개면 확인 수준을 잘못 알리게 됩니다.
 */
function buildVerifiabilityLegend(commits: readonly EvidenceSnapshotCommit[]): VerifiabilityLegend {
  const byLabel = new Map<string, EvidenceSnapshotCommit[]>();
  for (const commit of commits) {
    const label = commitVerifiabilityLabel(commit);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(commit);
    else byLabel.set(label, [commit]);
  }

  // 이름이 달라도 문장이 같으면 한 줄로 묶습니다. 대표 커밋과 관련 커밋이 같은 확인 수준을 갖는
  // 근거가 실제로 있고, 그때 같은 문장을 두 번 실을 이유가 없습니다.
  const byKey = new Map<string, { labels: string[]; verifiability: EvidenceVerifiability }>();
  const inlineShas = new Set<string>();
  for (const [label, bucket] of byLabel) {
    const keys = new Set(bucket.map((commit) => verifiabilityKey(commit.verifiability)));
    if (keys.size !== 1) {
      for (const commit of bucket) inlineShas.add(commit.sha);
      continue;
    }
    const key = [...keys][0];
    const entry = byKey.get(key);
    if (entry) entry.labels.push(label);
    else byKey.set(key, { labels: [label], verifiability: bucket[0].verifiability });
  }

  const lines = [...byKey.values()].map(
    ({ labels, verifiability }) => `${labels.join(", ")}: ${renderVerifiability(verifiability)}`
  );
  return { lines, inlineShas };
}

type EvidenceSnapshotPullRequest = EvidenceSnapshotCommit["pullRequests"][number];

/**
 * 같은 Pull Request를 커밋마다 반복해 싣지 않으려고 번호로 모읍니다. 커밋 6개가 같은 PR 하나에
 * 속하는 경우가 흔하고, 그때 번호·제목·상태·브랜치를 6번 실으면 patch에 갈 몫이 그만큼 줄어듭니다.
 */
function collectPullRequests(
  commits: readonly EvidenceSnapshotCommit[]
): readonly EvidenceSnapshotPullRequest[] {
  const byNumber = new Map<number, EvidenceSnapshotPullRequest>();
  for (const commit of commits) {
    for (const pullRequest of commit.pullRequests) {
      if (!byNumber.has(pullRequest.number)) byNumber.set(pullRequest.number, pullRequest);
    }
  }
  return [...byNumber.values()];
}

function renderPullRequest(pullRequest: EvidenceSnapshotPullRequest): string {
  return `Pull Request: #${pullRequest.number} ${pullRequest.title} (${pullRequest.state}, ${pullRequest.baseBranch} <- ${pullRequest.headBranch})`;
}

/**
 * patch 상태를 문장이 아니라 표식으로 적습니다. 파일마다 같은 안내 문장을 싣던 것이 파일 27개에서
 * 약 1,300바이트였습니다. 표식의 뜻은 `## 읽는 방법`에 한 번만 적습니다.
 *
 * 절단과 부재는 여전히 갈라 적습니다. 예산 소진으로 잘린 것과 GitHub이 본문을 주지 않은 것을 하나로
 * 뭉갠 것이 이슈 #46의 재검증 P2였습니다.
 */
const PATCH_MARKERS = {
  budgetExhausted: "[patch 없음: 상한]",
  notProvided: "[patch 없음: 미제공]",
  truncated: "[patch 잘림]",
} as const;

const READING_GUIDE = [
  "## 읽는 방법",
  `${PATCH_MARKERS.budgetExhausted} 근거 상한 때문에 patch 본문이 실리지 않았습니다. 이 파일의 코드를 본 것으로 단정하지 마세요.`,
  `${PATCH_MARKERS.notProvided} GitHub이 patch 본문을 제공하지 않았습니다.`,
  `${PATCH_MARKERS.truncated} patch 본문이 원본보다 짧게 잘렸습니다. 전체 diff를 본 것으로 단정하지 마세요.`,
].join("\n");

function renderFile(file: EvidenceSnapshotFile): string {
  const stats = `(${file.status} +${file.additions}/-${file.deletions})`;
  if (file.patch === null) {
    const marker =
      file.patchOmittedReason === "budget_exhausted"
        ? PATCH_MARKERS.budgetExhausted
        : PATCH_MARKERS.notProvided;
    return `- ${file.path} ${stats} ${marker}`;
  }
  const marker = file.patchTruncated ? ` ${PATCH_MARKERS.truncated}` : "";
  return `- ${file.path} ${stats}${marker}\n\`\`\`diff\n${file.patch}\n\`\`\``;
}

function renderCommit(
  commit: EvidenceSnapshotCommit,
  legend: VerifiabilityLegend,
  repeatPullRequestNumbers: boolean
): string {
  const label = commit.role === "representative" ? "대표 커밋" : "관련 커밋";
  const lines = [`## ${label} ${commit.sha}`];
  // 범례로 묶지 못한 커밋만 자기 자리에 확인 수준을 적습니다.
  if (legend.inlineShas.has(commit.sha)) lines.push(renderVerifiability(commit.verifiability));
  if (!commit.indexed) {
    lines.push("커밋 색인에서 찾지 못해 제목, 메시지, Pull Request 정보를 확인할 수 없습니다.");
  } else {
    lines.push(`제목: ${commit.title ?? "(없음)"}`);
    // 커밋 본문이 없는 저장소에서는 message가 title과 같은 문자열로 옵니다. 같은 값을 두 번 싣지
    // 않습니다. 본문이 따로 있는 커밋은 그대로 싣습니다.
    if (commit.message && commit.message !== commit.title) lines.push(`메시지:\n${commit.message}`);
    if (repeatPullRequestNumbers && commit.pullRequests.length > 0) {
      lines.push(
        `Pull Request: ${commit.pullRequests.map(({ number }) => `#${number}`).join(", ")}`
      );
    }
  }
  lines.push(
    commit.files.length === 0
      ? "변경 파일이 없습니다."
      : `변경 파일 ${commit.files.length}개:\n${commit.files.map(renderFile).join("\n")}`
  );
  return lines.join("\n");
}

/**
 * 근거 스냅샷을 모델에 실을 사용자 메시지로 접습니다.
 *
 * JSON을 그대로 보내지 않습니다. 같은 내용이라도 키와 따옴표 때문에 요청이 커지고, 확인 수준
 * 필드가 값 옆에 붙어 있으면 모델이 `unverifiable`을 사실과 나란한 또 하나의 데이터로 읽습니다.
 * 확인 수준을 문장으로 풀어 붙이되, 같은 문장을 커밋마다 반복하지 않고 범례로 한 번만 둡니다.
 *
 * 근거 입력 상한은 스냅샷을 만들 때 이 함수의 결과로 걸립니다(`evidence-snapshot.ts`). 예전에는
 * JSON 직렬화 바이트로 걸었는데, patch가 큰 근거에서 렌더 결과가 JSON보다 커져 상한이 보증되지
 * 않았습니다(2026-08-28 실측: JSON 10,436바이트 대 프롬프트 10,632바이트).
 */
export function renderInterviewEvidencePrompt(snapshot: ExperienceEvidenceSnapshot): string {
  const commits = [snapshot.representativeCommit, ...snapshot.relatedCommits];
  const legend = buildVerifiabilityLegend(commits);
  const pullRequests = collectPullRequests(commits);
  // Pull Request가 하나면 위에 한 번 적은 것으로 충분합니다. 둘 이상이면 어느 커밋이 어느 PR에
  // 속하는지 알아야 하므로 커밋 자리에 번호만 적습니다.
  const repeatPullRequestNumbers = pullRequests.length > 1;

  const sections = [
    `# 선택한 개발 경험의 Repository 근거`,
    `후보 커밋: ${snapshot.candidateSha}`,
    READING_GUIDE,
  ];

  if (legend.lines.length > 0) {
    sections.push(["## 커밋 확인 수준", ...legend.lines].join("\n"));
  }
  if (pullRequests.length > 0) {
    sections.push(["## Pull Request", ...pullRequests.map(renderPullRequest)].join("\n"));
  }

  sections.push(
    ...commits.map((commit) => renderCommit(commit, legend, repeatPullRequestNumbers)),
    [
      "## AI가 작성한 해석 문장",
      renderVerifiability(snapshot.evidence.verifiability),
      snapshot.evidence.text,
    ].join("\n")
  );

  if (snapshot.citedFilePaths.paths.length > 0) {
    sections.push(
      [
        "## AI가 고른 인용 파일 경로",
        renderVerifiability(snapshot.citedFilePaths.verifiability),
        ...snapshot.citedFilePaths.paths.map((path) => `- ${path}`),
      ].join("\n")
    );
  }

  if (snapshot.unverifiableItems.length > 0) {
    sections.push(
      [
        "## Repository만으로 확인할 수 없는 항목",
        "아래 항목은 이 근거로 확인할 수 없습니다. 사실로 전제하고 묻지 마세요.",
        ...snapshot.unverifiableItems.map((item) => `- ${item}`),
      ].join("\n")
    );
  }

  if (snapshot.patchBudget.truncatedByBudget) {
    sections.push(
      [
        "## 근거 예산",
        "근거 입력 상한 때문에 patch 본문 일부를 자르거나 빼고 보냈습니다. 전체 diff를 본 것으로 단정하지 마세요.",
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}
