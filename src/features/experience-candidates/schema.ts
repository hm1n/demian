import { jsonSchema } from "ai";
import { ExperienceCandidateOutputError } from "./errors";
import type {
  ExperienceCandidate,
  ExperienceCandidateEvidenceInput,
  ExperienceCandidateOutput,
  ExperienceCandidateSource,
} from "./types";

const SOURCES: readonly ExperienceCandidateSource[] = [
  "contribution_match",
  "automatic_recommendation",
];

// ponytail: 새 검증 의존성 없이 JSON Schema와 최소 런타임 검증을 병행합니다. 계약 변경 시
// 둘의 불일치가 반복되면 단일 스키마에서 타입과 JSON Schema를 함께 생성하는 방식으로 승격합니다.
const candidateOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "insufficientCandidatesReason"] as string[],
  properties: {
    candidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sha", "relatedShas", "evidence", "citedFilePaths", "source"] as string[],
        properties: {
          sha: { type: "string", minLength: 1 },
          relatedShas: { type: "array", items: { type: "string", minLength: 1 } },
          evidence: { type: "string", minLength: 1 },
          citedFilePaths: { type: "array", items: { type: "string", minLength: 1 } },
          source: { type: "string", enum: [...SOURCES] as string[] },
        },
      },
    },
    insufficientCandidatesReason: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] as Array<
        { type: "string"; minLength: number } | { type: "null" }
      >,
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isCandidate(value: unknown): value is ExperienceCandidate {
  if (!isRecord(value)) return false;

  return (
    hasOnlyKeys(value, ["sha", "relatedShas", "evidence", "citedFilePaths", "source"]) &&
    isNonEmptyString(value.sha) &&
    isStringArray(value.relatedShas) &&
    isNonEmptyString(value.evidence) &&
    isStringArray(value.citedFilePaths) &&
    typeof value.source === "string" &&
    SOURCES.includes(value.source as ExperienceCandidateSource)
  );
}

/** Stage A와 Stage B의 구조화 응답을 동일한 계약으로 검증합니다. */
export function validateExperienceCandidateOutput(value: unknown): ExperienceCandidateOutput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["candidates", "insufficientCandidatesReason"]) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 3 ||
    !value.candidates.every(isCandidate)
  ) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "경험 후보 구조화 응답이 출력 스키마와 일치하지 않습니다."
    );
  }

  const reason = value.insufficientCandidatesReason;
  const reasonIsValid =
    value.candidates.length < 3 ? isNonEmptyString(reason) : reason === null;

  if (!reasonIsValid) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "후보가 3개 미만이면 부족 사유가 필요하고, 3개이면 부족 사유는 null이어야 합니다."
    );
  }

  return value as unknown as ExperienceCandidateOutput;
}

/** JSON 텍스트의 파싱 실패와 스키마 위반을 구분된 오류로 변환합니다. */
export function parseExperienceCandidateOutput(text: string): ExperienceCandidateOutput {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ExperienceCandidateOutputError(
      "json_parse",
      "경험 후보 응답을 JSON으로 파싱할 수 없습니다.",
      { cause }
    );
  }

  return validateExperienceCandidateOutput(value);
}

/** 대표 SHA와 관련 SHA 중 입력 집합에 없는 값이 하나라도 있으면 전체 결과를 거부합니다. */
export function assertCandidateShas(
  output: ExperienceCandidateOutput,
  allowedShas: ReadonlySet<string> | readonly string[]
): ExperienceCandidateOutput {
  const allowed = allowedShas instanceof Set ? allowedShas : new Set(allowedShas);
  const returnedShas = output.candidates.flatMap((candidate) => [
    candidate.sha,
    ...candidate.relatedShas,
  ]);
  const unknownShas = [...new Set(returnedShas.filter((sha) => !allowed.has(sha)))];

  if (unknownShas.length > 0) {
    throw new ExperienceCandidateOutputError(
      "unknown_sha",
      `입력 집합에 없는 커밋 SHA가 포함되어 있습니다: ${unknownShas.join(", ")}`,
      { unknownShas }
    );
  }

  return output;
}

/** Stage B 후보의 PR 관계와 인용 경로를 실제 Repository 근거와 대조합니다. */
export function assertCandidateEvidence(
  output: ExperienceCandidateOutput,
  input: ExperienceCandidateEvidenceInput
): ExperienceCandidateOutput {
  const commitsBySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
  assertCandidateShas(output, [...commitsBySha.keys()]);

  for (const candidate of output.candidates) {
    const representative = commitsBySha.get(candidate.sha)!;
    const representativePullRequests = new Set(
      representative.pullRequests.map((pullRequest) => pullRequest.number)
    );
    const unrelatedShas = candidate.relatedShas.filter((sha) =>
      commitsBySha
        .get(sha)!
        .pullRequests.every((pullRequest) => !representativePullRequests.has(pullRequest.number))
    );

    if (unrelatedShas.length > 0) {
      throw new ExperienceCandidateOutputError(
        "unrelated_sha",
        `대표 커밋과 같은 PR에 속하지 않은 관련 SHA가 있습니다: ${unrelatedShas.join(", ")}`,
        { unknownShas: unrelatedShas }
      );
    }

    const citedPaths = new Set(input.fileTree.map(({ path }) => path));
    for (const sha of [candidate.sha, ...candidate.relatedShas]) {
      for (const file of commitsBySha.get(sha)!.files) citedPaths.add(file.path);
    }

    const unknownPaths = candidate.citedFilePaths.filter((path) => !citedPaths.has(path));
    if (unknownPaths.length > 0) {
      throw new ExperienceCandidateOutputError(
        "unknown_file_path",
        `Repository 근거에 없는 인용 파일 경로가 있습니다: ${unknownPaths.join(", ")}`
      );
    }
  }

  return output;
}

/** generateObject와 streamObject에 직접 전달하는 공통 구조화 출력 스키마입니다. */
export const experienceCandidateOutputSchema = jsonSchema<ExperienceCandidateOutput>(
  candidateOutputJsonSchema,
  {
    validate(value) {
      try {
        return { success: true, value: validateExperienceCandidateOutput(value) };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof ExperienceCandidateOutputError
              ? error
              : new ExperienceCandidateOutputError(
                  "schema_validation",
                  "경험 후보 구조화 응답 검증에 실패했습니다.",
                  { cause: error }
                ),
        };
      }
    },
  }
);
