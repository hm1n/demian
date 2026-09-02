# SessionStart 훅. 세션 시작 시점의 HEAD와 llm-wiki/raw 파일 목록을 기록한다.
# 이후 UserPromptSubmit 훅이 이 기준선과 비교해 새 세션 로그가 생겼는지 판정한다.
$ErrorActionPreference = 'SilentlyContinue'

$stdin = [Console]::In.ReadToEnd()
try { $payload = $stdin | ConvertFrom-Json } catch { $payload = $null }

$sessionId = if ($payload -and $payload.session_id) { $payload.session_id } else { 'default' }
$cwd = if ($payload -and $payload.cwd) { $payload.cwd } else { (Get-Location).Path }

$rawDir = Join-Path $cwd 'llm-wiki\raw'
if (-not (Test-Path -LiteralPath $rawDir)) { exit 0 }

$head = & git -C $cwd rev-parse HEAD 2>$null
$files = @(Get-ChildItem -LiteralPath $rawDir -Filter '*.md' -File | Select-Object -ExpandProperty Name)

$stateDir = Join-Path $env:LOCALAPPDATA 'demian-raw-log-guard'
if (-not (Test-Path -LiteralPath $stateDir)) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}

$state = [ordered]@{
  sessionId = $sessionId
  cwd       = $cwd
  head      = "$head"
  rawFiles  = $files
  turns     = 0
  done      = $false
}

$statePath = Join-Path $stateDir ("$sessionId.json")
($state | ConvertTo-Json -Depth 4) | Out-File -FilePath $statePath -Encoding utf8
exit 0
