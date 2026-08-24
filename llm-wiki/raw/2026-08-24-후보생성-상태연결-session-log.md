# 후보 생성 Loading·Empty·Error 상태 연결 session log

경험 후보 생성 기능(이슈 #12)의 Wave 3 진행 기록이다. 대상 이슈는 #18 후보 생성
Loading·Empty·Error 상태 연결이다. `raw/2026-08-21-wave-2-stage-b-오케스트레이션-session-log.md`의
"이슈 #18이 이어받을 확인 필요 항목" 절을 이어받아 처리했다.

## 이어받은 확인 필요 4건의 결정

### 1. Stage B `llm_timeout`의 표시 구분

구분해 표시한다. Stage B의 `llm_timeout`은 GitHub 조회를 포함한 라우트 전체 예산 소진이므로
"Stage B 실행 시간 예산을 초과했습니다"로, Stage A의 `llm_timeout`은 "LLM 분석 시간이
초과되었습니다"로 안내한다. 클라이언트는 어느 단계의 요청이 실패했는지 알고 있으므로 서버 오류
kind를 추가하지 않고 문구만 구분했다. 복구 동작은 두 경우 모두 `retry`다.

### 2. 클라이언트 측 후보 축소 재시도

구현하지 않는다. 축소하려면 어떤 후보를 버릴지 골라야 하는데, 이것은 이슈 본문이 금지한 "임의로
선택하지 않는다"와 충돌한다. 후보 상한과 예산은 이슈 #19가 실측으로 확정할 값이므로, 축소 정책이
필요하다는 실측 근거가 나오면 그때 별도 이슈로 다룬다. 예산 초과 시에는 재시도만 제공한다.

### 3. LLM 단계만 재시도 가능한지

Stage B 안에서 LLM 단계만 재시도하는 것은 불가능하다. 서버가 diff·PR 수집과 판단을 한 요청으로
처리하기로 #17에서 확정했기 때문이다. 대신 재시도 단위를 스테이지로 한다. Stage A 오류는
4단계부터 재시도하며 1~3단계에서 수집한 Repository 데이터를 재사용한다. Stage B 오류는 5단계부터
재시도하며 Stage A 결과를 재사용하고 GitHub 조회는 서버가 다시 한다. 재사용이 안전한 이유는
1~3단계 데이터가 메모리에 완결된 상태로 남아 있고 Stage A 입력이 결정론적이기 때문이다.
`reauthenticate`와 `select_repository` 복구는 기존대로 처음부터 다시 시작한다. 재시도에 필요한
입력은 오류 상태의 `retryPoint`(repository, 기여 항목, 후보 데이터, Stage A 결과)에 보존한다.

### 4. "3개 미만, 기준 완화 안 함" 정책의 화면 표시

최종 후보가 0개이면 Empty 상태로 서버의 `insufficientCandidatesReason`과 "기준을 완화하거나
후보를 임의로 채우지 않습니다" 고정 문구를 표시한다. 1~2개이면 Success 상태로 후보 목록과 함께
생성 개수, 부족 사유, 같은 고정 문구를 표시한다. Stage A에서 후보가 0개이면 Stage B를 호출하지
않고 별도 Empty(`no_stage_a_candidates`)로 끝낸다.

후보가 3개 미만인데 사유가 null인 응답은 계약상 존재하지 않는다. 출력 스키마 검증이 서버(502)와
클라이언트(`invalid_response` 거부) 양쪽에서 이를 막으므로 화면 문구를 따로 정의하지 않았다.
0·1·2·3개 케이스는 상태 머신과 화면 테스트가 모두 커버한다.

## 이번 웨이브에서 추가로 결정한 사항

### 5단계와 6단계의 Loading 표시 경계

하나의 Loading 상태(`stage_b`)로 "5·6단계"를 함께 표시한다. 서버가 두 단계를 한 요청으로
처리하므로 클라이언트는 5→6 전환 시점을 관측할 수 없다. 경과 시간 같은 대리 지표로 가짜 전환을
만드는 것은 AGENTS.md의 판별 기준 규칙(상태를 직접 나타내지 않는 대리 지표 금지) 위반이라
배제했다. 대신 Error에서는 실패 지점이 실제로 구분되므로 diff·PR 재조회 실패(5단계)와 판단
실패(6단계)를 구분해 안내한다.

이 표시는 이슈 DoD "4~6단계 진행 상태가 순서대로 표시됩니다"의 재해석이다. 5·6단계는 서버 단일
요청 설계(#17 확정) 때문에 Loading은 통합 표시하고 Error는 단계를 구분한다. 오케스트레이터가 이
해석을 승인했으며, 조건은 재해석 근거를 PR 본문과 위키에 명시하는 것과 통합 표시에서도 단계
번호("5·6단계")를 유지해 4단계와의 순서 관계를 화면에 남기는 것이다. 둘 다 반영했다.

### 오류 4종의 상태 머신 매핑

이슈가 요구한 4종을 `AnalysisError.kind`로 구분했다.

| 구분 | kind | 원천 오류 kind | 복구 |
| --- | --- | --- | --- |
| LLM 호출 실패 | `llm_call_failure` | `llm_network`, `llm_auth`, `llm_rate_limit`, `llm_timeout`, `llm_configuration`, `llm_request`, `llm_failure` | `retry` |
| 스키마 위반 | `llm_schema_violation` | `schema_validation`, `json_parse` | `retry` |
| 환각 판정 거부 | `llm_hallucination_rejected` | `unknown_sha`, `unrelated_sha`, `unknown_file_path` | `retry` |
| Stage B diff 재조회 실패 | `diff_refetch_failure` | GitHub 조회 kind (`rate_limit`, `auth_revoked`, `repo_not_found`, `network`, `server_error`) | 원인 kind의 기존 복구 재사용 |

세션 만료(`unauthorized`)는 기존 `auth_revoked` 안내와 `reauthenticate`를 재사용한다. 요청 본문
4.5MB 초과(`body_too_large`)는 `request_too_large`로 표시하고 재시도로 해결되지 않으므로
`select_repository`로 복구한다. 새 `RecoveryAction`은 추가하지 않았다.

### Stage A 빈 후보 Empty에 재시도를 제공하지 않는 이유

`no_stage_a_candidates`와 `no_final_candidates` Empty에는 "다른 Repository 선택"만 제공한다.
후보가 나올 때까지 같은 입력을 다시 돌리도록 유도하는 것은 기준 완화를 우회하는 것과 같아서다.
오류가 아니라 모델의 명시적 판단 결과이므로 복구가 아니라 입력 변경이 맞다.

## 알려진 한계

- `/api/candidates/stage-a`와 `stage-b`에 프로덕션 호출자가 없다는 한계 2건은 이번 연결로
  해소됐다. 두 계약 문서의 경계 절을 갱신했다.
- Loading의 5·6단계 경계 미관측은 서버가 진행 신호를 제공하기 전까지 유지된다. 스트리밍은 실행
  시간 상한을 늘려주지 않아 #17에서 기각된 상태다.
- 성공 화면은 후보 SHA, 출처, evidence만 표시한다. diff 근거 표시는 경험 후보별 근거 표시 이슈의
  범위다. Stage B 응답의 `diffs`는 성공 상태에 보존해 다음 이슈가 사용할 수 있게 했다.
