# Repository 후보 데이터 출력 스키마

## 목적과 범위

Repository 조회·분석 파이프라인이 수집한 원본 데이터와 앞 단계에서 계산한 기본 파생 지표를 개발 경험 후보 생성 기능에 전달합니다. 출력 단계는 `buildCandidateData` 함수이며 GitHub API를 호출하지 않습니다. 후보 평가, 점수 계산, 순위 결정, 최종 후보 선별도 수행하지 않습니다.

근거는 GitHub 이슈 #4의 Goal, Approach, Tasks, Constraints, Definition of Done과 부모 기능 정의서인 GitHub 이슈 #9입니다. 확인 날짜는 2026-08-20입니다.

## 출력 인터페이스

`CandidateDataOutput`은 다음 세 영역으로 구성됩니다.

| 필드 | 타입 | 필수 | 의미 |
| --- | --- | --- | --- |
| `allCommits` | `readonly CommitSummary[]` | 필수 | 블랙리스트 제외 여부와 무관한 인증 사용자 본인 커밋 전체의 SHA, 제목, 작성자, 작성 날짜, 부모 수입니다. |
| `includedCommits` | `readonly ReadonlyCommitDetail[]` | 필수 | 블랙리스트에서 제외되지 않아 상세 조회까지 마친 커밋입니다. |
| `repository.fileTree` | `readonly Readonly<RepositoryTreeEntry>[]` | 필수 | Repository의 Git tree 원본 항목입니다. |
| `repository.treeTruncated` | `boolean` | 필수 | GitHub tree 응답이 잘렸는지 나타냅니다. |
| `repository.languages` | `Readonly<Record<string, number>>` | 필수 | 언어명을 키로, GitHub languages 응답의 바이트 수를 값으로 갖습니다. |

`includedCommits`는 앞 단계가 생성하는 `CommitDetail`을 그대로 사용하며 다음 필드를 포함합니다.

| 필드 | 타입 | 필수 | 의미 |
| --- | --- | --- | --- |
| `sha` | `string` | 필수 | 커밋 식별자입니다. |
| `message` | `string` | 필수 | 커밋 메시지 전체입니다. |
| `files` | `readonly Readonly<CommitFileChange>[]` | 필수 | `path`, 상태, 추가·삭제·전체 변경 줄 수와 선택적인 `patch`를 포함합니다. |
| `pullRequests` | `readonly Readonly<PullRequestReference>[]` | 필수 | PR 번호, 제목, 문자열 상태, URL, base와 head 브랜치입니다. 연결된 PR이 없으면 빈 배열입니다. |
| `additions` | `number` | 필수 | 앞 단계가 계산한 추가 줄 수입니다. |
| `deletions` | `number` | 필수 | 앞 단계가 계산한 삭제 줄 수입니다. |
| `changedFiles` | `number` | 필수 | 앞 단계가 계산한 변경 파일 수입니다. |

## PR 정보 표현

한 커밋이 여러 PR과 연결될 가능성을 보존하기 위해 PR 정보는 배열로 전달합니다. 연결된 PR이 없다는 사실은 빈 배열로 표현합니다. `PullRequestReference`에 없는 병합 날짜를 요구하지 않으며, GitHub가 반환한 PR 상태 문자열을 좁히지 않습니다. 시간 근접성이나 변경 파일 겹침으로 PR 소속을 추정하거나 대체하지 않습니다.

## 데이터 흐름과 책임 경계

`CandidateDataInput`은 `allCommits`와 `contributionData`라는 이름을 가진 읽기 전용 객체입니다. `contributionData`에는 `fetchRepositoryContributionData`가 반환하는 `RepositoryContributionData`를 직접 전달합니다. `buildCandidateData`는 이 객체를 `CandidateDataOutput` 형태로 조립합니다. `fetchCandidateData`는 기존 블랙리스트 필터 결과를 `fetchRepositoryContributionData`에 전달한 뒤 그 결과를 `buildCandidateData`로 연결합니다.

`allCommits`의 입력은 `GET /user`로 확인한 PAT 소유자의 login을 `GET /repos/{owner}/{repo}/commits?author=<login>`에 전달해 조회합니다. 따라서 상세 조회와 같은 PR 연결도 이 본인 커밋 목록에서 시작하며 타인 커밋을 관련 커밋으로 추가하지 않습니다.

## 작성자 판별의 알려진 한계

GitHub의 `author` 필터 결과를 그대로 사용하며 이름이나 이메일 유사도로 작성자를 추측하지 않습니다. 따라서 GitHub 계정에 연결되지 않은 이메일로 만든 커밋, 여러 identity를 사용한 커밋, `Co-authored-by:` trailer로만 참여한 커밋, 타인 이름으로 squash merge된 커밋은 본인 커밋에서 누락될 수 있습니다.

출력 단계는 추가·삭제 줄 수나 변경 파일 수를 다시 계산하지 않습니다. `CommitDetail`의 평면 필드와 PR 정보를 변형하지 않습니다. 출력 배열뿐 아니라 커밋의 파일과 PR 항목, 파일 트리 항목까지 TypeScript의 깊은 `readonly` 계약으로 노출합니다. 런타임 복제나 동결은 하지 않으므로 소비자는 타입 단언으로 이 계약을 우회해서는 안 됩니다. 실제 성능 개선 수치, AI 작성 코드 비중, 코드 변경 규모와 복잡도, 기술적 의사결정의 흔적을 추정하거나 평가하지 않습니다. 점수, 순위, 최종 후보 목록에 해당하는 필드도 출력하지 않습니다.

상세 조회 중 `partial_failure`가 발생하면 Repository 파일 트리와 언어 통계가 완성되지 않았을 수 있어 `CandidateDataOutput`을 만들지 않습니다. 대신 `fetchCandidateData`는 이미 수집한 `CommitDetail[]`을 `CandidateDataFetchError.partialCommits`에 타입 안전하게 보존해 호출자에게 전달합니다. 부분 결과를 화면에 표시할지, 재시도할지와 같은 상태 처리 정책은 이 출력 스키마가 아니라 이슈 #5의 책임입니다.

구현 타입은 `src/lib/github/types.ts`, 조립 함수는 `src/lib/github/candidate-data.ts`를 기준으로 합니다.
