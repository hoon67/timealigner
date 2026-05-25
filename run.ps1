# TimeAligner 자동 실행 스크립트
Set-Location $PSScriptRoot
$ErrorActionPreference = "Stop"

function Write-Step { param($msg) Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    [!]  $msg" -ForegroundColor Yellow }

# ── Docker 경로 ──────────────────────────────────────
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Step "Docker 감지 → docker-compose 실행"
    docker compose up --build
    exit $LASTEXITCODE
}

Write-Warn "Docker 없음. Python + Redis 경로로 진행"

# ── Python 확인 ──────────────────────────────────────
Write-Step "Python 확인"
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "Python 없음. 설치 중 (winget)..." -ForegroundColor Yellow
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-OK (python --version)

# ── Redis 확인 ───────────────────────────────────────
Write-Step "Redis 확인"
$redisOk = $false

# 1) 이미 실행 중?
try {
    $tcp = New-Object System.Net.Sockets.TcpClient("localhost", 6379)
    $tcp.Close()
    $redisOk = $true
    Write-OK "Redis 이미 실행 중 (port 6379)"
} catch {}

# 2) WSL에서 시작
if (-not $redisOk -and (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Warn "WSL로 Redis 시작 시도..."
    wsl bash -c "which redis-server > /dev/null 2>&1 || sudo apt-get install -y redis-server > /dev/null 2>&1; redis-server --daemonize yes --port 6379" 2>$null
    Start-Sleep 2
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient("localhost", 6379)
        $tcp.Close()
        $redisOk = $true
        Write-OK "Redis WSL에서 시작됨"
    } catch {}
}

# 3) Memurai (Windows용 Redis) winget
if (-not $redisOk) {
    Write-Warn "Redis 설치 시도 (Memurai)..."
    try {
        winget install -e --id Memurai.Memurai --accept-source-agreements --accept-package-agreements 2>$null
        Start-Sleep 3
        $tcp = New-Object System.Net.Sockets.TcpClient("localhost", 6379)
        $tcp.Close()
        $redisOk = $true
        Write-OK "Memurai 설치 및 시작됨"
    } catch {
        Write-Warn "Redis 자동 설치 실패"
    }
}

if (-not $redisOk) {
    Write-Host @"

Redis를 시작하지 못했습니다. 수동으로 하나 선택:

  A) Docker Desktop 설치 후 재실행:
     https://www.docker.com/products/docker-desktop/

  B) WSL 설치 후: wsl --install
     그 다음 WSL 터미널에서: sudo apt install redis-server && redis-server

스크립트 종료.
"@ -ForegroundColor Red
    exit 1
}

# ── Python 의존성 ─────────────────────────────────────
Write-Step "Python 패키지 설치"
Set-Location "$PSScriptRoot\backend"
python -m pip install -r requirements.txt --quiet
Write-OK "패키지 설치 완료"

# ── 서버 실행 ─────────────────────────────────────────
Write-Step "서버 시작 → http://localhost:8000"
Write-Host "    Ctrl+C 로 종료`n" -ForegroundColor Gray
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
