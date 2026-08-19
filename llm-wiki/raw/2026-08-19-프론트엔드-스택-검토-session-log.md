---
출처: 세션 대화
확인 날짜: 2026-08-19
---

# 프론트엔드 스택 검토 세션 로그

## 문서 목적

기획안 원본(raw/2026-08-19-서비스기획안.md)의 Frontend 스택은 React + TypeScript + Vite였다. 이 스택이 이 서비스에 적합한지 Next.js와 비교 검토한 세션 내용을 보존한다. 최종적으로 Next.js로 전환하기로 결정했다.

## 검토 배경

이 서비스는 다음을 필요로 한다.
- GitHub Repository 데이터 조회
- 사용자 GitHub 로그인 및 비공개 Repository 연결
- Vercel AI SDK 기반 AI Streaming 응답

## React + Vite vs Next.js 비교

| 축 | React + Vite | Next.js |
| --- | --- | --- |
| GitHub API 토큰 처리 | 클라이언트 단독으론 토큰 노출 위험, 별도 서버 필요 | Route Handler 내장, 서버 코드 바로 작성 가능 |
| Vercel AI SDK streamText | 서버 없인 못 씀, 결국 백엔드 따로 구성해야 함 | SDK가 Next.js 기준으로 만들어져 Route Handler에서 바로 연결 |
| 배포 | 정적 호스팅 + 별도 API 서버 필요 | Vercel에 프론트/백 한 번에 배포 |
| 렌더링 성능 챌린지(Streaming/Virtualization/Scroll) | 프레임워크 무관, 순수 컴포넌트 레벨 이슈 | 동일 |
| 러닝커브 | 낮음, 세팅 단순 | App Router, Server/Client Component 구분 학습 필요 |
| 5일 스코프 영향 | 백엔드 서버 세팅에 하루 이상 뺏길 가능성 | 백엔드 세팅 거의 불필요, Day 1부터 바로 기능 붙임 |

## GitHub API와 서버 필요 여부

GitHub REST API는 CORS를 허용해서 브라우저에서 직접 호출 가능하다. 공개 Repository를 비로그인으로 조회하는 것만이면 서버 없이도 가능하다. 단 비로그인 요청은 시간당 60회 제한이 있다.

다만 이 서비스처럼 다음을 하려면 서버가 필요하다.
- 사용자가 로그인해서 자기 Repository(비공개 포함)를 연결하는 경우, OAuth 토큰 교환에 필요한 client secret은 브라우저에 노출하면 안 되므로 이 단계는 서버가 처리해야 한다.
- 인증된 요청으로 시간당 5000회 한도를 쓰려면 토큰을 서버에서 관리해야 안전하다.

## Vercel AI SDK를 쓰더라도 서버가 필요한 이유

`streamText`는 LLM Provider(OpenAI/Anthropic 등) API 키로 직접 호출하는 서버 함수다. 이 키를 브라우저에 두면 그대로 노출된다.

Vercel AI SDK 구조 자체가 서버/클라이언트 분리를 전제한다. 서버에서 `streamText`를 실행하고, 클라이언트는 `useChat`/`useCompletion` 훅으로 그 서버 엔드포인트를 fetch만 한다. SDK를 쓴다고 서버 요구사항이 없어지는 것이 아니라, 서버 쪽 구현을 SDK가 표준화해주는 것뿐이다.

## Server State, Virtualization 재검토

TanStack Query, TanStack Virtual은 둘 다 프레임워크에 종속되지 않는 라이브러리라 Next.js로 전환해도 그대로 유지할 수 있다.

Server State(TanStack Query): Next.js는 Server Component와 fetch 캐시로 초기 데이터 로딩 일부를 서버에서 처리할 수 있다. 다만 이 서비스의 핵심 흐름인 경험 후보 재조회, 경험 선택, Repository 재분석처럼 사용자 인터랙션에 따라 바뀌는 상태는 클라이언트에서 계속 관리해야 한다. Server Component가 대체하는 건 초기 로드뿐이고, mutation과 재검증, 로딩·에러 상태 관리는 여전히 TanStack Query 몫이다. 그대로 유지한다.

Virtualization(TanStack Virtual): DOM 측정 기반이라 Client Component(`'use client'`)에서 써야 한다. Next.js 여부와 무관하게 동일하게 동작하므로 변경할 필요가 없다.

## 결론 및 결정

GitHub 로그인, 비공개 Repository 연결, AI Streaming 응답을 모두 고려하면 결국 서버가 필요하다. React + Vite는 이 서버를 별도로 세팅해야 해서 5일 스코프에서 비용이 크다. Next.js는 Route Handler로 이 서버 요구사항을 프론트엔드 프로젝트 안에서 바로 해결할 수 있다. 렌더링 성능 챌린지 자체는 프레임워크 선택과 무관하므로 Vite를 고집할 이유가 없다.

**결정: Frontend 스택을 React + TypeScript + Vite에서 Next.js로 전환한다.**

## 확인 필요

- Next.js App Router 기준 Route Handler와 Server/Client Component 구조 확정
- AI Streaming 응답 구현 방식은 별도 검토 예정
- 기술 스택이 어느 정도 확정되면 wiki/에 기술 스택 선정 ADR 작성
