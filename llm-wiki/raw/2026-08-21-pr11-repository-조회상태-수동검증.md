---
확인 날짜: 2026-08-21
대상: GitHub Issue #5, PR #11 Repository 조회 및 분석 상태 처리
방식: 로컬 개발 서버와 실제 GitHub Repository를 사용한 사용자 참여 수동 검증
---

# PR #11 Repository 조회 상태 수동 검증

## 검증 범위

Repository 조회 및 분석 과정의 Loading, Empty, Error 상태 중 현재 mock UI에서 관찰 가치가 높은 정상 Loading 흐름과 `partial_failure`, `repo_not_found`, `auth_revoked`를 확인했다. UI는 추후 확정·변경될 예정이므로 나머지 상태는 이번 세션에서 추가 재현하지 않았다.

GitHub PAT은 브라우저의 비밀번호 입력 폼에만 입력했고 터미널, 채팅, 파일에는 기록하지 않았다. 검증 중 `src` 아래 소스 파일은 수정하지 않았다.

## 결과

| 상태 | 결과 | 관찰 내용 |
| --- | --- | --- |
| Loading 1단계 `commits` | 통과 | `전체 커밋을 조회하고 있습니다` 문구를 확인했다. |
| Loading 2단계 `details` | 통과 | 상세 조회 완료 숫자가 실제로 증가했고, 상세 조회 뒤 `Repository 정보를 조회하고 있습니다` 문구로 전환되는 것을 확인했다. |
| Loading 3단계 `deriving` | 통과 | `파생 지표를 계산하고 있습니다` 문구를 확인했다. 이 단계는 동기 조립 직전 한 프레임만 보일 수 있다는 알려진 특성이 있다. |
| Empty `no_commits` | 미실시 | UI 확정 전 수동 검증을 종료했다. |
| Empty `no_analyzable_commits` | 미실시 | UI 확정 전 수동 검증을 종료했다. |
| Error `rate_limit` | 미실시 | 자연 재현이 어렵고 UI 확정 전 수동 검증을 종료했다. |
| Error `auth_revoked` | 통과 | 인증 안내와 `GitHub 인증 다시 하기` 버튼을 확인했다. 버튼 실행 후 토큰이 지워지고 토큰 입력란으로 포커스가 이동하며 Owner와 Repository는 유지됐다. |
| Error `repo_not_found` | 통과 | 저장소 미존재 안내와 `Repository 다시 선택` 버튼을 확인했다. 버튼 실행 후 Owner와 Repository가 비워지고 Owner 입력란으로 포커스가 이동했다. |
| Error `partial_failure` | 통과 | 상세 조회 대상 520개 중 4개를 수집한 뒤 네트워크를 끊어 재현했다. 수집 개수, 원래 실패 원인, 처음부터 재조회한다는 안내와 복구 버튼이 일치했다. |
| Error `network` / `server_error` | 미실시 | 직접 network 오류와 GitHub 5xx server error는 UI 확정 전 수동 검증을 종료했다. |

정상 완료에서는 전체 커밋 37개와 상세 조회 커밋 26개가 표시됐다.

## 부분 실패 상세

`hm1n/Algorithm` Repository의 상세 조회 진행 중 네트워크를 끊었다. 화면에는 다음 정보가 함께 표시됐다.

- 제목: `일부 Repository 데이터만 수집했습니다`
- 범위: `상세 조회 대상 520개 중 4개를 수집한 뒤 실패했습니다.`
- 원인: `원래 실패 원인: GitHub에 연결하지 못했습니다.`
- 재개 정책: 부분 결과를 이어 쓰지 않고 복구 뒤 처음부터 다시 조회
- 복구 버튼: `전체 조회 다시 시도`

안내 문구와 복구 버튼이 모두 원래 실패 원인인 network에 맞게 일치했다. 이번 재현은 전체 커밋 페이지네이션 도중이 아니라 상세 조회 도중 발생한 부분 실패이므로, 커밋 페이지 경계에서의 부분 실패는 별도로 검증하지 않았다.

## 발견한 결함

실시한 범위에서는 결함을 발견하지 못했다. 미실시 상태는 실패로 판정하지 않는다.

## 확인 필요 사항

- UI 문구와 구조가 확정된 뒤 `no_commits`, `no_analyzable_commits`, 직접 `network`, `server_error` 상태를 다시 검증한다.
- `rate_limit`은 안정적인 재현 수단이 마련될 때 검증한다.
- 커밋 목록 페이지네이션 중 네트워크 단절로 발생하는 `partial_failure`도 별도로 검증한다.
- 추후 UI 확정 및 구현 시 주요 상태 전환과 복구 동작에 Playwright 기반 E2E 테스트 도입을 고려한다.
