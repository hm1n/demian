import type {
  EvidenceSnapshotCommit,
  EvidenceSnapshotFile,
  EvidenceVerifiability,
  ExperienceEvidenceSnapshot,
} from "@/features/experience-candidates/types";

/**
 * 테스트가 쓰는 근거 스냅샷 픽스처입니다. **운영 경로가 쓰지 않습니다.**
 *
 * 스냅샷은 필드가 많고 서로 일관성 조건이 걸려 있어(`role`이 자리와 맞아야 하고 patch 본문과 부재
 * 사유가 배타적이어야 합니다) 테스트마다 손으로 만들면 조건이 어긋난 값으로 검증하게 됩니다.
 * 한 곳에서 만들고 바꿀 부분만 덮어씁니다. 실제 GitHub 응답으로 만든 스냅샷은 측정 스크립트가
 * 조립합니다.
 */
const VERIFIED: EvidenceVerifiability = {
  status: "verified",
  aiSelected: false,
  detail: "커밋 SHA, 제목, 메시지, 변경 파일, patch 본문은 GitHub 응답 값입니다.",
};

const AI_SELECTED: EvidenceVerifiability = {
  status: "verified",
  aiSelected: true,
  detail: "대표 커밋과 같은 PR에 속한다는 관계까지만 확인됩니다.",
};

const UNVERIFIABLE: EvidenceVerifiability = {
  status: "unverifiable",
  aiSelected: true,
  detail: "AI가 작성한 해석 문장입니다. Repository 값이 아닙니다.",
};

export const FIXTURE_REPRESENTATIVE_SHA = "a".repeat(40);
export const FIXTURE_RELATED_SHA = "b".repeat(40);

export function snapshotFile(overrides: Partial<EvidenceSnapshotFile> = {}): EvidenceSnapshotFile {
  return {
    path: "src/features/interview/sse.ts",
    status: "modified",
    additions: 12,
    deletions: 3,
    changes: 15,
    patch: "@@ -1,3 +1,5 @@\n+export const SSE_KEEP_ALIVE = \": keep-alive\\n\\n\";",
    patchTruncated: false,
    patchOmittedReason: null,
    ...overrides,
  };
}

export function snapshotCommit(
  overrides: Partial<EvidenceSnapshotCommit> = {}
): EvidenceSnapshotCommit {
  return {
    sha: FIXTURE_REPRESENTATIVE_SHA,
    role: "representative",
    indexed: true,
    title: "fix: done 이벤트의 마지막 seq 검증 추가",
    message: "done의 seq가 실제로 받은 마지막 seq와 다르면 단절로 처리한다.",
    pullRequests: [
      { number: 61, title: "질문 스트리밍 표시 기반", state: "closed", baseBranch: "develop", headBranch: "hm1n/issue-60-streaming" },
    ],
    files: [snapshotFile()],
    verifiability: VERIFIED,
    ...overrides,
  };
}

export function evidenceSnapshotFixture(
  overrides: Partial<ExperienceEvidenceSnapshot> = {}
): ExperienceEvidenceSnapshot {
  return {
    candidateSha: FIXTURE_REPRESENTATIVE_SHA,
    source: "automatic_recommendation",
    origin: "repository",
    evidence: {
      text: "SSE done 이벤트의 완결 판정을 대리 지표에서 실제 seq 비교로 바꾼 작업입니다.",
      verifiability: UNVERIFIABLE,
    },
    representativeCommit: snapshotCommit(),
    relatedCommits: [
      snapshotCommit({
        sha: FIXTURE_RELATED_SHA,
        role: "related",
        title: "fix: 청크 없는 단절의 이어받기 안내 분류 정정",
        message: "받은 청크가 있는지로 갈라 안내와 실제 동작을 맞춘다.",
        files: [
          snapshotFile({
            path: "src/features/interview/interview-stream-client.ts",
            patch: null,
            patchTruncated: true,
            patchOmittedReason: "budget_exhausted",
          }),
        ],
        verifiability: AI_SELECTED,
      }),
    ],
    citedFilePaths: {
      paths: ["src/features/interview/sse.ts"],
      verifiability: AI_SELECTED,
    },
    unverifiableItems: ["실제 근무 기간", "팀 안에서의 역할"],
    patchBudget: {
      maxInputTokens: 3_500,
      metadataTokens: 900,
      maxPatchBytes: 7_800,
      patchBytes: 60,
      truncatedByBudget: true,
    },
    ...overrides,
  };
}
