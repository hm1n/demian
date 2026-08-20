---
name: pull-request
description: GitHub Issue와 Git diff를 바탕으로 사람이 빠르게 이해할 수 있는 Pull Request를 작성합니다.
---
# Pull Request

프로젝트의 GitHub Pull Request Template에 맞춰 Pull Request를 작성합니다.

Pull Request는 변경 내역이 아니라 **의사결정 문서**입니다.

## 사용 시점

다음 상황에서 사용합니다.

- GitHub Issue 구현이 완료되었을 때
- Pull Request를 생성할 때
- 변경 사항, 영향 범위, 리뷰 포인트를 정리할 때

다음 상황에서는 사용하지 않습니다.

- GitHub Issue 작성
- Commit Message 작성
- Bug Report 작성

---

## 작업 원칙

- 하나의 GitHub Issue는 하나의 Pull Request로 구현합니다.
- 연결된 GitHub Issue의 Why, Goal, Constraints를 먼저 이해한 후 Pull Request를 작성합니다.
- Git diff를 확인하여 실제 변경 사항만 작성합니다.
- PR 본문은 한국어로 작성합니다.
- PR은 다른 사람이 함께 보는 공유 문서이므로 본문은 존댓말(습니다체)로 작성합니다.
- PR은 `Why → Decision → Changes → Impact → Review Points → Validation` 흐름으로 작성합니다.
- 변경 사항을 나열하기보다 왜 그렇게 구현했는지 설명합니다.
- 확인하지 않은 테스트는 실행했다고 작성하지 않습니다.
- 불확실한 내용은 `확인 필요`로 표시합니다.
- 리뷰어가 집중해서 봐야 할 위험 영역을 명확히 표시합니다.
- Review Points는 가능하면 3개 이내로 제한합니다.
- 연결된 GitHub Issue가 없다면 먼저 Issue 생성을 제안합니다.

---

## GitHub 설정

PR을 생성할 때 아래 설정을 함께 적용합니다.

- Assignee는 `hm1n`으로 고정합니다.
- Label은 PR 제목의 라벨과 동일한 GitHub Label을 추가합니다.
  - 예: PR 제목이 `[enhancement/github-repo] GitHub 저장소 연결`이면 `enhancement` 라벨을 추가합니다.
  - PR 제목의 라벨이 GitHub Label과 정확히 일치하지 않으면, 기존 Label 목록에서 의미가 같은 라벨을 확인해 사용합니다.

---

## 출력 형식

프로젝트의 `.github/pull_request_template.md`를 사용합니다.

Pull Request 제목은 연결된 GitHub Issue 제목과 동일하게 작성합니다.

별도의 템플릿을 생성하거나 Skill의 `assets`에 중복 저장하지 않습니다.

---

## 품질 기준

PR을 작성하기 전에 아래 내용을 확인합니다.

- 관련 Issue의 Why와 Goal이 PR에 반영되었는가?
- 구현 방식의 선택 이유가 설명되어 있는가?
- 실제 Git diff에 없는 내용을 작성하지 않았는가?
- 기존 기능에 미치는 영향이 정리되었는가?
- 한계와 트레이드오프가 있다면 명시했는가?
- Review Points와 Validation이 실제 구현 내용과 일치하는가?

