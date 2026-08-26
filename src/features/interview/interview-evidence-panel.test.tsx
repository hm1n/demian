// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperienceEvidenceSnapshot } from "@/features/experience-candidates/types";
import { InterviewEvidencePanel } from "./interview-evidence-panel";
import {
  evidenceSnapshotFixture,
  FIXTURE_RELATED_SHA,
  snapshotCommit,
  snapshotFile,
} from "./question-fixture";

afterEach(cleanup);

/**
 * 픽스처 기본값은 관련 커밋 1개와 상한 절단이 있는 스냅샷입니다. 절단 표시와 관련 커밋 표시를
 * 각각 확인하려면 출발점이 둘 다 없는 상태여야 하므로 여기서 걷어냅니다. 스냅샷을 손으로 다시
 * 만들지 않는 이유는 필드 간 일관성 조건이 걸려 있어서입니다(`question-fixture.ts` 주석).
 */
const snapshot = (overrides: Partial<ExperienceEvidenceSnapshot> = {}): ExperienceEvidenceSnapshot => {
  const base = evidenceSnapshotFixture();
  return {
    ...base,
    relatedCommits: [],
    patchBudget: { ...base.patchBudget, truncatedByBudget: false },
    ...overrides,
  };
};

const relatedCommit = (detail: string) =>
  snapshotCommit({
    sha: FIXTURE_RELATED_SHA,
    role: "related",
    title: "fix: 청크 없는 단절의 이어받기 안내 분류 정정",
    verifiability: { status: "verified", aiSelected: true, detail },
  });

const truncatedBudget = (base: ExperienceEvidenceSnapshot["patchBudget"]) => ({
  ...base,
  truncatedByBudget: true,
});

