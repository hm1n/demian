import { describe, expect, it } from "vitest";
import {
  evidenceSnapshotFixture,
  snapshotCommit,
  snapshotFile,
  FIXTURE_RELATED_SHA,
  FIXTURE_REPRESENTATIVE_SHA,
} from "./question-fixture";
import {
  renderInterviewEvidencePrompt,
  INTERVIEW_QUESTION_SYSTEM_PROMPT_MAX_BYTES,
  renderInterviewQuestionSystemPrompt,
} from "./question-prompt";

describe("renderInterviewEvidencePrompt", () => {
  it("대표 커밋과 관련 커밋을 함께 싣는다", () => {
    const prompt = renderInterviewEvidencePrompt(evidenceSnapshotFixture());

    expect(prompt).toContain(`## 대표 커밋 ${FIXTURE_REPRESENTATIVE_SHA}`);
    expect(prompt).toContain(`## 관련 커밋 ${FIXTURE_RELATED_SHA}`);
    expect(prompt).toContain("fix: done 이벤트의 마지막 seq 검증 추가");
    expect(prompt).toContain("Pull Request: #61 질문 스트리밍 표시 기반 (closed, develop <- hm1n/issue-60-streaming)");
  });

  it("확인 수준을 항목마다 문장으로 붙인다", () => {
    const prompt = renderInterviewEvidencePrompt(evidenceSnapshotFixture());

    // AI 해석 문장은 Repository 사실이 아니므로 확인 불가로 실려야 합니다. 이 표시가 빠지면 모델이
    // AI 문장을 근거로 전제하고 묻습니다.
    expect(prompt).toContain("확인 수준(확인 불가, AI가 고른 값)");
    // 관련 커밋은 관계까지만 확인됩니다.
    expect(prompt).toContain("확인 수준(확인 가능, AI가 고른 값)");
    expect(prompt).toContain("확인 수준(확인 가능): 커밋 SHA");
  });

  it("patch 본문이 없는 이유를 예산 소진과 미제공으로 갈라 적는다", () => {
    const budgetExhausted = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({
          files: [snapshotFile({ patch: null, patchTruncated: true, patchOmittedReason: "budget_exhausted" })],
        }),
      })
    );
    const notProvided = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({
          files: [snapshotFile({ patch: null, patchTruncated: false, patchOmittedReason: "not_provided" })],
        }),
      })
    );

    // 표식으로 갈라 적습니다. 파일마다 같은 문장을 싣던 것이 파일 27개에서 약 1,300바이트였습니다.
    // 뜻은 `## 읽는 방법`에 한 번만 적습니다.
    const path = "src/features/interview/sse.ts (modified +12/-3)";
    expect(budgetExhausted).toContain(`- ${path} [patch 없음: 상한]`);
    expect(notProvided).toContain(`- ${path} [patch 없음: 미제공]`);
    expect(budgetExhausted).toContain("## 읽는 방법");
    expect(budgetExhausted).toContain("근거 상한 때문에 patch 본문이 실리지 않았습니다.");
    expect(notProvided).toContain("GitHub이 patch 본문을 제공하지 않았습니다.");
  });

  it("같은 확인 수준 문장을 커밋마다 반복하지 않는다", () => {
    const related = (sha: string) =>
      snapshotCommit({ sha, role: "related", files: [snapshotFile()] });
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        relatedCommits: [related("c".repeat(40)), related("d".repeat(40)), related("e".repeat(40))],
      })
    );
    const sentence = "커밋 SHA, 제목, 메시지, 변경 파일, patch 본문은 GitHub 응답 값입니다.";

    // 대표 커밋과 관련 커밋 셋이 같은 문장을 들고 오지만 범례에 한 번만 나옵니다.
    expect(prompt.split(sentence).length - 1).toBe(1);
    expect(prompt).toContain("## 커밋 확인 수준");
    // 커밋 자리는 남아 있어야 합니다. 줄인 것은 문장이고 근거가 아닙니다.
    for (const sha of ["c".repeat(40), "d".repeat(40), "e".repeat(40)]) {
      expect(prompt).toContain(`## 관련 커밋 ${sha}`);
    }
  });

  it("이름이 같은 커밋들의 확인 수준이 서로 다르면 커밋 자리에 그대로 적는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        relatedCommits: [
          snapshotCommit({ sha: "c".repeat(40), role: "related" }),
          snapshotCommit({
            sha: "d".repeat(40),
            role: "related",
            verifiability: {
              status: "unverifiable",
              aiSelected: true,
              detail: "와이어로 들어온 다른 확인 수준입니다.",
            },
          }),
        ],
      })
    );

    // 와이어로 어긋난 값이 오면 하나로 뭉개지 않습니다. 뭉개면 확인 수준을 잘못 알립니다.
    expect(prompt).toContain("와이어로 들어온 다른 확인 수준입니다.");
    expect(prompt).toContain("대표 커밋과 같은 PR에 속한다는 관계까지만 확인됩니다.");
  });

  it("같은 Pull Request를 한 번만 싣는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        relatedCommits: [
          snapshotCommit({ sha: "c".repeat(40), role: "related" }),
          snapshotCommit({ sha: "d".repeat(40), role: "related" }),
        ],
      })
    );
    const line = "Pull Request: #61 질문 스트리밍 표시 기반 (closed, develop <- hm1n/issue-60-streaming)";

    expect(prompt.split(line).length - 1).toBe(1);
    // PR이 하나뿐이면 커밋 자리에 번호를 다시 적지 않습니다.
    expect(prompt.split("Pull Request: #61").length - 1).toBe(1);
  });

  it("Pull Request가 둘 이상이면 커밋 자리에 번호만 적는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        relatedCommits: [
          snapshotCommit({
            sha: "c".repeat(40),
            role: "related",
            pullRequests: [
              { number: 62, title: "다른 PR", state: "merged", baseBranch: "develop", headBranch: "hm1n/other" },
            ],
          }),
        ],
      })
    );

    expect(prompt).toContain("Pull Request: #61 질문 스트리밍 표시 기반");
    expect(prompt).toContain("Pull Request: #62 다른 PR");
    // 어느 커밋이 어느 PR에 속하는지 알아야 하므로 번호는 커밋 자리에도 적습니다.
    expect(prompt.split("Pull Request: #62").length - 1).toBe(2);
  });

  it("메시지가 제목과 같으면 메시지를 싣지 않는다", () => {
    const title = "feat: 근거 스냅샷 예산 재산정";
    const same = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({ title, message: title }),
        relatedCommits: [],
      })
    );
    const different = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({ title, message: "본문이 따로 있는 커밋이다." }),
        relatedCommits: [],
      })
    );

    expect(same).not.toContain("메시지:");
    expect(same).toContain(`제목: ${title}`);
    expect(different).toContain("메시지:");
    expect(different).toContain("본문이 따로 있는 커밋이다.");
  });

  it("절단한 patch는 원본보다 짧다는 사실을 함께 적는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({ files: [snapshotFile({ patchTruncated: true })] }),
      })
    );

    expect(prompt).toContain("patch 본문이 원본보다 짧게 잘렸습니다.");
  });

  it("색인 실패 커밋은 제목과 메시지를 확인할 수 없다고 적는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        representativeCommit: snapshotCommit({ indexed: false, title: null, message: null, pullRequests: [] }),
      })
    );

    expect(prompt).toContain("커밋 색인에서 찾지 못해");
    expect(prompt).not.toContain("제목: (없음)");
  });

  it("확인 불가 고정 목록과 예산 절단을 프롬프트에 싣는다", () => {
    const prompt = renderInterviewEvidencePrompt(evidenceSnapshotFixture());

    expect(prompt).toContain("## Repository만으로 확인할 수 없는 항목");
    expect(prompt).toContain("- 실제 근무 기간");
    expect(prompt).toContain("전체 diff를 본 것으로 단정하지 마세요.");
  });

  it("절단이 없으면 예산 절 자체를 싣지 않는다", () => {
    const prompt = renderInterviewEvidencePrompt(
      evidenceSnapshotFixture({
        patchBudget: {
          maxInputTokens: 3_500,
          metadataTokens: 900,
          maxPatchBytes: 7_800,
          patchBytes: 60,
          truncatedByBudget: false,
        },
      })
    );

    expect(prompt).not.toContain("## 근거 예산");
  });
});

