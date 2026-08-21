---
확인 날짜: 2026-08-21
근거: 이슈 #13 자체 코드 리뷰 1라운드
---

# PAT 세션 후속 backlog

## 조회와 재시도 중 과도기 PAT 참조 제거

- 등급: P2
- 현상: 세션 쿠키를 발급한 뒤에도 기존 클라이언트 GitHub 조회와 같은 Repository 재시도를 위해 PAT를 React state에 보관합니다.
- 분리 근거: 브라우저 JavaScript에서 PAT를 완전히 제거하려면 GitHub 조회를 서버 route handler로 옮겨야 하며, 이는 이슈 #14의 명시된 범위입니다. 현재 PR에서 수정하면 병렬 작업의 파일 경계와 범위 밖 금지 규칙을 위반합니다.
- 승격 경로: 이슈 #14에서 모든 GitHub 조회가 `getGitHubTokenFromRequest()`만 사용하도록 바꾸고 `sessionToken` state와 클라이언트 `GitHubAuth.token` 전달을 삭제합니다. PAT 입력 자체의 브라우저 JavaScript 노출은 OAuth 전환 이슈 #22에서 제거합니다.
