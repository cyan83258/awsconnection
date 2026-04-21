param(
    [string]$SillyTavernRoot
)

$ErrorActionPreference = 'Stop'

$extensionDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledPluginDir = Join-Path $extensionDir 'server-plugin\aws-bedrock-bridge'

if (-not (Test-Path -LiteralPath $bundledPluginDir)) {
    throw "번들된 서버 플러그인 폴더를 찾지 못했습니다: $bundledPluginDir"
}

if (-not $SillyTavernRoot) {
    $SillyTavernRoot = (Resolve-Path (Join-Path $extensionDir '..\..\..\..')).Path
}

$pluginsDir = Join-Path $SillyTavernRoot 'plugins'
$destinationDir = Join-Path $pluginsDir 'aws-bedrock-bridge'

if (-not (Test-Path -LiteralPath $pluginsDir)) {
    throw "SillyTavern plugins 폴더를 찾지 못했습니다: $pluginsDir"
}

Write-Host "Bundled plugin source: $bundledPluginDir"
Write-Host "Install destination: $destinationDir"

New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
Copy-Item -Path (Join-Path $bundledPluginDir '*') -Destination $destinationDir -Recurse -Force

Push-Location $destinationDir
try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm 명령을 찾지 못했습니다. Node.js 설치 후 다시 실행하세요.'
    }

    Write-Host 'Installing plugin dependencies with npm install...'
    npm install
} finally {
    Pop-Location
}

Write-Host 'aws-bedrock-bridge 서버 플러그인 설치가 끝났습니다. SillyTavern을 재시작하세요.'