describe("renderInterviewQuestionSystemPrompt", () => {
  it("변형에 따라 같은 규칙을 한 문단에 두거나 갈라 둔다", () => {
    const merged = renderInterviewQuestionSystemPrompt("merged");
    const split = renderInterviewQuestionSystemPrompt("split");

    expect(merged).not.toContain("\n\n");
    expect(split).toContain("\n\n");
    // 갈라 둔 변형은 가장 중요한 규칙을 앞세웁니다. Stage A에서 문단 분리가 지시 준수를 바꾼
    // 실측이 있어 같은 형태를 유지합니다.
    expect(split).toContain("가장 중요한 규칙입니다. 질문은 정확히 1개만 만듭니다.");
  });

  it("두 변형이 같은 규칙을 담는다", () => {
    const merged = renderInterviewQuestionSystemPrompt("merged");
    const split = renderInterviewQuestionSystemPrompt("split");

    for (const rule of ["질문은 정확히 1개만 만듭니다", "만들어 쓰지 않습니다", "Repository 사실로 전제하지 않습니다"]) {
      expect(merged).toContain(rule);
      expect(split).toContain(rule);
    }
  });
});

describe("꼬리 질문 규칙", () => {
  it("이력이 없는 요청에는 싣지 않는다", () => {
    // 첫 질문에는 평가하거나 요약할 답변 자체가 없습니다. 첫 질문 경로의 프롬프트는 그대로입니다.
    const first = renderInterviewQuestionSystemPrompt("split", false);

    expect(first).not.toContain("이미 물은 것을 다시 묻지 않습니다");
    expect(first).toBe(renderInterviewQuestionSystemPrompt("split"));
  });

  it("이력이 있으면 첫 질문 규칙을 그대로 두고 넷을 더한다", () => {
    const followUp = renderInterviewQuestionSystemPrompt("split", true);

    expect(followUp.startsWith(renderInterviewQuestionSystemPrompt("split"))).toBe(true);
    for (const rule of [
      "말하지 않은 부분을 묻습니다",
      "이미 물은 것을 다시 묻지 않습니다",
      "근거로 확인되지 않는 주장은 Repository 사실로 전제하지 말고",
      "요약하거나 평가하거나 칭찬하지 않고",
    ]) {
      expect(followUp).toContain(rule);
    }
  });

  it("두 변형이 같은 꼬리 질문 규칙을 담는다", () => {
    const merged = renderInterviewQuestionSystemPrompt("merged", true);
    const split = renderInterviewQuestionSystemPrompt("split", true);

    expect(merged).not.toContain("\n\n");
    expect(split).toContain("\n\n");
    for (const rule of ["말하지 않은 부분을 묻습니다", "이미 물은 것을 다시 묻지 않습니다"]) {
      expect(merged).toContain(rule);
      expect(split).toContain(rule);
    }
  });

  it("바이트 상한이 규칙을 더한 쪽에서 나온다", () => {
    expect(INTERVIEW_QUESTION_SYSTEM_PROMPT_MAX_BYTES).toBe(
      Math.max(
        ...(["split", "merged"] as const).map(
          (variant) =>
            new TextEncoder().encode(renderInterviewQuestionSystemPrompt(variant, true)).byteLength
        )
      )
    );
  });
});
