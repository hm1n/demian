# Stage B diff·PR 판단 계약

## 입출력

- 입력은 `owner`, `repo`, Stage A의 `candidates`이며 클라이언트는 patch를 보내지 않는다.
- 서버가 후보 SHA를 순차 조회하고 diff, PR 소속, Stage A source와 기여 항목을 Gemini에 한 번 전달한다.
- 출력은 최대 3개 후보와 부족 사유, 최종 후보 및 관련 커밋의 제한된 diff다. `diffs[].files[]`는
  절단 또는 생략된 patch에 `patchTruncated: true`를 포함한다.
- 모델은 `gemini-3.7-flash`, SDK 기본 환경 변수 `GOOGLE_GENERATIVE_AI_API_KEY`를 사용한다.
- 이동하는 `gemini-flash-latest` 별칭 대신 고정 ID를 사용해 같은 입력의 재현성과 프로젝트의 고정 ref 규칙을 지킨다.

## 확인 필요: 미검증 초기 상한

- 후보 20개, 파일 patch 4,000자, 전체 patch 60,000자, 라우트 전체 예산
  `STAGE_B_TOTAL_BUDGET_MS` 55초, 최소 LLM 잔여 예산 `STAGE_B_MIN_LLM_BUDGET_MS` 10초다.
- 이 값은 실제 성능 측정 전 초기값이며 이슈 #19에서 확정한다.
- 파일 patch는 절단 사실을 모델에 표시하고, 전체 예산 이후 patch는 생략하되 SHA와 stat은 유지한다.

## 라우트 시간 예산

- 55초 예산은 LLM 단계만이 아니라 GitHub 조회와 LLM 판단을 합친 라우트 전체 기준이다.
- 조회 루프는 반복 사이에 잔여 시간을 확인하고 10초 미만이면 LLM을 호출하지 않고 종료한다.
- 예산 소진은 `llm_timeout` 504로 반환한다. 확인 필요: Stage B의 이 kind는 LLM 단계보다 넓은
  의미이므로 이슈 #18의 상태 매핑에서 구분 방식을 정한다.
- 조회 요청 하나가 오래 걸리면 끝날 때까지 예산을 넘길 수 있다. 필요해지면 조회 계층에
  `AbortSignal`을 배선한다.
- 최소 LLM 잔여 예산도 미검증 초기값이며 이슈 #19에서 실측 후 확정한다.

## source 값의 권위

- `source`는 LLM 판단이 아니라 Stage A가 SHA별로 확정한 값이다. 출력 스키마가 필수로 요구해
  모델도 쓰지만 권위는 서버에 있으며, 불일치하면 거부하지 않고 Stage A 값으로 덮어쓴다.
- 서버가 정답을 확정적으로 아는 필드는 교정하고, 환각 SHA처럼 모델 의도를 알 수 없는 필드는
  전체 거부한다. 이 구분을 이후 검증 실패 등급의 일반 기준으로 삼는다.
- `evidence`, `citedFilePaths`, PR 관계는 계속 실제 Repository 근거와 대조하므로 source 교정이
  근거 안전성을 낮추지 않는다.
- source 불일치는 모델이 입력을 잘못 읽었다는 신호일 수 있다. 그러나 다른 필드는 Repository
  사실로 직접 검증하며, 최대 55초 호출 뒤 재시도해도 같은 오류가 반복될 수 있어 전체 거부는
  채택하지 않았다. 이 신호가 필요해지면 거부가 아니라 로깅으로 다룬다.

## 결정과 한계

- 대표 선정과 관련 근거 정리는 한 요청으로 처리한다. 요청 분할과 서버 내부 후보 축소 재시도는 하지 않는다.
- 실행 시한 초과는 `llm_timeout` 504로 종료한다. 사용자 재시도 상태 연결은 이슈 #18 범위다.
- `fileTree`는 조회하지 않고 인용 경로를 입력 diff 경로로 제한한다. 전체 트리 근거가 필요해지면 이슈 #32에서 확장한다.
- 관련 커밋은 Stage A가 만든 입력 SHA 집합 안에서 같은 PR에 속한 커밋만 허용한다.
- 현재 `/api/candidates/stage-b` 호출 UI는 없다. Loading·Empty·Error 상태 연결은 이슈 #18 범위다.