describe("InterviewEvidencePanel", () => {
  it("AI가 고른 개수를 확인 가능으로 표시하지 않는다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({
          relatedCommits: [relatedCommit("대표 커밋과 같은 PR에 속한다는 관계까지만 확인됩니다.")],
        })}
      />
    );

    const changedFiles = screen.getByText(/대표 커밋 변경 파일 1개/, { selector: "li" });
    expect(changedFiles).toHaveTextContent("확인 가능");
    expect(changedFiles).not.toHaveTextContent("AI 선택");

    const related = screen.getByText(/관련 커밋 1개/, { selector: "li" });
    expect(related).toHaveTextContent("AI 선택");
    expect(related).not.toHaveTextContent("확인 가능");

    const cited = screen.getByText(/인용 파일 1개/, { selector: "li" });
    expect(cited).toHaveTextContent("AI 선택");
    expect(cited).not.toHaveTextContent("확인 가능");
  });

  it("관련 커밋 목록에 관련성 판단이 확인 불가라는 안내를 함께 둔다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({ relatedCommits: [relatedCommit("같은 PR 소속 관계까지만 확인됩니다.")] })}
      />
    );

    expect(
      screen.getByText(/대표 커밋과 같은 PR에 속한다는 관계까지만 확인되고/)
    ).toBeInTheDocument();
  });

  it("근거 항목의 확인 수준은 스냅샷이 실어 온 값을 그대로 쓴다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({ relatedCommits: [relatedCommit("같은 PR 소속 관계까지만 확인됩니다.")] })}
      />
    );

    // 대표 커밋은 `확인 가능`, 관련 커밋은 `AI 선택`입니다. 같은 `verified`라도 AI가 고른 값이면
    // `확인 가능` 태그를 씌우지 않습니다.
    expect(screen.getByText(/커밋 SHA, 제목, 메시지, 변경 파일, patch 본문은/)).toHaveTextContent(
      "확인 가능"
    );
    expect(screen.getByText(/같은 PR 소속 관계까지만 확인됩니다/)).toHaveTextContent("AI 선택");
  });

  it("근거는 기본으로 접혀 있다", () => {
    render(<InterviewEvidencePanel snapshot={snapshot()} />);

    const details = screen.getByText(/커밋과 코드 변경 내역 1건 보기/).closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("근거를 펼치는 요약에 확인 가능·불가 안내를 접근성 설명으로 노출한다", () => {
    render(<InterviewEvidencePanel snapshot={snapshot()} />);

    const summary = screen.getByText(/커밋과 코드 변경 내역 1건 보기/);
    expect(summary).toHaveAccessibleDescription(/확인 가능/);
    expect(summary).toHaveAccessibleDescription(/확인 불가 · AI가 작성한 해석입니다/);
  });

  it("스냅샷 상한 절단을 알린다", () => {
    const base = snapshot();
    render(<InterviewEvidencePanel snapshot={{ ...base, patchBudget: truncatedBudget(base.patchBudget) }} />);

    expect(screen.getByText(/코드\s*변경 내역 일부를 잘랐습니다/)).toBeInTheDocument();
  });

  it("파일 단위 절단 표시도 알린다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({
          representativeCommit: snapshotCommit({ files: [snapshotFile({ patchTruncated: true })] }),
        })}
      />
    );

    expect(screen.getByText(/일부 코드 변경 내역이 절단되거나 미포함/)).toBeInTheDocument();
  });

  it("상한 절단과 파일 단위 절단이 함께 있으면 둘 다 알린다", () => {
    const base = snapshot({
      representativeCommit: snapshotCommit({
        files: [
          snapshotFile({ patch: null, patchTruncated: true, patchOmittedReason: "budget_exhausted" }),
        ],
      }),
    });
    render(<InterviewEvidencePanel snapshot={{ ...base, patchBudget: truncatedBudget(base.patchBudget) }} />);

    expect(screen.getByText(/코드\s*변경 내역 일부를 잘랐습니다/)).toBeInTheDocument();
    expect(screen.getByText(/일부 코드 변경 내역이 절단되거나 미포함/)).toBeInTheDocument();
  });

  it("patch 본문이 없는 이유를 예산 소진과 GitHub 미제공으로 구분한다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({
          representativeCommit: snapshotCommit({
            files: [
              snapshotFile({ path: "src/a.ts", patch: null, patchOmittedReason: "budget_exhausted" }),
              snapshotFile({ path: "src/b.ts", patch: null, patchOmittedReason: "not_provided" }),
            ],
          }),
        })}
      />
    );

    expect(screen.getByText(/근거 입력 상한이 소진되어/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub가 이 파일의 patch를 제공하지 않았습니다/)).toBeInTheDocument();
  });

  it("patch 본문을 화면에서 자르지 않고 그대로 보여 준다", () => {
    const patch = `@@ -1,1 +1,400 @@\n${"+line\n".repeat(400)}`;
    const { container } = render(
      <InterviewEvidencePanel
        snapshot={snapshot({ representativeCommit: snapshotCommit({ files: [snapshotFile({ patch })] }) })}
      />
    );

    // 줄 수와 문자 하나까지 스냅샷이 실어 온 그대로여야 합니다. 화면이 한 번 더 자르면 Stage B
    // 절단·스냅샷 절단과 구분되지 않는 세 번째 절단이 생깁니다.
    expect(container.querySelector("pre code")?.textContent).toBe(patch);
  });

  it("커밋 색인에서 찾지 못한 커밋은 무엇을 확인할 수 없는지 알린다", () => {
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({
          representativeCommit: snapshotCommit({
            indexed: false,
            title: null,
            message: null,
            pullRequests: [],
          }),
        })}
      />
    );

    expect(screen.getByText(/커밋 색인에서 찾지 못해/)).toBeInTheDocument();
    expect(screen.getByText("PR 정보 없음")).toBeInTheDocument();
  });

  it("관련 커밋과 인용 파일이 없으면 없다고 알린다", () => {
    const base = snapshot();
    render(
      <InterviewEvidencePanel
        snapshot={snapshot({
          citedFilePaths: { ...base.citedFilePaths, paths: [] },
        })}
      />
    );

    expect(screen.getByText("관련 커밋이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("AI가 인용한 파일이 없습니다.")).toBeInTheDocument();
  });

  it("Repository로 확인할 수 없는 항목을 항상 보여 준다", () => {
    render(<InterviewEvidencePanel snapshot={snapshot()} />);

    expect(screen.getByRole("heading", { name: "Repository로 확인할 수 없는 항목" })).toBeInTheDocument();
    expect(screen.getByText("실제 근무 기간")).toBeInTheDocument();
    expect(screen.getByText("팀 안에서의 역할")).toBeInTheDocument();
  });
});
