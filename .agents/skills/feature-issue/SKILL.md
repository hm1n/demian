---
name: feature-issue
description: 기능 정의서를 바탕으로 GitHub Feature Issue를 작성합니다.
---
# GitHub Feature Issue

기능 정의서를 GitHub Feature Issue로 변환합니다.

기능 정의서를 먼저 읽고 작업의 목적과 배경을 이해한 뒤 Issue를 작성합니다.

**Issue 제목을 작성하기 전에 `references/issue-title-convention.md`를 반드시 읽고 따릅니다.**

## 사용 시점

다음 상황에서 사용합니다.

- 기능 정의서에서 GitHub Issue를 생성할 때
- 새로운 기능 구현을 시작할 때
- 리팩토링 작업을 시작할 때

다음 상황에서는 사용하지 않습니다.

- Bug Issue 작성
- Pull Request 작성
- Commit Message 작성

---

## 작업 원칙

- 기능 정의서를 기반으로 GitHub Issue로 작성합니다.
- 하나의 GitHub Issue는 하나의 Pull Request로 구현 가능한 크기를 유지합니다.
- 기능 정의서의 목적과 배경을 충분히 이해한 후 Issue를 작성합니다.
- 기능 정의서에 없는 내용을 추측하여 작성하지 않습니다.
- 필요한 정보가 부족한 경우 `확인 필요`로 표시합니다.
- Issue는 다른 사람이 함께 보는 공유 문서이므로 본문은 존댓말(습니다체)로 작성합니다.

---

## GitHub 설정

Issue를 생성할 때 아래 설정을 함께 적용합니다.

- Assignee는 `hm1n`으로 고정합니다.
- 제목에는 GitHub Label에서 파생한 소문자 슬러그를 사용하고, Issue에는 원래 GitHub Label을 추가합니다.
  - 예: Issue 제목이 `[docs/llm-wiki] 인터뷰 설계 원칙 문서화`이면 `📃 Docs` Label을 추가합니다.
  - 슬러그와 Label의 매핑은 `references/issue-title-convention.md`에서 확인합니다.

---

## 출력 형식

이슈를 생성할 때는 `.github/ISSUE_TEMPLATE`에 있는 `feature_request.md`를 우선 사용합니다.
별도의 템플릿을 새로 만들거나 Skill의 assets에 중복 저장하지 않습니다.

---

## 품질 기준

Issue를 작성하기 전에 아래 내용을 확인합니다.

- 기능 정의서의 목적을 충분히 이해했는가?
- 하나의 Issue가 하나의 PR로 구현 가능한 적절한 크기인가?
- 기능 정의서에 없는 내용을 추측하지 않았는가?
- 제목에 이모지가 없고 라벨 슬러그와 도메인이 소문자인가?
- 제목의 라벨 슬러그가 실제 GitHub Label에서 유도된 값인가?

