# Stage B diff·PR 판단 계약

## 입출력

- 입력은 `owner`, `repo`, Stage A의 `candidates`이며 클라이언트는 patch를 보내지 않는다.
- 서버가 후보 SHA를 순차 조회하고 diff, PR 소속, Stage A source와 기여 항목을 Gemini에 한 번 전달한다.
- 출력은 최대 3개 후보와 부족 사유, 최종 후보 및 관련 커밋의 제한된 diff다.
- 모델은 `gemini-3.7-flash`, SDK 기본 환경 변수 `GOOGLE_GENERATIVE_AI_API_KEY`를 사용한다.

## 확인 필요: 미검증 초기 상한

- 후보 20개, 파일 patch 4,000자, 전체 patch 60,000자, 실행 시한 55초다.
- 이 값은 실제 성능 측정 전 초기값이며 이슈 #19에서 확정한다.
- 파일 patch는 절단 사실을 모델에 표시하고, 전체 예산 이후 patch는 생략하되 SHA와 stat은 유지한다.

## 결정과 한계

- 대표 선정과 관련 근거 정리는 한 요청으로 처리한다. 요청 분할과 서버 내부 후보 축소 재시도는 하지 않는다.
- 실행 시한 초과는 `llm_timeout` 504로 종료한다. 사용자 재시도 상태 연결은 이슈 #18 범위다.
- `fileTree`는 조회하지 않고 인용 경로를 입력 diff 경로로 제한한다. 전체 트리 근거가 필요해지면 이슈 #32에서 확장한다.
- 관련 커밋은 Stage A가 만든 입력 SHA 집합 안에서 같은 PR에 속한 커밋만 허용한다.
- 현재 `/api/candidates/stage-b` 호출 UI는 없다. Loading·Empty·Error 상태 연결은 이슈 #18 범위다.
