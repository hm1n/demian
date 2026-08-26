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

function renderVerifiability(verifiability: EvidenceVerifiability): string {
  const status = verifiability.status === "verified" ? "확인 가능" : "확인 불가";
  const selected = verifiability.aiSelected ? ", AI가 고른 값" : "";
  return `확인 수준(${status}${selected}): ${verifiability.detail}`;
}

/**
 * patch 본문이 없는 이유를 문구로 옮깁니다. `patchTruncated`가 참이면서 본문이 없는 조합이 실제로
 * 나오므로(예산 소진) 절단과 부재를 한 줄에 함께 적습니다.
 */
function renderFile(file: EvidenceSnapshotFile): string {
  const header = `- ${file.path} (${file.status} +${file.additions}/-${file.deletions})`;
  if (file.patch === null) {
    const reason =
      file.patchOmittedReason === "budget_exhausted"
        ? "patch 본문이 근거 상한 때문에 실리지 않았습니다."
        : "GitHub이 patch 본문을 제공하지 않았습니다.";
    return `${header}\n  ${reason}`;
  }
  const truncated = file.patchTruncated ? "\n  patch 본문이 원본보다 짧게 잘렸습니다." : "";
  return `${header}\n\`\`\`diff\n${file.patch}\n\`\`\`${truncated}`;
}

function renderCommit(commit: EvidenceSnapshotCommit): string {
  const label = commit.role === "representative" ? "대표 커밋" : "관련 커밋";
  const lines = [`## ${label} ${commit.sha}`, renderVerifiability(commit.verifiability)];
  if (!commit.indexed) {
    lines.push("커밋 색인에서 찾지 못해 제목, 메시지, Pull Request 정보를 확인할 수 없습니다.");
  } else {
    lines.push(`제목: ${commit.title ?? "(없음)"}`);
    if (commit.message) lines.push(`메시지:\n${commit.message}`);
    for (const pullRequest of commit.pullRequests) {
      lines.push(
        `Pull Request: #${pullRequest.number} ${pullRequest.title} (${pullRequest.state}, ${pullRequest.baseBranch} <- ${pullRequest.headBranch})`
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
 * 확인 수준을 문장으로 풀어 항목마다 붙입니다.
 *
 * 근거 입력 상한은 스냅샷을 만들 때 이미 JSON 직렬화 바이트로 걸려 있습니다
 * (`evidence-snapshot.ts`). 이 함수의 결과는 키와 따옴표가 빠져 그보다 작으므로 상한을 다시
 * 넘기지 않습니다.
 */
export function renderInterviewEvidencePrompt(snapshot: ExperienceEvidenceSnapshot): string {
  const sections = [
    `# 선택한 개발 경험의 Repository 근거`,
    `후보 커밋: ${snapshot.candidateSha}`,
    renderCommit(snapshot.representativeCommit),
    ...snapshot.relatedCommits.map(renderCommit),
    [
      "## AI가 작성한 해석 문장",
      renderVerifiability(snapshot.evidence.verifiability),
      snapshot.evidence.text,
    ].join("\n"),
  ];

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
