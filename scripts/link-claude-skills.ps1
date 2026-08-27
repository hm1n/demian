# .claude/skills를 .agents/skills로 잇는 정션을 만든다.
#
# 왜 필요한가
#   .claude/skills는 .gitignore에 있어서 새 워크트리에는 생기지 않는다.
#   그러면 Claude Code가 프로젝트 스킬을 보지 못한다. Codex는 .agents/skills를 직접 읽으므로 영향이 없다.
#   git에 심볼릭 링크를 커밋하는 방법은 쓰지 않는다. Windows에서 체크아웃이 실패하면
#   링크가 아니라 경로 문자열이 든 일반 파일로 떨어진다. CLAUDE.md가 그렇게 깨져 있었다.
#
# 어디서 실행되는가
#   Orca 저장소 설정의 워크트리 셋업 스크립트에서 부른다. 셋업은 에이전트가 시작되기 전에 돌기 때문에
#   스킬 목록이 로드되는 시점에 정션이 이미 존재한다.
#
# 정션(mklink /J)을 쓰는 이유
#   Windows에서 심볼릭 링크는 개발자 모드나 관리자 권한이 필요하지만 정션은 필요하지 않다.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot '.agents\skills'
$claudeDir = Join-Path $repoRoot '.claude'
$target = Join-Path $claudeDir 'skills'

if (-not (Test-Path -LiteralPath $source)) {
  Write-Output "link-claude-skills: .agents/skills가 없어 건너뜁니다."
  exit 0
}

if (-not (Test-Path -LiteralPath $claudeDir)) {
  New-Item -ItemType Directory -Path $claudeDir | Out-Null
  Write-Output "link-claude-skills: .claude 디렉터리를 만들었습니다."
}

if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.PSIsContainer) {
    Write-Output "link-claude-skills: .claude/skills가 이미 있어 그대로 둡니다."
    exit 0
  }
  # 일반 파일이면 깨진 체크아웃이다. 지우지 않고 알린다.
  Write-Output "link-claude-skills: .claude/skills가 디렉터리가 아닌 파일입니다. 손대지 않았습니다. 직접 확인하세요."
  exit 0
}

& cmd.exe /c mklink /J "$target" "$source" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output "link-claude-skills: 정션 생성이 실패했습니다. exit=$LASTEXITCODE"
  exit 1
}

Write-Output "link-claude-skills: .claude/skills -> .agents/skills 정션을 만들었습니다."
exit 0
