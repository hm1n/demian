import { describe, expect, it } from "vitest";
import {
  buildExperienceEvidenceSnapshot,
  estimateEvidenceTokens,
  EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN,
  EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
  serializedByteLength,
  sliceEvidencePatchBySerializedBytes,
} from "./evidence-snapshot";
import { REPOSITORY_UNVERIFIABLE_ITEMS } from "./evidence-verifiability";
import {
  INTERVIEW_QUESTION_SYSTEM_PROMPT_MAX_BYTES,
  renderInterviewEvidencePrompt,
} from "@/features/interview/question-prompt";
import {
  INTERVIEW_QUESTION_MAX_PROMPT_BYTES,
  buildInterviewQuestionPrompt,
  interviewQuestionPromptBytes,
} from "@/features/interview/question-generation";
import type {
  CandidateDiff,
  ExperienceCandidate,
  ExperienceCandidateListItem,
  StageBCandidateResult,
} from "./types";
import type { CandidateDataOutput, ReadonlyCommitDetail } from "@/lib/github/types";

/** 홀로 남은 UTF-16 서로게이트를 찾습니다. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

const delayDiff = (patch: string): CandidateDiff => ({
  sha: related.sha,
  files: [
    {
      path: "src/delay.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      changes: 5,
      patch,
    },
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
        stageBResult([queueDiff("@@ -0,0 +1 @@\n+queue"), delayDiff("@@ -1 +1 @@\n-1000\n+3000")])
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

  it("patch 몫을 커밋 간 균등 배분하고 절단 사실을 표시한다", () => {
    const oversized = "x".repeat(EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN);
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([queueDiff(oversized), delayDiff(oversized)])
      )
    );

    const share = Math.floor(snapshot.patchBudget.maxPatchBytes / 2);
    expect(share).toBeGreaterThan(0);
    const representativePatch = snapshot.representativeCommit.files[0].patch ?? "";
    const relatedPatch = snapshot.relatedCommits[0].files[0].patch ?? "";
    expect(snapshot.representativeCommit.files[0].patchTruncated).toBe(true);
    // 선착순 배분이면 뒤 커밋이 0바이트를 받습니다. 균등 배분이라 관련 커밋도 자기 몫을 받습니다.
    expect(representativePatch).toHaveLength(relatedPatch.length);
    expect(representativePatch.length).toBeGreaterThan(share - 10);
    expect(snapshot.patchBudget.truncatedByBudget).toBe(true);
    expect(snapshot.patchBudget.patchBytes).toBe(
      representativePatch.length + relatedPatch.length
    );
  });

  it("앞 커밋이 몫을 다 쓰지 않으면 잔액을 뒤 커밋으로 이월한다", () => {
    const short = "short-patch";
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([
          queueDiff(short),
          delayDiff("y".repeat(EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN)),
        ])
      )
    );

    const relatedPatch = snapshot.relatedCommits[0].files[0].patch ?? "";
    expect(snapshot.representativeCommit.files[0].patch).toBe(short);
    expect(relatedPatch.length).toBeGreaterThan(Math.floor(snapshot.patchBudget.maxPatchBytes / 2));
    expect(snapshot.patchBudget.patchBytes).toBe(short.length + relatedPatch.length);
    expect(estimateEvidenceTokens(snapshot)).toBeLessThanOrEqual(snapshot.patchBudget.maxInputTokens);
  });

  it("관련 커밋이 없으면 대표 커밋이 patch 몫을 모두 쓴다", () => {
    const soleCandidate: ExperienceCandidate = { ...candidate, relatedShas: [] };
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(listItem({}, soleCandidate), data, {
        candidates: [soleCandidate],
        insufficientCandidatesReason: "하나뿐입니다.",
        diffs: [
          queueDiff("z".repeat(EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN)),
        ],
      })
    );

    expect(snapshot.relatedCommits).toEqual([]);
    expect(snapshot.representativeCommit.files[0].patch?.length).toBeGreaterThan(
      snapshot.patchBudget.maxPatchBytes - 10
    );
  });

  it("비ASCII patch도 문자 수가 아니라 UTF-8 바이트로 상한 안에 묶는다", () => {
    const koreanPatch = "가".repeat(20_000);
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(listItem(), data, stageBResult([queueDiff(koreanPatch)]))
    );

    const { metadataTokens, maxPatchBytes, patchBytes, maxInputTokens } = snapshot.patchBudget;
    const patchText = snapshot.representativeCommit.files[0].patch ?? "";
    expect(serializedByteLength(patchText)).toBe(patchBytes);
    // 문자 수 상한이면 한 글자 3바이트인 근거가 상한의 3배까지 실립니다.
    expect(patchText.length).toBeLessThan(maxPatchBytes);
    expect(patchBytes).toBeLessThanOrEqual(maxPatchBytes);
    expect(metadataTokens + Math.ceil(patchBytes / EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN)).toBeLessThanOrEqual(
      maxInputTokens
    );
  });

  it("이모지가 상한 경계에 걸려도 홀로 남은 서로게이트를 만들지 않는다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(listItem(), data, stageBResult([queueDiff("🙂".repeat(20_000))]))
    );

    const patchText = snapshot.representativeCommit.files[0].patch ?? "";
    expect(patchText.length).toBeGreaterThan(0);
    expect(LONE_SURROGATE.test(patchText)).toBe(false);
    expect(serializedByteLength(patchText) % 4).toBe(0);
  });

  it("대표 커밋을 색인에서 찾지 못하면 스냅샷을 만들지 않는다", () => {
    const result = buildExperienceEvidenceSnapshot(
      listItem({ commit: null }),
      data,
      stageBResult([])
    );

    expect(result).toEqual({ ok: false, reason: "representative_commit_not_indexed" });
  });

  it("대표 커밋이 빈 커밋이어도 관련 커밋에 변경 파일이 있으면 근거로 쓴다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem({ commit: { ...representative, files: [] } }),
        data,
        stageBResult([delayDiff("@@ -1 +1 @@\n-1000\n+3000")])
      )
    );

    expect(snapshot.representativeCommit.files).toEqual([]);
    expect(snapshot.relatedCommits[0].files[0]).toMatchObject({
      path: "src/delay.ts",
      patch: "@@ -1 +1 @@\n-1000\n+3000",
    });
  });

  it("대표 커밋과 관련 커밋 모두 변경 파일이 없으면 확인 가능한 근거가 없다고 알린다", () => {
    const result = buildExperienceEvidenceSnapshot(
      listItem({ commit: { ...representative, files: [] } }),
      { ...data, includedCommits: [{ ...related, files: [] }] },
      stageBResult([])
    );

    expect(result).toEqual({ ok: false, reason: "no_repository_evidence" });
  });

  it("patch를 모두 빼도 나머지 근거가 상한을 넘으면 실패로 알린다", () => {
    const result = buildExperienceEvidenceSnapshot(
      listItem({ commit: { ...representative, message: "긴 커밋 메시지 ".repeat(5_000) } }),
      data,
      stageBResult([])
    );

    expect(result).toEqual({ ok: false, reason: "evidence_input_too_large" });
  });

  it("색인에 없는 관련 커밋은 확인 가능으로 표시하지 않고 diff의 변경 파일은 유지한다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        { ...data, includedCommits: [representative] },
        stageBResult([delayDiff("@@ -1 +1 @@\n-1000\n+3000")])
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

describe("sliceEvidencePatchBySerializedBytes", () => {
  it("상한을 넘지 않는 가장 긴 앞부분을 남긴다", () => {
    expect(sliceEvidencePatchBySerializedBytes("abcdef", 3)).toBe("abc");
    expect(sliceEvidencePatchBySerializedBytes("abc", 10)).toBe("abc");
    expect(sliceEvidencePatchBySerializedBytes("abc", 0)).toBe("");
  });

  it("직렬화에서 이스케이프되는 문자는 늘어난 바이트로 센다", () => {
    // diff는 줄바꿈이 많고 줄바꿈은 직렬화에서 2바이트를 씁니다.
    expect(sliceEvidencePatchBySerializedBytes("a\nb", 3)).toBe("a\n");
    expect(sliceEvidencePatchBySerializedBytes("a\nb", 4)).toBe("a\nb");
    expect(serializedByteLength("a\nb")).toBe(4);
    expect(serializedByteLength('"')).toBe(2);
  });

  it("코드 포인트 경계에서만 잘라 홀로 남은 서로게이트를 만들지 않는다", () => {
    // 이모지 하나가 4바이트이므로 3바이트 상한에서는 통째로 빠집니다.
    expect(sliceEvidencePatchBySerializedBytes("🙂", 3)).toBe("");
    expect(sliceEvidencePatchBySerializedBytes("a🙂", 4)).toBe("a");
    expect(sliceEvidencePatchBySerializedBytes("a🙂", 5)).toBe("a🙂");
    expect(LONE_SURROGATE.test(sliceEvidencePatchBySerializedBytes("🙂🙂", 6))).toBe(false);
  });

  it("한글은 한 글자당 3바이트로 계산한다", () => {
    expect(sliceEvidencePatchBySerializedBytes("가나다", 7)).toBe("가나");
  });
});

describe("완성된 스냅샷 크기", () => {
  it("patch가 몫을 다 써도 직렬화한 스냅샷 전체가 입력 상한을 넘지 않는다", () => {
    // 줄바꿈이 많은 diff는 직렬화에서 바이트가 늘어납니다. 원본 UTF-8 바이트만 재면 상한을 넘습니다.
    const noisy = '@@ -1 +1 @@\n-old\n+new\n"quoted"\n'.repeat(2_000);
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([queueDiff(noisy), delayDiff(noisy)])
      )
    );

    expect(snapshot.patchBudget.truncatedByBudget).toBe(true);
    expect(estimateEvidenceTokens(snapshot)).toBeLessThanOrEqual(EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS);
  });

  it("비ASCII 근거에서도 직렬화한 스냅샷 전체가 입력 상한을 넘지 않는다", () => {
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([
          queueDiff("가나다\n".repeat(10_000)),
          delayDiff("🙂🙂\n".repeat(10_000)),
        ])
      )
    );

    expect(estimateEvidenceTokens(snapshot)).toBeLessThanOrEqual(EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS);
  });
});

describe("estimateEvidenceTokens", () => {
  it("문자 수가 아니라 UTF-8 바이트로 추정한다", () => {
    expect(estimateEvidenceTokens("abc")).toBe(1);
    // 한글 3자는 9바이트이므로 같은 문자 수의 ASCII보다 3배로 추정됩니다.
    expect(estimateEvidenceTokens("가나다")).toBe(3);
  });
});

describe("근거 예산과 실제 프롬프트", () => {
  // 예산은 모델 입력을 묶는 값입니다. JSON 직렬화로 재던 2026-08-28까지는 patch가 큰 근거에서
  // 렌더 결과가 JSON보다 커져 상한이 보증되지 않았습니다(JSON 10,436바이트 대 프롬프트 10,632바이트).
  // 그 회귀를 여기서 고정합니다.
  const patchOf = (size: number) => `@@ -1,1 +1,1 @@${"\n"}+${"a".repeat(size)}`;

  for (const maxInputTokens of [900, 1_500, EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS, 7_000]) {
    it(`상한 ${maxInputTokens}토큰에서 렌더된 프롬프트가 상한을 넘지 않는다`, () => {
      const snapshot = expectSnapshot(
        buildExperienceEvidenceSnapshot(
          listItem(),
          data,
          stageBResult([queueDiff(patchOf(60_000)), delayDiff(patchOf(60_000))]),
          maxInputTokens,
          renderInterviewEvidencePrompt
        )
      );

      expect(snapshot.patchBudget.truncatedByBudget).toBe(true);
      expect(estimateEvidenceTokens(renderInterviewEvidencePrompt(snapshot))).toBeLessThanOrEqual(
        maxInputTokens
      );
    });
  }

  it("줄바꿈이 많은 patch에서도 상한을 넘지 않는다", () => {
    // 렌더 결과에서 줄바꿈은 1바이트인데 `serializedByteLength`는 2바이트로 셉니다. 그 방향이
    // 보수적인지 확인합니다.
    const lines = Array.from({ length: 2_000 }, (_, index) => `+line ${index}`).join("\n");
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([queueDiff(lines), delayDiff(lines)]),
        EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
        renderInterviewEvidencePrompt
      )
    );

    expect(estimateEvidenceTokens(renderInterviewEvidencePrompt(snapshot))).toBeLessThanOrEqual(
      EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS
    );
  });

  it("렌더러로 재면 JSON으로 잴 때보다 patch 몫이 커진다", () => {
    const build = (render?: typeof renderInterviewEvidencePrompt) =>
      expectSnapshot(
        buildExperienceEvidenceSnapshot(
          listItem(),
          data,
          stageBResult([queueDiff(patchOf(60_000)), delayDiff(patchOf(60_000))]),
          EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
          render
        )
      ).patchBudget;

    // JSON은 키와 따옴표를 함께 세므로 메타데이터를 실제보다 크게 봅니다. 그만큼 patch가 굶습니다.
    expect(build(renderInterviewEvidencePrompt).maxPatchBytes).toBeGreaterThan(
      build().maxPatchBytes
    );
  });

  it("근거 상한을 채운 스냅샷의 프롬프트가 route 가드를 통과한다", () => {
    // 프롬프트 바이트 상한은 근거 상한에서 유도됩니다. 두 상수가 어긋나면 정상 요청이 route에서
    // 거절되므로 실제 프롬프트를 접어 보고 확인합니다.
    const snapshot = expectSnapshot(
      buildExperienceEvidenceSnapshot(
        listItem(),
        data,
        stageBResult([queueDiff(patchOf(60_000)), delayDiff(patchOf(60_000))]),
        EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS,
        renderInterviewEvidencePrompt
      )
    );

    const bytes = interviewQuestionPromptBytes(buildInterviewQuestionPrompt(snapshot, "split"));
    expect(bytes).toBeLessThanOrEqual(INTERVIEW_QUESTION_MAX_PROMPT_BYTES);
    // 허용 오차를 쓰지 않고도 통과해야 합니다. 오차는 구성 오차용이고 상시로 쓰는 몫이 아닙니다.
    expect(bytes).toBeLessThanOrEqual(
      EVIDENCE_SNAPSHOT_MAX_INPUT_TOKENS * EVIDENCE_SNAPSHOT_BYTES_PER_TOKEN +
        INTERVIEW_QUESTION_SYSTEM_PROMPT_MAX_BYTES +
        2
    );
  });
});
