/**
 * 인터뷰 대화 이력입니다.
 *
 * LLM API가 상태를 갖지 않으므로 "대화를 잇는다"는 것은 매 호출에 이력을 다시 싣는다는 뜻입니다.
 * 서버가 대화를 보관하지 않으므로(저장 계층과 사용자 식별자가 없습니다) 클라이언트가 매 턴 전문을
 * 실어 보냅니다. 근거 스냅샷도 매 턴 전량을 다시 싣습니다. 설계 근거는
 * `llm-wiki/wiki/2026-09-03-꼬리질문-대화-프롬프트-전략.md`에 있습니다.
 */
export interface InterviewHistoryMessage {
  /** `question`은 모델이 만든 질문, `answer`는 사용자가 제출한 답변입니다. */
  readonly role: "question" | "answer";
  readonly text: string;
}

/**
 * 인터뷰 한 번이 지원하는 최대 턴 수입니다. 질문 하나가 한 턴이고 첫 질문이 1턴입니다.
 *
 * **값을 임의로 고르지 않고 비용 실측이 선 자리를 그대로 씁니다.** 2026-09-03 측정은 인터뷰를
 * 10턴으로 두고 회당 0.03866~0.04583달러, 예산 10달러 기준 218~258회, 캐싱 손익분기 2.0시간을
 * 냈습니다(`llm-wiki/raw/2026-09-03-꼬리질문-근거-재전송-비용-비교-session-log.md`). 코드가 실측이
 * 덮지 않은 길이의 인터뷰를 허용하면 위키에 적힌 회당 비용이 더 이상 상한이 아니게 됩니다.
 *
 * 실제 인터뷰 길이 분포를 보면 다시 봅니다. 그때 이 상수 하나만 고치면 이력 몫과 요청 본문 상한,
 * 프롬프트 바이트 상한이 유도식으로 따라옵니다.
 */
export const INTERVIEW_MAX_TURNS = 10;

/**
 * 다음 질문을 만들 때 실을 수 있는 이력 항목 수의 상한입니다.
 *
 * 마지막 턴의 요청이 가장 큽니다. 10턴째 요청에는 지나간 9턴의 질문과 답변이 실리므로 18개입니다.
 * 자신의 질문은 아직 만들어지지 않았으므로 이력에 없습니다.
 */
export const INTERVIEW_HISTORY_MAX_ITEMS = 2 * (INTERVIEW_MAX_TURNS - 1);

/**
 * 이력 항목 하나의 UTF-8 바이트 상한입니다. 질문과 답변에 같은 값을 씁니다.
 *
 * 4,500바이트는 2026-09-03 비용 실측의 상단 답변 구간 1,500자입니다. 한국어 한 글자가 UTF-8
 * 3바이트이므로 1,500자가 4,500바이트입니다.
 *
 * 질문에 따로 작은 값을 두지 않습니다. 질문 본문은 서버가 만들지만 클라이언트가 되돌려 보내므로
 * 신뢰할 수 없어 검증은 어차피 필요하고, 첫 질문 실측이 178~213토큰(한국어 기준 약 640바이트)이라
 * 답변 상한 안에 7배 여유로 들어옵니다. 역할마다 상수를 갈라 두면 상한을 정하는 쪽은 답변인데
 * 상수만 둘로 늘어납니다.
 */
export const INTERVIEW_HISTORY_ITEM_MAX_BYTES = 4_500;

/**
 * 이력 전체의 UTF-8 바이트 상한입니다. 요청 본문 상한과 프롬프트 바이트 상한이 이 값을 더해
 * 유도됩니다.
 */
export const INTERVIEW_HISTORY_MAX_BYTES =
  INTERVIEW_HISTORY_MAX_ITEMS * INTERVIEW_HISTORY_ITEM_MAX_BYTES;

/** 이력 항목이 차지하는 UTF-8 바이트입니다. 검증과 절단이 같은 값을 보게 합니다. */
export function interviewHistoryItemBytes(message: InterviewHistoryMessage): number {
  return new TextEncoder().encode(message.text).byteLength;
}

