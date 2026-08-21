import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertCandidateEvidence,
  assertCandidateShas,
  parseExperienceCandidateOutput,
  validateExperienceCandidateOutput,
} from "./schema";
import { ExperienceCandidateOutputError } from "./errors";
import type { ExperienceCandidateOutput } from "./types";

const VALID_OUTPUT: ExperienceCandidateOutput = {
  candidates: [
    {
      sha: "representative",
      relatedShas: ["related"],
      evidence: "PR 안에서 파서와 오류 처리를 함께 구현했습니다.",
      citedFilePaths: ["src/parser.ts"],
      source: "contribution_match",
    },
    {
      sha: "automatic",
      relatedShas: [],
      evidence: "스트리밍 경계를 명확하게 분리했습니다.",
      citedFilePaths: ["src/stream.ts"],
      source: "automatic_recommendation",
    },
    {
      sha: "third",
      relatedShas: [],
      evidence: "실패 상태를 타입으로 구분했습니다.",
      citedFilePaths: ["src/errors.ts"],
      source: "automatic_recommendation",
    },
  ],
  insufficientCandidatesReason: null,
};

describe("경험 후보 출력 검증", () => {
  it("유효한 응답을 타입 안전하게 반환한다", () => {
    const output = validateExperienceCandidateOutput(VALID_OUTPUT);

    expect(output).toEqual(VALID_OUTPUT);
    expectTypeOf(output).toEqualTypeOf<ExperienceCandidateOutput>();
  });

  it("JSON 파싱 실패를 타입 있는 오류로 변환한다", () => {
    expect(() => parseExperienceCandidateOutput("{invalid json")).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({ kind: "json_parse" })
    );
  });

  it("스키마 위반을 타입 있는 오류로 변환한다", () => {
    expect(() =>
      validateExperienceCandidateOutput({
        candidates: [{ ...VALID_OUTPUT.candidates[0], source: "ranked" }],
        insufficientCandidatesReason: "후보가 부족합니다.",
      })
    ).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "schema_validation",
      })
    );
  });

  it("후보가 3개 미만이면 부족 사유를 보존한다", () => {
    const output = validateExperienceCandidateOutput({
      candidates: [VALID_OUTPUT.candidates[0]],
      insufficientCandidatesReason: "근거가 충분한 커밋이 하나뿐입니다.",
    });

    expect(output.insufficientCandidatesReason).toBe("근거가 충분한 커밋이 하나뿐입니다.");
  });

  it("후보가 3개 미만인데 부족 사유가 없으면 거부한다", () => {
    expect(() =>
      validateExperienceCandidateOutput({
        candidates: [VALID_OUTPUT.candidates[0]],
        insufficientCandidatesReason: null,
      })
    ).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "schema_validation",
      })
    );
  });

  it("후보가 최대 개수인 3개를 초과하면 거부한다", () => {
    expect(() =>
      validateExperienceCandidateOutput({
        candidates: [...VALID_OUTPUT.candidates, VALID_OUTPUT.candidates[0]],
        insufficientCandidatesReason: null,
      })
    ).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "schema_validation",
      })
    );
  });
});

describe("후보 SHA 검증", () => {
  it("대표 SHA와 관련 SHA가 모두 입력에 있으면 전체 결과를 반환한다", () => {
    expect(
      assertCandidateShas(VALID_OUTPUT, ["representative", "related", "automatic", "third"])
    ).toBe(VALID_OUTPUT);
  });

  it("하나라도 입력에 없는 SHA이면 일부 후보도 반환하지 않고 오류로 처리한다", () => {
    expect(() =>
      assertCandidateShas(VALID_OUTPUT, ["representative", "automatic", "third"])
    ).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "unknown_sha",
        unknownShas: ["related"],
      })
    );
  });
});

describe("후보 Repository 근거 검증", () => {
  const evidenceInput = {
    commits: [
      {
        sha: "representative",
        files: [{ path: "src/parser.ts" }],
        pullRequests: [{ number: 10 }],
      },
      {
        sha: "related",
        files: [{ path: "src/parser.test.ts" }],
        pullRequests: [{ number: 10 }],
      },
      {
        sha: "automatic",
        files: [{ path: "src/stream.ts" }],
        pullRequests: [],
      },
      {
        sha: "third",
        files: [{ path: "src/errors.ts" }],
        pullRequests: [],
      },
    ],
    fileTree: [{ path: "README.md" }],
  };

  it("입력에 존재해도 대표 커밋과 같은 PR이 아닌 관련 SHA는 거부한다", () => {
    const output = {
      ...VALID_OUTPUT,
      candidates: [
        { ...VALID_OUTPUT.candidates[0], relatedShas: ["automatic"] },
        ...VALID_OUTPUT.candidates.slice(1),
      ],
    };

    expect(() => assertCandidateEvidence(output, evidenceInput)).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "unrelated_sha",
      })
    );
  });

  it("Repository 파일 트리와 후보 커밋에 없는 인용 경로는 거부한다", () => {
    const output = {
      ...VALID_OUTPUT,
      candidates: [
        { ...VALID_OUTPUT.candidates[0], citedFilePaths: ["src/invented.ts"] },
        ...VALID_OUTPUT.candidates.slice(1),
      ],
    };

    expect(() => assertCandidateEvidence(output, evidenceInput)).toThrowError(
      expect.objectContaining<Partial<ExperienceCandidateOutputError>>({
        kind: "unknown_file_path",
      })
    );
  });
});
