import { describe, expect, it } from "vitest";
import {
  evidenceSnapshotFixture,
  snapshotCommit,
  snapshotFile,
  FIXTURE_RELATED_SHA,
} from "./question-fixture";
import { isExperienceEvidenceSnapshot, isInterviewStreamRequestBody } from "./question-request";

describe("isExperienceEvidenceSnapshot", () => {
  it("스냅샷 계약을 지킨 값을 받아들인다", () => {
    expect(isExperienceEvidenceSnapshot(evidenceSnapshotFixture())).toBe(true);
  });

  it("JSON 왕복 뒤에도 받아들인다", () => {
    const roundTripped = JSON.parse(JSON.stringify(evidenceSnapshotFixture())) as unknown;

    expect(isExperienceEvidenceSnapshot(roundTripped)).toBe(true);
  });

  it("자리와 role이 어긋난 커밋을 거절한다", () => {
    // 대표 자리에 관련 커밋이 들어오면 프롬프트가 "대표 커밋"이라며 관계만 확인된 커밋을 싣습니다.
    const wrongRole = evidenceSnapshotFixture({
      representativeCommit: snapshotCommit({ role: "related" }),
    });
    const wrongRelated = evidenceSnapshotFixture({
      relatedCommits: [snapshotCommit({ sha: FIXTURE_RELATED_SHA, role: "representative" })],
    });

    expect(isExperienceEvidenceSnapshot(wrongRole)).toBe(false);
    expect(isExperienceEvidenceSnapshot(wrongRelated)).toBe(false);
  });

  it("후보 SHA와 대표 커밋 SHA가 다르면 거절한다", () => {
    const mismatched = evidenceSnapshotFixture({ candidateSha: "c".repeat(40) });

    expect(isExperienceEvidenceSnapshot(mismatched)).toBe(false);
  });

  it("patch 본문과 부재 사유가 함께 있거나 함께 없으면 거절한다", () => {
    const bothPresent = evidenceSnapshotFixture({
      representativeCommit: snapshotCommit({
        files: [snapshotFile({ patchOmittedReason: "not_provided" })],
      }),
    });
    const bothMissing = evidenceSnapshotFixture({
      representativeCommit: snapshotCommit({
        files: [snapshotFile({ patch: null, patchOmittedReason: null })],
      }),
    });

    expect(isExperienceEvidenceSnapshot(bothPresent)).toBe(false);
    expect(isExperienceEvidenceSnapshot(bothMissing)).toBe(false);
  });

  it("확인 수준이 빠진 항목을 거절한다", () => {
    const snapshot = evidenceSnapshotFixture();
    const withoutVerifiability = {
      ...snapshot,
      evidence: { text: snapshot.evidence.text },
    };

    expect(isExperienceEvidenceSnapshot(withoutVerifiability)).toBe(false);
  });

  it("SHA 형식과 origin, source를 확인한다", () => {
    expect(isExperienceEvidenceSnapshot(evidenceSnapshotFixture({ candidateSha: "abc" }))).toBe(false);
    expect(
      isExperienceEvidenceSnapshot({ ...evidenceSnapshotFixture(), origin: "manual" })
    ).toBe(false);
    expect(
      isExperienceEvidenceSnapshot({ ...evidenceSnapshotFixture(), source: "guess" })
    ).toBe(false);
  });

  it("숫자 자리에 음수나 실수가 오면 거절한다", () => {
    const negativeChanges = evidenceSnapshotFixture({
      representativeCommit: snapshotCommit({ files: [snapshotFile({ additions: -1 })] }),
    });

    expect(isExperienceEvidenceSnapshot(negativeChanges)).toBe(false);
  });

  it("객체가 아닌 값을 거절한다", () => {
    for (const value of [null, undefined, "snapshot", 1, []]) {
      expect(isExperienceEvidenceSnapshot(value)).toBe(false);
    }
  });
});

describe("isInterviewStreamRequestBody", () => {
  it("snapshot 키 안에 담긴 스냅샷만 받아들인다", () => {
    expect(isInterviewStreamRequestBody({ snapshot: evidenceSnapshotFixture() })).toBe(true);
    expect(isInterviewStreamRequestBody(evidenceSnapshotFixture())).toBe(false);
    expect(isInterviewStreamRequestBody({})).toBe(false);
  });
});
