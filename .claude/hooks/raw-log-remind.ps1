# UserPromptSubmit 훅. 이 세션에 변경이 있는데 llm-wiki/raw/에 새 세션 로그가 없으면
# 한 줄을 컨텍스트에 붙인다. 차단하지 않는다.
#
# 판정하지 않는 것: 세션 로그를 몇 개로 나눌지. 주제 분할은 에이전트가 제안하고 사용자가 승인한다.
$ErrorActionPreference = 'SilentlyContinue'
# Claude Code는 훅 stdout을 UTF-8로 읽는다. 기본 ANSI 코드페이지로 내보내면 한글이 깨진다.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

$stdin = [Console]::In.ReadToEnd()
try { $payload = $stdin | ConvertFrom-Json } catch { $payload = $null }

$sessionId = if ($payload -and $payload.session_id) { $payload.session_id } else { 'default' }
$cwd = if ($payload -and $payload.cwd) { $payload.cwd } else { (Get-Location).Path }

$rawDir = Join-Path $cwd 'llm-wiki\raw'
if (-not (Test-Path -LiteralPath $rawDir)) { exit 0 }

$stateDir = Join-Path $env:LOCALAPPDATA 'demian-raw-log-guard'
$statePath = Join-Path $stateDir ("$sessionId.json")

# 기준선이 없으면 이 세션은 훅 설치 전에 시작된 것이다. 지금을 기준선으로 잡고 넘어간다.
if (-not (Test-Path -LiteralPath $statePath)) {
  if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  }
  $head = & git -C $cwd rev-parse HEAD 2>$null
  $files = @(Get-ChildItem -LiteralPath $rawDir -Filter '*.md' -File | Select-Object -ExpandProperty Name)
  $fresh = [ordered]@{
    sessionId = $sessionId; cwd = $cwd; head = "$head"
    rawFiles = $files; turns = 0; done = $false
  }
  ($fresh | ConvertTo-Json -Depth 4) | Out-File -FilePath $statePath -Encoding utf8
  exit 0
}

try { $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json } catch { exit 0 }
if ($state.done -eq $true) { exit 0 }

$state.turns = [int]$state.turns + 1

# 새 세션 로그가 생겼으면 이 세션에서는 더 알리지 않는다.
$baseline = @($state.rawFiles)
$current = @(Get-ChildItem -LiteralPath $rawDir -Filter '*.md' -File | Select-Object -ExpandProperty Name)
$added = @($current | Where-Object { $baseline -notcontains $_ })
if ($added.Count -gt 0) {
  $state.done = $true
  ($state | ConvertTo-Json -Depth 4) | Out-File -FilePath $statePath -Encoding utf8
  exit 0
}

# 짧은 세션은 알리지 않는다.
if ([int]$state.turns -lt 3) {
  ($state | ConvertTo-Json -Depth 4) | Out-File -FilePath $statePath -Encoding utf8
  exit 0
}

# 이 세션에 변경이 있었는지 본다. 커밋이 이미 됐어도 HEAD 이동으로 잡힌다.
$headNow = "$(& git -C $cwd rev-parse HEAD 2>$null)"
$dirty = @(& git -C $cwd status --porcelain 2>$null)
$changed = ($headNow -ne "$($state.head)") -or ($dirty.Count -gt 0)

($state | ConvertTo-Json -Depth 4) | Out-File -FilePath $statePath -Encoding utf8

if (-not $changed) { exit 0 }

Write-Output 'llm-wiki 규칙 확인: 이 세션에 변경이 있으나 llm-wiki/raw/에 새 세션 로그가 없습니다. 다루던 주제가 마무리되는 시점에, 세션 로그를 몇 개로 나눌지 한 줄로 제안하고 사용자 승인을 받은 뒤 raw/{YYYY-MM-DD}-{주제}-session-log.md로 쓰고 log.md에 남기세요. 결정과 정정과 실측이 없었던 세션이면 이 안내를 무시하세요.'
exit 0
