import { describe, expect, it } from "vitest";
import {
  INTERVIEW_HISTORY_ITEM_MAX_BYTES,
  INTERVIEW_HISTORY_MAX_BYTES,
  INTERVIEW_HISTORY_MAX_ITEMS,
  INTERVIEW_MAX_TURNS,
  interviewHistoryItemBytes,
  isWellFormedInterviewHistory,
  trimInterviewHistory,
  type InterviewHistoryMessage,
} from "./history";

/** 질문·답변 `pairs`쌍을 만듭니다. 몇 번째 쌍인지 본문에 적어 어느 쌍이 빠졌는지 볼 수 있게 합니다. */
function history(pairs: number): InterviewHistoryMessage[] {
  return Array.from({ length: pairs }, (_, index) => [
    { role: "question" as const, text: `질문 ${index}` },
    { role: "answer" as const, text: `답변 ${index}` },
  ]).flat();
}

describe("이력 상한", () => {
  it("항목 상한이 지원 턴 수에서 유도된다", () => {
    // 마지막 턴 요청에는 지나간 턴의 질문과 답변만 실립니다. 자기 질문은 아직 없습니다.
    expect(INTERVIEW_HISTORY_MAX_ITEMS).toBe(2 * (INTERVIEW_MAX_TURNS - 1));
    expect(INTERVIEW_HISTORY_MAX_ITEMS % 2).toBe(0);
  });

  it("전체 바이트 상한이 항목 수와 항목당 상한의 곱이다", () => {
    // 이 관계가 성립하므로 절단이 항목 수만 봐도 전체 바이트가 상한 안입니다.
    expect(INTERVIEW_HISTORY_MAX_BYTES).toBe(
      INTERVIEW_HISTORY_MAX_ITEMS * INTERVIEW_HISTORY_ITEM_MAX_BYTES
    );
  });

  it("항목 바이트를 문자 수가 아니라 바이트로 센다", () => {
    // 문자 수로 재면 한국어 답변의 실제 크기를 3분의 1로 봅니다.
    expect(interviewHistoryItemBytes({ role: "answer", text: "한글" })).toBe(6);
  });

  it("항목 바이트를 직렬화 기준으로 센다", () => {
    // 원본 UTF-8로 재면 줄바꿈이 많은 답변의 실제 요청 크기를 절반으로 봅니다.
    expect(interviewHistoryItemBytes({ role: "answer", text: "\n" })).toBe(2);
    expect(interviewHistoryItemBytes({ role: "answer", text: "\u0001" })).toBe(6);
  });

  it("상한을 지킨 이력은 직렬화해도 이력 몫 안에 들어온다", () => {
    // 이 성질이 깨지면 상한을 모두 지킨 이력이 요청 본문 상한에서 거절되고, 클라이언트가 자른
    // 결과가 서버에 받아들여진다는 보장이 사라집니다.
    const filler = "\n".repeat(INTERVIEW_HISTORY_ITEM_MAX_BYTES / 2);
    const worstCase = Array.from({ length: INTERVIEW_HISTORY_MAX_ITEMS }, (_, index) => ({
      role: index % 2 === 0 ? ("question" as const) : ("answer" as const),
      text: filler,
    }));

    expect(Math.max(...worstCase.map(interviewHistoryItemBytes))).toBe(
      INTERVIEW_HISTORY_ITEM_MAX_BYTES
    );
    const serialized = worstCase.reduce(
      (sum, message) => sum + interviewHistoryItemBytes(message),
      0
    );
    expect(serialized).toBeLessThanOrEqual(INTERVIEW_HISTORY_MAX_BYTES);
  });
});

describe("isWellFormedInterviewHistory", () => {
  it("빈 이력을 받아들인다", () => {
    // 첫 질문 요청입니다.
    expect(isWellFormedInterviewHistory([])).toBe(true);
  });

  it("질문으로 시작해 답변으로 끝나는 이력을 받아들인다", () => {
    expect(isWellFormedInterviewHistory(history(3))).toBe(true);
  });

  it("마지막이 질문인 이력을 거절한다", () => {
    // 사용자가 아직 답하지 않은 상태입니다. 그대로 실으면 모델이 자기 질문에 또 질문을 붙입니다.
    const unanswered = [...history(1), { role: "question" as const, text: "질문 1" }];

    expect(isWellFormedInterviewHistory(unanswered)).toBe(false);
  });

  it("답변으로 시작하거나 역할이 이어지는 이력을 거절한다", () => {
    expect(
      isWellFormedInterviewHistory([
        { role: "answer", text: "답변 0" },
        { role: "question", text: "질문 0" },
      ])
    ).toBe(false);
    expect(
      isWellFormedInterviewHistory([
        { role: "question", text: "질문 0" },
        { role: "question", text: "질문 1" },
      ])
    ).toBe(false);
  });

  it("빈 본문을 거절한다", () => {
    // 빈 답변을 실으면 모델은 사용자가 아무것도 말하지 않은 자리를 답변으로 읽습니다.
    expect(
      isWellFormedInterviewHistory([
        { role: "question", text: "질문 0" },
        { role: "answer", text: "" },
      ])
    ).toBe(false);
  });
});

describe("trimInterviewHistory", () => {
  it("상한 안의 이력을 그대로 둔다", () => {
    const full = history(INTERVIEW_HISTORY_MAX_ITEMS / 2);

    const trimmed = trimInterviewHistory(full);

    expect(trimmed.history).toEqual(full);
    expect(trimmed.removed).toEqual([]);
  });

  it("상한을 넘으면 첫 쌍을 남기고 가장 오래된 쌍부터 뺀다", () => {
    // 첫 턴이 그 인터뷰가 무엇을 묻고 있는지를 정하므로 남깁니다.
    const overflowing = history(INTERVIEW_HISTORY_MAX_ITEMS / 2 + 2);

    const trimmed = trimInterviewHistory(overflowing);

    expect(trimmed.history).toHaveLength(INTERVIEW_HISTORY_MAX_ITEMS);
    expect(trimmed.history.slice(0, 2)).toEqual(overflowing.slice(0, 2));
    expect(trimmed.history.at(-1)).toEqual(overflowing.at(-1));
    expect(trimmed.removed).toEqual(overflowing.slice(2, 6));
  });

  it("자른 뒤에도 질문과 답변 순서가 남는다", () => {
    // 뺀 개수가 홀수면 남은 이력이 답변으로 시작합니다.
    const trimmed = trimInterviewHistory(history(INTERVIEW_HISTORY_MAX_ITEMS));

    expect(isWellFormedInterviewHistory(trimmed.history)).toBe(true);
    expect(trimmed.removed.length % 2).toBe(0);
  });

  it("뺀 항목을 값으로 돌려준다", () => {
    // 조용히 빼면 사용자는 AI가 자기 답변을 무시했다고 읽습니다.
    const overflowing = history(INTERVIEW_HISTORY_MAX_ITEMS / 2 + 1);

    const trimmed = trimInterviewHistory(overflowing);

    expect(trimmed.removed).toEqual([
      { role: "question", text: "질문 1" },
      { role: "answer", text: "답변 1" },
    ]);
  });
});
