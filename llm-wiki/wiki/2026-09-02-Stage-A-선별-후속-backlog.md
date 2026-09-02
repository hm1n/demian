---
확인 날짜: 2026-09-02
근거: https://github.com/hm1n/demian/pull/74 Codex 1차 리뷰, wiki/2026-08-20-코드리뷰-전략.md
---

# Stage A 선별 후속 backlog

## 문서 목적

Issue #69 PR(#74) Codex 1차 리뷰를 반영하면서 함께 찾았고, non-blocking으로 판정해 이번 PR에
반영하지 않은 항목을 기록합니다. 별도 GitHub Issue는 만들지 않습니다.

## 미뤄 둔 항목

### 1. 기여 항목이 선별 예산을 전부 먹으면 제외 사유가 원인을 잘못 지목합니다

`toStageAUnits`가 선별 예산에서 기여 항목 몫을 먼저 뺍니다.

```ts
selectWorkUnitsForStageA(units, maxSelectionBytes - contributionItemPromptBytes(contributionItems))
```

기여 항목이 길어 이 값이 0 이하가 되면 어떤 묶음도 선별되지 않습니다. 그때 `selectWorkUnitsForStageA`가
붙이는 사유는 `bytes > maxBytes` 비교를 통과해 전부 `over_byte_budget`이 되고, 화면은 **"이 묶음
하나가 한 번에 보낼 수 있는 분량을 혼자 넘습니다"**라고 알립니다. 실제 원인은 묶음 크기가 아니라
기여 항목입니다. 사용자는 자기 커밋이 크다고 이해하고 저장소를 바꾸려 하지만, 줄여야 하는 것은
입력한 기여 항목입니다.

**이번 PR에서 반영하지 않은 이유는 수정 비용입니다.** 사유를 정확히 가르려면
`WorkUnitSelectionExclusionReason`에 항목을 하나 더 만들고 화면 문구와 회귀 테스트를 함께 넣어야
합니다. 제외 사유를 갈라 원인을 지목하게 만든 것이 바로 이번 PR의 변경이므로 같은 자리를 두 번
건드리는 것도 피했습니다. 발생 조건도 좁습니다. 기여 항목 프롬프트가 110,000바이트를 넘어야 하며,
입력란에 아주 긴 텍스트를 붙여넣는 경우입니다.

후속 작업에서는 예산이 0 이하가 되는 조건을 `toStageAUnits`에서 먼저 판별해
`over_contribution_budget` 같은 사유로 내려보내고, 화면이 기여 항목을 줄이라고 안내하게 합니다.
`assertStageARequestWithinLimits`의 오류 문구가 이미 "기여 항목이 길면 줄여주세요"를 담고 있으므로
그 문구와 같은 방향으로 맞춥니다. 회귀 테스트는 긴 기여 항목이 그 사유를 내는지 고정합니다.

### 2. `mapLlmError` 사본 세 개를 통합하는 일

`stage-a.ts`, `stage-b.ts`, `interview/llm-error.ts`가 같은 성격의 분류를 각자 갖고 있습니다. 두
단계는 내보내지도 않아 테스트가 프로덕션 진입점을 통해서만 그 경로를 밟습니다.

`wiki/2026-08-26-Stage-A-B-Gemini-확정-고도화-설계.md` 5-6절이 통합을 예정한 항목이고 Issue #69가
non-goal로 명시했습니다. 이번 PR에서 세 사본에 같은 5xx 분기를 손으로 넣었으므로 통합의 이득은
오히려 커졌습니다. 사본이 셋인 동안에는 한 곳을 고칠 때 나머지 둘을 함께 고쳐야 합니다.
