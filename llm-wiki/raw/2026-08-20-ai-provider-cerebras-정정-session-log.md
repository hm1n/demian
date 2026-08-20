---
출처: 세션 대화 + 웹 검증
확인 날짜: 2026-08-20
---

# Cerebras 무료 tier 정정 세션 로그

## 문서 목적

raw/2026-08-19-ai-provider-비용비교-session-log.md에 기록된 Cerebras 관련 내용 중 사실과 다른 부분이 발견되어, 원본은 수정하지 않고 정정 사항을 별도 문서로 남긴다.

## 정정 대상

raw/2026-08-19-ai-provider-비용비교-session-log.md의 아래 내용.

> | Cerebras | 상시 무료, 카드 불필요 | 1M 토큰/day, 30RPM, 무료 tier는 컨텍스트 8K로 제한 | Llama 4 Scout, Qwen3, gpt-oss-120b 등 오픈웨이트 | 속도 매우 빠름. 컨텍스트 8K가 Repository 근거 코드 담기엔 좁음 |

## 정정 내용

### 1. Cerebras는 모델이 아니라 inference provider

Cerebras는 LLM 모델 자체를 만드는 곳이 아니라, GPT-OSS·GLM 등 오픈웨이트 모델을 자체 Wafer-Scale Engine 위에서 초고속으로 실행해 API로 제공하는 inference provider다. Groq와 같은 포지션이다. 원본 문서에서 "Llama 4 Scout, Qwen3, gpt-oss-120b 등 오픈웨이트"라고 모델을 나열한 부분 자체는 틀리지 않았으나, Cerebras를 다른 모델 제공사와 같은 층위로 비교한 것은 포지션 설명이 부족했다.

### 2. 상시 무료가 아니라 1회성 Free Trial

공식 가격 페이지(cerebras.ai/pricing)를 확인한 결과, 신규 계정에 "$5 in free credits after making an account"를 제공하는 1회성 Free Trial 방식이다. 원본에 적힌 "상시 무료, 카드 불필요, 1M 토큰/day, 30RPM"은 사실과 다르다. 정확한 RPM/TPM/컨텍스트 한도는 공식 페이지에 명시되어 있지 않고 대시보드·API 문서 확인이 필요하다.

### 3. 속도 관련 확인

공식 발표는 GPT-OSS-120B 기준 3,000 tokens/sec을 내세우나, 이는 피크 성능 수치다. Artificial Analysis의 독립 측정치는 약 1,670 tokens/sec이다. 두 수치 다 다른 provider 대비 빠른 편이라는 방향성은 맞다.

## 정정에 따른 결론 변경

- Cerebras는 "상시 무료" 조건을 만족하지 못해, 5일 작업 범위 결정에서 최우선 과제로 정한 "토큰 비용 관리"에 맞는 상시 사용 provider 후보에서 제외한다.
- 실제 구현 provider는 기존 결정대로 유지한다. 경험 후보 생성 파이프라인의 1차 필터는 Groq, 2차 diff·PR 기반 최종 판단은 Gemini를 사용한다(raw/2026-08-20-경험후보생성-LLM기반-재설계-session-log.md 참고).
- Cerebras는 상시 사용 provider가 아니라, $5 크레딧 소모를 감수하는 일회성 실험(예: 본인 Repository로 파이프라인 속도·품질 테스트)에 한해 선택적으로 사용할 수 있는 후보로 남긴다.

## 확인 필요

- Cerebras의 정확한 무료 크레딧 소진 후 과금 정책, RPM/TPM/컨텍스트 한도는 공식 문서로 별도 확인 필요.
- OpenRouter·Cloudflare Workers AI는 이번 정정과 별개로 각각 낮은 일일 한도(50 req/day), 프로젝트 인프라(Next.js)와의 비적합성 문제로 후보에서 이미 제외됨.
