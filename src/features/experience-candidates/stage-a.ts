import { createGroq } from "@ai-sdk/groq";
import {
  APICallError,
  generateObject,
  jsonSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
} from "ai";
import { ExperienceCandidateOutputError } from "./errors";
import type { StageACandidate, StageACandidateOutput } from "./types";
import type { CommitDetail } from "@/lib/github/types";

export const STAGE_A_MODEL = "llama-3.3-70b-versatile";
export const INITIAL_STAGE_A_CANDIDATE_LIMIT = 20;
export const UNCLASSIFIED_LABEL = "미분류";

export type StageACommit = Pick<
  CommitDetail,
  "sha" | "message" | "additions" | "deletions" | "changedFiles"
> & {
  readonly files: readonly Pick<
    CommitDetail["files"][number],
    "path" | "status" | "additions" | "deletions" | "changes"
  >[];
};

export interface StageAInput {
  readonly commits: readonly StageACommit[];
  readonly contributionItems: readonly string[];
}

interface StageADecision {
  readonly sha: string;
  readonly contributionItem: string | null;
  readonly recommended: boolean;
}

interface StageAStructuredOutput {
  readonly decisions: readonly StageADecision[];
}

export type GenerateStageA = (payload: {
  readonly commits: readonly StageACommit[];
  readonly contributionItems: readonly string[];
}) => Promise<unknown>;

const structuredOutputSchema = jsonSchema<StageAStructuredOutput>({
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sha", "contributionItem", "recommended"],
        properties: {
          sha: { type: "string", minLength: 1 },
          contributionItem: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          recommended: { type: "boolean" },
        },
      },
    },
  },
});

function validateStructuredOutput(value: unknown): StageAStructuredOutput {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { decisions?: unknown }).decisions) ||
    (value as { decisions: unknown[] }).decisions.some((decision) => {
      if (typeof decision !== "object" || decision === null) return true;
      const { sha, contributionItem, recommended } = decision as Partial<StageADecision>;
      return (
        Object.keys(decision).length !== 3 ||
        typeof sha !== "string" ||
        sha.length === 0 ||
        (contributionItem !== null &&
          (typeof contributionItem !== "string" || contributionItem.length === 0)) ||
        typeof recommended !== "boolean"
      );
    })
  ) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 구조화 응답이 출력 스키마와 일치하지 않습니다."
    );
  }
  return value as StageAStructuredOutput;
}

export function buildStageAPayload(input: StageAInput) {
  return {
    commits: input.commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      additions: commit.additions,
      deletions: commit.deletions,
      changedFiles: commit.changedFiles,
      files: commit.files.map(({ path, status, additions, deletions, changes }) => ({
        path,
        status,
        additions,
        deletions,
        changes,
      })),
    })),
    contributionItems: [...input.contributionItems],
  };
}

function mapLlmError(error: unknown): ExperienceCandidateOutputError {
  if (error instanceof ExperienceCandidateOutputError) return error;
  if (NoObjectGeneratedError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 구조화 응답이 출력 스키마와 일치하지 않습니다.",
      { cause: error }
    );
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return new ExperienceCandidateOutputError(
      "llm_configuration",
      "LLM API 키가 설정되지 않았습니다.",
      { cause: error }
    );
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new ExperienceCandidateOutputError("llm_timeout", "Stage A 분석 시간이 초과되었습니다.", {
      cause: error,
    });
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new ExperienceCandidateOutputError("llm_auth", "LLM 인증에 실패했습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 429) {
      return new ExperienceCandidateOutputError("llm_rate_limit", "LLM 호출 한도에 도달했습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 408 || error.statusCode === 504) {
      return new ExperienceCandidateOutputError("llm_timeout", "Stage A 분석 시간이 초과되었습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 404) {
      return new ExperienceCandidateOutputError("llm_configuration", "LLM 모델 설정이 올바르지 않습니다.", {
        cause: error,
      });
    }
    if (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 422) {
      return new ExperienceCandidateOutputError("llm_request", "LLM이 요청을 거부했습니다.", {
        cause: error,
      });
    }
    return new ExperienceCandidateOutputError("llm_failure", "Stage A 분석에 실패했습니다.", {
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new ExperienceCandidateOutputError("llm_network", "LLM에 연결하지 못했습니다.", {
      cause: error,
    });
  }
  return new ExperienceCandidateOutputError("llm_failure", "Stage A 분석에 실패했습니다.", {
    cause: error,
  });
}

const generateWithGroq: GenerateStageA = async (payload) => {
  const { object } = await generateObject({
    model: createGroq()(STAGE_A_MODEL),
    schema: structuredOutputSchema,
    system:
      `커밋 메시지와 stat만 보고 개발 경험 후보를 선별하세요. 각 SHA를 정확히 한 번 반환하세요. 기여 항목과 명확히 맞으면 contributionItem을 목록의 원문 그대로 쓰세요. 기여 항목이 있더라도 어느 항목에도 맞지 않지만 설명할 가치가 있는 커밋은 contributionItem을 null로 두고 recommended를 true로 하세요. 어느 후보에도 들지 않으면 contributionItem을 '${UNCLASSIFIED_LABEL}'로 두고 recommended를 false로 하세요. 전체 추천은 최대 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개입니다.`,
    prompt: JSON.stringify(payload),
  });
  return object;
};

export async function selectStageACandidates(
  input: StageAInput,
  generate: GenerateStageA = generateWithGroq
): Promise<StageACandidateOutput> {
  const payload = buildStageAPayload(input);
  let output: StageAStructuredOutput;
  try {
    output = validateStructuredOutput(await generate(payload));
  } catch (error) {
    throw mapLlmError(error);
  }

  const allowedShas = new Set(payload.commits.map(({ sha }) => sha));
  const returnedShas = output.decisions.map(({ sha }) => sha);
  const unknownShas = [...new Set(returnedShas.filter((sha) => !allowedShas.has(sha)))];
  if (unknownShas.length > 0) {
    throw new ExperienceCandidateOutputError(
      "unknown_sha",
      `입력 집합에 없는 커밋 SHA가 포함되어 있습니다: ${unknownShas.join(", ")}`,
      { unknownShas }
    );
  }
  if (new Set(returnedShas).size !== returnedShas.length) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 응답에 같은 SHA가 두 번 이상 포함되어 있습니다."
    );
  }
  if (returnedShas.length !== allowedShas.size) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      "Stage A 응답은 입력된 모든 커밋 SHA를 정확히 한 번 포함해야 합니다."
    );
  }

  const contributionItems = new Set(input.contributionItems);
  const candidates = output.decisions.flatMap<StageACandidate>((decision) => {
    if (
      decision.contributionItem !== UNCLASSIFIED_LABEL &&
      decision.contributionItem !== null &&
      contributionItems.has(decision.contributionItem)
    ) {
      return [{
        sha: decision.sha,
        source: "contribution_match" as const,
        contributionItem: decision.contributionItem,
      }];
    }
    if (decision.recommended) {
      return [{
        sha: decision.sha,
        source: "automatic_recommendation" as const,
        contributionItem: null,
      }];
    }
    return [];
  });

  if (candidates.length > INITIAL_STAGE_A_CANDIDATE_LIMIT) {
    throw new ExperienceCandidateOutputError(
      "schema_validation",
      `Stage A 후보는 초기 상한 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개를 넘을 수 없습니다.`
    );
  }

  const candidateShas = new Set(candidates.map(({ sha }) => sha));
  return {
    candidates,
    unclassifiedShas: payload.commits
      .map(({ sha }) => sha)
      .filter((sha) => !candidateShas.has(sha)),
  };
}
