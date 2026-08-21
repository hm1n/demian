# Repository 작성자 필터 후속 backlog

## 조회 진행·결과 문구의 커밋 범위 명시

- 등급: P2
- 현재 `repository-analysis-view.tsx`의 Loading 설명과 Success 지표는 `전체 커밋`이라고 표시하지만, 이슈 #20 이후 조회 결과는 인증 사용자 본인의 전체 커밋입니다. Repository 전체 커밋 수로 읽힐 수 있어 `본인 커밋` 범위를 명시하는 문구 재검토가 필요합니다.
- 이 PR에서는 분리합니다. Wave 0 공통 파일 경계에서 이슈 #20은 `EmptyKind`와 `EmptyState` 분기만 수정할 수 있고, Loading과 Success 영역은 허용 범위 밖입니다. 데이터 흐름은 본인 커밋으로 올바르게 제한되며, 지금 수정하면 병렬 작업과의 충돌 위험이 수정 이익보다 큽니다.