/**
 * 이력이 지켜야 하는 모양인지 봅니다.
 *
 * `question`으로 시작해 두 역할이 번갈아 나오고 마지막은 `answer`여야 합니다. 마지막이 `question`인
 * 이력은 사용자가 아직 답하지 않은 상태이고, 그대로 실으면 모델이 자기 질문에 이어 또 질문을
 * 만듭니다. 빈 문자열도 거절합니다. 빈 답변을 실으면 모델은 사용자가 무엇도 말하지 않은 자리를
 * 답변으로 읽습니다.
 *
 * 크기는 여기서 보지 않습니다. 모양이 어긋난 요청과 큰 요청은 사용자가 할 수 있는 일이 다르고,
 * 그래서 호출부가 오류 분류를 갈라 붙입니다.
 */
export function isWellFormedInterviewHistory(
  history: readonly InterviewHistoryMessage[]
): boolean {
  if (history.length === 0) return true;
  if (history.length % 2 !== 0) return false;
  return history.every(
    (message, index) =>
      message.text.length > 0 && message.role === (index % 2 === 0 ? "question" : "answer")
  );
}

export interface TrimmedInterviewHistory {
  /** 상한 안으로 들어온 이력입니다. */
  readonly history: readonly InterviewHistoryMessage[];
  /** 뺀 항목입니다. 항상 질문·답변 쌍 단위이므로 개수가 짝수입니다. */
  readonly removed: readonly InterviewHistoryMessage[];
}

/**
 * 이력이 상한을 넘으면 가장 오래된 질문·답변 쌍부터 뺍니다.
 *
 * **자르는 쪽이 클라이언트인 이유는 서버가 자를 수 없기 때문입니다.** 서버가 자르려면 자르는 이유인
 * 본문 상한을 넘긴 요청을 먼저 받아야 하므로 성립하지 않습니다. 서버는 상한을 넘긴 요청을 거절만
 * 합니다.
 *
 * **첫 질문과 첫 답변은 남깁니다.** 첫 턴이 그 인터뷰가 무엇을 묻고 있는지를 정합니다. 근거
 * 스냅샷도 그대로 실리므로, 잘려 나가는 것은 중간 대화뿐입니다.
 *
 * 요약해서 접지 않고 빼기만 합니다. 요약은 LLM 호출을 하나 더 쓰거나 규칙 기반으로 잘라내야 하고
 * 어느 쪽도 무엇을 잃었는지 사용자에게 알리기 어렵습니다. 요약이 필요한지는 실제 인터뷰 길이
 * 분포를 본 뒤에 판단합니다.
 *
 * 뺀 항목을 반환값에 실어 호출부가 무엇이 빠졌는지 알릴 수 있게 합니다. 조용히 빼면 사용자는 AI가
 * 자기 답변을 무시했다고 읽습니다.
 *
 * 항목 수만 보고 바이트는 보지 않습니다. 항목마다 `INTERVIEW_HISTORY_ITEM_MAX_BYTES`가 걸리므로
 * 항목 수가 상한 안이면 전체 바이트도 `INTERVIEW_HISTORY_MAX_BYTES` 안입니다. 항목 하나가 그
 * 상한을 넘는 경우는 여기서 풀 수 없습니다. 항목 안을 자르면 무엇을 잃었는지 보이지 않게 되므로
 * 입력 단계에서 막고 서버가 거절합니다.
 *
 * 잘 만들어진 이력(`isWellFormedInterviewHistory`)을 전제로 합니다.
 */
export function trimInterviewHistory(
  history: readonly InterviewHistoryMessage[]
): TrimmedInterviewHistory {
  if (history.length <= INTERVIEW_HISTORY_MAX_ITEMS) return { history, removed: [] };

  // 첫 쌍 뒤부터 뺍니다. 뺀 개수가 짝수여야 남은 이력이 질문·답변 순서를 유지합니다. 상한과 첫 쌍이
  // 모두 짝수이므로 이 차이도 짝수입니다.
  const removedCount = history.length - INTERVIEW_HISTORY_MAX_ITEMS;
  const firstPairEnd = 2;
  return {
    history: [...history.slice(0, firstPairEnd), ...history.slice(firstPairEnd + removedCount)],
    removed: history.slice(firstPairEnd, firstPairEnd + removedCount),
  };
}
