import { createGroq } from "@ai-sdk/groq";
import {
  APICallError,
  generateObject,
  jsonSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  RetryError,
} from "ai";
import { ExperienceCandidateOutputError } from "./errors";
import type { StageACandidate, StageACandidateOutput } from "./types";
import type { CommitDetail } from "@/lib/github/types";

// 이슈 #19 실측(2026-08-24): 기존 `llama-3.3-70b-versatile`은 Groq 모델 목록에서 사라져 404를
// 반환했습니다. 현재 서빙 중인 구조화 출력 가능 모델 중 입력 SHA 전수 응답 계약을 가장 잘
// 지킨 모델입니다. 같은 조건에서 `openai/gpt-oss-20b`는 8개 입력에도 1/8만 응답했습니다.
export const STAGE_A_MODEL = "openai/gpt-oss-120b";
export const INITIAL_STAGE_A_CANDIDATE_LIMIT = 20;
export const UNCLASSIFIED_LABEL = "미분류";
// 이슈 #19 실측으로 확정: 성공 호출은 3.1~11.1초, 계약 위반으로 끝난 호출도 29.0초였습니다.
// route maxDuration 60초보다 먼저 JSON 오류를 반환하는 시한으로 55초를 유지합니다.
export const STAGE_A_TIMEOUT_MS = 55_000;

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
}, abortSignal: AbortSignal) => Promise<unknown>;

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
  // SDK가 재시도한 실패는 `RetryError`로 감싸져 옵니다. `RetryError`는 `APICallError`가 아니므로
  // 벗기지 않으면 429·413 같은 한도와 재시도 대상 서버 오류가 전부 llm_failure로 뭉개집니다.
  // 이슈 #19 실측에서 실제로 한도 초과가 llm_failure로 보고됐습니다.
  if (RetryError.isInstance(error)) return mapLlmError(error.lastError);
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
    // 413도 한도다. 이슈 #19 실측에서 Groq는 분당 토큰(TPM) 한도 초과를 429가 아니라
    // 413 `rate_limit_exceeded`로 반환했고, 이 코드가 없어 일반 실패로 분류됐다.
    if (error.statusCode === 429 || error.statusCode === 413) {
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

/** 모델 ID를 주입할 수 있게 열어 둡니다. 이슈 #19의 측정 스크립트가 후보 모델을 비교할 때 씁니다. */
export function createStageAGenerate(model: string = STAGE_A_MODEL): GenerateStageA {
  return async (payload, abortSignal) => {
    const { object } = await generateObject({
      model: createGroq()(model),
      schema: structuredOutputSchema,
      system:
        `커밋 메시지와 stat만 보고 개발 경험 후보를 선별하세요. 각 SHA를 정확히 한 번 반환하세요. 기여 항목과 명확히 맞으면 contributionItem을 목록의 원문 그대로 쓰세요. 기여 항목이 있더라도 어느 항목에도 맞지 않지만 설명할 가치가 있는 커밋은 contributionItem을 null로 두고 recommended를 true로 하세요. 어느 후보에도 들지 않으면 contributionItem을 '${UNCLASSIFIED_LABEL}'로 두고 recommended를 false로 하세요. 전체 추천은 최대 ${INITIAL_STAGE_A_CANDIDATE_LIMIT}개입니다.`,
      prompt: JSON.stringify(payload),
      abortSignal,
    });
    return object;
  };
}

const generateWithGroq: GenerateStageA = createStageAGenerate();

export async function selectStageACandidates(
  input: StageAInput,
  generate: GenerateStageA = generateWithGroq,
  timeoutMs = STAGE_A_TIMEOUT_MS
): Promise<StageACandidateOutput> {
  const payload = buildStageAPayload(input);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new DOMException("Stage A timeout", "TimeoutError")),
    timeoutMs
  );
  let output: StageAStructuredOutput;
  try {
    output = validateStructuredOutput(await generate(payload, abortController.signal));
  } catch (error) {
    throw mapLlmError(error);
  } finally {
    clearTimeout(timeout);
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
