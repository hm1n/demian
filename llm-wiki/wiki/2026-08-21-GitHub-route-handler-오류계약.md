---
확인 날짜: 2026-08-21
근거: GitHub 이슈 #14, src/lib/github/api-contract.ts
---

# GitHub route handler 오류 계약

브라우저는 GitHub API를 직접 호출하지 않고 `/api/github/*` 배치 route를 호출한다. PAT는 요청 body에 포함하지 않으며 서버가 암호화된 HttpOnly 쿠키에서 읽는다. 커밋 목록 커서는 첫 요청에서 고정한 head SHA와 다음 페이지만 base64url JSON으로 전달하고 서버에서 형태를 검증한다. 인증 사용자 login은 커서에 넣지 않고 매 배치 요청에서 PAT로 다시 조회한다. 커서 서명·암호화보다 적은 코드로 클라이언트가 신원을 바꿀 가능성 자체를 제거하기 위한 결정이다. head SHA 위조는 호출자 PAT가 해당 Repository에서 접근 가능한 스냅샷 범위만 바꾸며 GitHub가 접근 권한을 검증하므로 커서에 유지한다.

## 오류 매핑

오류 응답은 후보 생성 API와 같은 `{ error: { kind, message, ... } }` 봉투를 쓴다.

| `error.kind` | HTTP status | 화면 복구 동작 |
| --- | ---: | --- |
| `invalid_json` | 400 | UI 도달 불가 |
| `invalid_request` | 422 | UI 도달 불가 |
| `auth_revoked` | 401 | GitHub 인증 다시 하기 |
| `repo_not_found` | 404 | Repository 다시 선택 |
| `rate_limit` | 429 | 전체 조회 다시 시도 |
| `network` | 502 | 전체 조회 다시 시도 |
| `server_error` | 500 | 전체 조회 다시 시도 |
| `partial_failure` | 500 | 근본 `causeKind`에 따른 복구 |

`invalid_json`과 `invalid_request`는 조회 오류가 아니라 route 입력 계약 위반이므로 `GitHubFetchErrorKind`와 화면 상태 정책에 추가하지 않는다. 클라이언트가 이 kind를 받으면 알 수 없는 오류로 보고 기존 `server_error` 안내를 사용한다.

`partial_failure`는 `partialCommits`, `causeKind`, `completed`, `total`을 함께 보존한다. 클라이언트는 JSON이 아니거나 계약 형태가 아닌 응답을 `server_error`, `fetch` 자체 실패를 `network`로 복원한다. 커밋 상세 응답과 부분 실패 본문 모두 파일 `patch`를 제외한다.

여러 route 배치 중 실패하면 클라이언트는 앞선 성공 요청의 결과와 실패한 요청이 반환한 `partialCommits`를 합친다. 실패한 요청의 결과는 성공 응답 배열에 추가되기 전에 예외로 전달되므로 두 집합은 겹치지 않는다.

Repository 메타데이터 요청은 클라이언트가 빈 저장소 여부를 전달하지 않는다. 트리 조회가 404 또는 409일 때만 서버가 기본 브랜치 head를 직접 재확인하고, head가 없을 때만 빈 트리로 처리한다.

## 오케스트레이션 결정

기존 `analyzeRepository` 순수 함수와 `AnalysisDependencies` 주입 경계를 유지하고 기본 의존성만 자체 API 배치 클라이언트로 교체한다. React Query는 서버 상태 캐시나 컴포넌트 훅 전환이 필요한 흐름이 아니므로 사용하지 않는다. 배치 중간 결과는 호출 중인 클라이언트 함수의 지역 변수에만 두고 서버는 무상태로 유지한다.

## 확인 필요

- `maxDuration = 60`과 커밋 20페이지·상세 20개 배치 값은 미검증 초기값이며 이슈 #19에서 실측 후 확정한다.
- 상세 조회 병렬화와 secondary rate limit 여유는 실데이터 측정 전까지 순차 호출을 유지한다.
- 재분석 시 전량 재조회 문제는 실제 비용을 측정한 뒤 캐시 도입 시점을 판단한다.
