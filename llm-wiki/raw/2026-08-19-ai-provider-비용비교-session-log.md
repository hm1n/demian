---
출처: 세션 대화
확인 날짜: 2026-08-19
---

# AI Provider 비용 비교 및 무료 tier 전환 session log

## 문서 목적

기본 프레임워크 세팅 직후, AI Provider를 무료로 사용할 수 있는 것으로 정해야 한다는 요구가 나와 주요 provider의 무료 tier를 비교하고 Gemini와 Groq로 전환하기로 결정한 세션 내용을 보존한다.

## 배경

이전 세션에서 Next.js 전환 결정과 함께 AI Streaming provider로 Vercel AI SDK용 `@ai-sdk/anthropic`을 설치했다. 이후 비용을 상시 무료로 유지하고 싶다는 요구가 나와 주요 provider의 무료 tier를 웹 검색으로 비교했다.

## Provider별 무료 tier 비교 (2026-08-19 확인)

상시 무료(재설정형) 여부로 구분한다.

| Provider | 무료 형태 | 한도 | 모델 | 비고 |
| --- | --- | --- | --- | --- |
| Google Gemini | 상시 무료, 카드 불필요 | Flash 10RPM/250 req/day, Flash-Lite 15RPM/1000 req/day, 1M 컨텍스트 | Flash/Flash-Lite (Pro는 2026-04-01부터 유료 전환) | 컨텍스트가 넉넉해 커밋/diff 근거를 담기 유리 |
| Cerebras | 상시 무료, 카드 불필요 | 1M 토큰/day, 30RPM, 무료 tier는 컨텍스트 8K로 제한 | Llama 4 Scout, Qwen3, gpt-oss-120b 등 오픈웨이트 | 속도 매우 빠름. 컨텍스트 8K가 Repository 근거 코드 담기엔 좁음 |
| Groq | 상시 무료, 카드 불필요 | 30RPM, 6000 TPM, 14400 req/day | Llama 3.1/3.3, GPT-OSS 등 오픈웨이트 | 한도 넉넉. 인터뷰 질문 품질은 오픈웨이트라 별도 검증 필요 |
| OpenRouter(`:free` 모델) | 상시 무료, 카드 불필요 | 20RPM, 50~1000 req/day(카드 등록 후 $10 쓰면 1000으로 영구 상향) | Gemini Flash, DeepSeek R1, Llama 3.3 70B 등 | 한 provider로 여러 모델 실험 가능하나 한도는 직접 붙는 것보다 낮음 |
| Mistral | 상시 무료 "Experiment tier" | 2RPM, 1B 토큰/월 | Large, Codestral 포함 | 2RPM은 스트리밍 데모에 너무 낮음, 평가용으로 명시됨 |
| Anthropic | 1회성 크레딧(약 $5) | 크레딧 소진 시 종료 | Opus/Sonnet/Haiku | 상시 무료 tier 없음 |
| OpenAI | 1회성 $5(3개월 만료) + GPT-3.5만 3RPM 상시 | 매우 낮음 | GPT-3.5 Turbo 무료, GPT-4계열은 유료 | 상시 무료 tier 실질적으로 없음 |
| DeepSeek | 1회성 500만 토큰 | 소진 시 결제수단 등록 필요 | V4 계열 | 상시 무료 tier 없음 |

## 결론 및 결정

Anthropic, OpenAI, DeepSeek는 전부 1회성 트라이얼 크레딧이라 상시 무료 목적에 맞지 않는다고 판단했다. Cerebras는 무료 tier 컨텍스트가 8K로 제한되어 Repository 근거 코드를 담기에 좁다고 판단했다. Mistral 무료 tier는 2RPM이라 실사용이 어렵다고 판단했다.

**결정: AI Provider를 Gemini와 Groq만 사용하기로 한다.**

## 실행 내역

- `@ai-sdk/anthropic` 제거
- `@ai-sdk/google`, `@ai-sdk/groq` 설치
- `npx next build`로 빌드 정상 동작 확인

## 확인 필요

- Google Gemini API 키(`GOOGLE_GENERATIVE_AI_API_KEY`) 발급 필요, 아직 발급 안 함
- Groq API 키(`GROQ_API_KEY`) 발급 필요, 아직 발급 안 함
- API 키 발급 후 실제 `streamText` 호출 코드와 Route Handler 작성 예정
- Gemini/Groq 두 provider를 어떤 기준으로 나눠 쓸지(예: 기능별 분리, fallback 구조 등) 미정
- Groq 오픈웨이트 모델의 인터뷰 질문 생성 품질은 아직 검증 전
