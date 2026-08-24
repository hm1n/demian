import { describe, expect, it } from "vitest";
import {
  buildExperienceEvidenceSnapshot,
  EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS,
} from "./evidence-snapshot";
import { REPOSITORY_UNVERIFIABLE_ITEMS } from "./evidence-verifiability";
import type {
  CandidateDiff,
  ExperienceCandidate,
  ExperienceCandidateListItem,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";

const representative: ReadonlyCommitDetail = {
  sha: "a".repeat(40),
  title: "푸시 알림 재시도 큐 도입",
  author: "octocat",
  date: "2026-08-24T00:00:00Z",
  parentCount: 1,
  message: "푸시 알림 재시도 큐 도입\n\n실패한 알림을 큐에 넣고 지연 재시도합니다.",
  additions: 40,
  deletions: 5,
  changedFiles: 2,
  files: [
    { path: "src/queue.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
    { path: "public/icon.png", status: "added", additions: 10, deletions: 5, changes: 15 },
  ],
  pullRequests: [
    {
      number: 12,
      title: "푸시 알림 재시도",
      state: "closed",
      url: "https://example.com/pr/12",
      baseBranch: "develop",
      headBranch: "feature",
    },
  ],
};

const related: ReadonlyCommitDetail = {
  ...representative,
  sha: "b".repeat(40),
  title: "재시도 지연 시간 조정",
  message: "재시도 지연 시간 조정",
  files: [{ path: "src/delay.ts", status: "modified", additions: 4, deletions: 1, changes: 5 }],
};

const candidate: ExperienceCandidate = {
  sha: representative.sha,
  relatedShas: [related.sha],
  evidence: "재시도 큐를 도입해 알림 유실을 줄인 경험입니다.",
  citedFilePaths: ["src/queue.ts"],
  source: "contribution_match",
};

const data: CandidateDataOutput = {
  allCommits: [representative, related],
  includedCommits: [representative, related],
  repository: { fileTree: [], treeTruncated: false, languages: {} },
};

function listItem(
  overrides: Partial<ExperienceCandidateListItem> = {},
  target: ExperienceCandidate = candidate
): ExperienceCandidateListItem {
  return {
    candidate: target,
    commit: representative,
    origin: "repository",
    normalizedRelatedShas: [...new Set(target.relatedShas.filter((sha) => sha !== target.sha))],
    normalizedCitedFilePaths: [...new Set(target.citedFilePaths)],
    ...overrides,
  };
}

function stageBResult(diffs: readonly CandidateDiff[]): StageBCandidateResult {
  return { candidates: [candidate], insufficientCandidatesReason: "하나뿐입니다.", diffs };
}

const queueDiff = (patch: string | undefined, patchTruncated?: boolean): CandidateDiff => ({
  sha: representative.sha,
  files: [
    {
      path: "src/queue.ts",
      status: "added",
      additions: 30,
      deletions: 0,
      changes: 30,
      ...(patch === undefined ? {} : { patch }),
      ...(patchTruncated === undefined ? {} : { patchTruncated }),
    },
    { path: "public/icon.png", status: "added", additions: 10, deletions: 5, changes: 15 },
  ],
});

function expectSnapshot(result: ReturnType<typeof buildExperienceEvidenceSnapshot>) {
  if (!result.ok) throw new Error(`스냅샷 생성이 실패했습니다: ${result.reason}`);
  return result.snapshot;
}

describe("buildExperienceEvidenceSnapshot", () => {
  it("대표 커밋과 관련 커밋의 근거를 한 스냅샷으로 모은다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([
          queueDiff("@@ -0,0 +1 @@\n+queue"),
          {
            sha: related.sha,
            files: [
              {
                path: "src/delay.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                changes: 5,
                patch: "@@ -1 +1 @@\n-1000\n+3000",
              },
            ],
          },
        ])
      )
    );

    expect(snapshot.candidateSha).toBe(representative.sha);
    expect(snapshot.source).toBe("contribution_match");
    expect(snapshot.representativeCommit.title).toBe("푸시 알림 재시도 큐 도입");
    expect(snapshot.representativeCommit.pullRequests).toEqual([
      {
        number: 12,
        title: "푸시 알림 재시도",
        state: "closed",
        baseBranch: "develop",
        headBranch: "feature",
      },
    ]);
    expect(snapshot.representativeCommit.files[0]).toMatchObject({
      path: "src/queue.ts",
      patch: "@@ -0,0 +1 @@\n+queue",
      patchTruncated: false,
      patchOmittedReason: null,
    });
    expect(snapshot.relatedCommits.map(({ sha }) => sha)).toEqual([related.sha]);
    expect(snapshot.relatedCommits[0].files[0].patch).toBe("@@ -1 +1 @@\n-1000\n+3000");
    expect(snapshot.unverifiableItems).toEqual(REPOSITORY_UNVERIFIABLE_ITEMS);
  });

  it("PR 응답 값은 확인 가능으로, AI가 고른 관련 커밋과 인용 경로는 관계까지만 확인으로 싣는다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(listItem(), data, stageBResult([]))
    );

    expect(snapshot.evidence.verifiability).toMatchObject({
      status: "unverifiable",
      aiSelected: true,
    });
    expect(snapshot.representativeCommit.verifiability).toMatchObject({
      status: "verified",
      aiSelected: false,
    });
    expect(snapshot.relatedCommits[0].verifiability).toMatchObject({
      status: "verified",
      aiSelected: true,
    });
    expect(snapshot.relatedCommits[0].verifiability.detail).toContain("확인 불가");
    expect(snapshot.citedFilePaths).toMatchObject({
      paths: ["src/queue.ts"],
      verifiability: { status: "verified", aiSelected: true },
    });
  });

  it("Stage B가 자른 patch는 본문이 없어도 절단으로 판정한다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(listItem(), data, stageBResult([queueDiff(undefined, true)]))
    );

    expect(snapshot.representativeCommit.files[0]).toMatchObject({
      patch: null,
      patchTruncated: true,
      patchOmittedReason: "budget_exhausted",
    });
  });

  it("GitHub이 patch를 주지 않은 파일은 예산 소진과 구분한다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([queueDiff("@@ -0,0 +1 @@\n+queue")])
      )
    );

    expect(snapshot.representativeCommit.files[1]).toMatchObject({
      path: "public/icon.png",
      patch: null,
      patchTruncated: false,
      patchOmittedReason: "not_provided",
    });
  });

  it("총 상한을 커밋 간 균등 배분하고 절단 사실을 표시한다", () => {
    const oversized = "x".repeat(EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS);
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([
          queueDiff(oversized),
          {
            sha: related.sha,
            files: [
              {
                path: "src/delay.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                changes: 5,
                patch: oversized,
              },
            ],
          },
        ])
      )
    );

    const share = EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS / 2;
    expect(snapshot.representativeCommit.files[0].patch).toHaveLength(share);
    expect(snapshot.representativeCommit.files[0].patchTruncated).toBe(true);
    // 선착순 배분이면 뒤 커밋이 0자를 받습니다. 균등 배분이라 관련 커밋도 자기 몫을 받습니다.
    expect(snapshot.relatedCommits[0].files[0].patch).toHaveLength(share);
    expect(snapshot.patchBudget).toEqual({
      maxTotalChars: EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS,
      usedChars: EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS,
      truncatedByBudget: true,
    });
  });

  it("앞 커밋이 몫을 다 쓰지 않으면 잔액을 뒤 커밋으로 이월한다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([
          queueDiff("짧은 patch"),
          {
            sha: related.sha,
            files: [
              {
                path: "src/delay.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                changes: 5,
                patch: "y".repeat(EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS),
              },
            ],
          },
        ])
      )
    );

    expect(snapshot.relatedCommits[0].files[0].patch).toHaveLength(
      EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS - "짧은 patch".length
    );
  });

  it("관련 커밋이 없으면 대표 커밋이 총 상한을 모두 쓴다", () => {
    const soleCandidate: ExperienceCandidate = { ...candidate, relatedShas: [] };
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem({}, soleCandidate),
        data,
        {
          candidates: [soleCandidate],
          insufficientCandidatesReason: "하나뿐입니다.",
          diffs: [queueDiff("z".repeat(EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS + 1))],
        }
      )
    );

    expect(snapshot.relatedCommits).toEqual([]);
    expect(snapshot.representativeCommit.files[0].patch).toHaveLength(
      EVIDENCE_SNAPSHOT_MAX_TOTAL_PATCH_CHARS
    );
  });

  it("대표 커밋을 색인에서 찾지 못하면 스냅샷을 만들지 않는다", () => {
    const result = buildExperienceEvidenceSnapshot(
      listItem({ commit: null }),
      data,
      stageBResult([])
    );

    expect(result).toEqual({ ok: false, reason: "representative_commit_not_indexed" });
  });

  it("대표 커밋에 변경 파일이 없으면 확인 가능한 근거가 없다고 알린다", () => {
    const result = buildExperienceEvidenceSnapshot(
      listItem({ commit: { ...representative, files: [] } }),
      data,
      stageBResult([])
    );

    expect(result).toEqual({ ok: false, reason: "no_repository_evidence" });
  });

  it("색인에 없는 관련 커밋은 확인 가능으로 표시하지 않고 diff의 변경 파일은 유지한다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        { ...data, includedCommits: [representative] },
        stageBResult([
          {
            sha: related.sha,
            files: [
              {
                path: "src/delay.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                changes: 5,
                patch: "@@ -1 +1 @@\n-1000\n+3000",
              },
            ],
          },
        ])
      )
    );

    expect(snapshot.relatedCommits[0]).toMatchObject({
      indexed: false,
      title: null,
      message: null,
      pullRequests: [],
      verifiability: { status: "unverifiable", aiSelected: true },
    });
    expect(snapshot.relatedCommits[0].files[0].patch).toBe("@@ -1 +1 @@\n-1000\n+3000");
  });
});
