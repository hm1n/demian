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

    expect(budgetExhausted).toContain("patch 본문이 근거 상한 때문에 실리지 않았습니다.");
    expect(notProvided).toContain("GitHub이 patch 본문을 제공하지 않았습니다.");
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
