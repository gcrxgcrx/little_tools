#requires -Version 5.1
<#
.SYNOPSIS
    修改观影室的访问码（PIN），并重启服务让它生效。

.DESCRIPTION
    访问码存在 config.json 的 pin 字段里，由服务在启动时读取，
    所以改完必须重启服务。

    注意：会话令牌保存在服务进程内存中，重启后所有设备都需要用新访问码重新进入。

.EXAMPLE
    # 指定一个访问码
    powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Pin 826413

    # 随机生成一个 6 位访问码
    powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Random

    # 只改配置，不重启（下次启动才生效）
    powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Pin 826413 -NoRestart

    # 查看当前访问码
    powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Show
#>

[CmdletBinding(DefaultParameterSetName = 'Set')]
param(
    [Parameter(ParameterSetName = 'Set')]
    [ValidatePattern('^\d{4,12}$')]
    [string]$Pin,

    [Parameter(ParameterSetName = 'Set')]
    [switch]$Random,

    [Parameter(ParameterSetName = 'Show')]
    [switch]$Show,

    [switch]$NoRestart
)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'config.json'
$StopScript = Join-Path $PSScriptRoot 'stop-server.ps1'
$StartVbs = Join-Path $PSScriptRoot 'start-hidden.vbs'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-ConfigText {
    # 用 .NET 直接读写，避免 PowerShell 5.1 的 Set-Content 写出 BOM
    # （带 BOM 的 JSON 会让服务端 JSON.parse 直接抛异常）
    return [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
}

function Get-CurrentPin {
    $text = Read-ConfigText
    if ($text -match '"pin"\s*:\s*"([^"]*)"') { return $Matches[1] }
    return ''
}

function Set-PinValue {
    param([string]$NewPin)

    $text = Read-ConfigText
    if ($text -notmatch '"pin"\s*:\s*"[^"]*"') {
        throw 'config.json 里找不到 pin 字段'
    }

    $updated = [regex]::Replace($text, '("pin"\s*:\s*")[^"]*(")', { param($m) $m.Groups[1].Value + $NewPin + $m.Groups[2].Value }, 1)
    [System.IO.File]::WriteAllText($ConfigPath, $updated, $utf8NoBom)
}

Write-Host '=== 观影室 · 访问码 ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $ConfigPath)) {
    Write-Host "找不到配置文件: $ConfigPath" -ForegroundColor Red
    exit 1
}

if ($Show -or (-not $Pin -and -not $Random)) {
    $current = Get-CurrentPin
    if ($current) {
        Write-Host "当前访问码：$current" -ForegroundColor Green
    } else {
        Write-Host '当前访问码为空（服务下次启动时会自动生成一个新的）' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '修改方式：' -ForegroundColor White
    Write-Host '  powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Pin 826413'
    Write-Host '  powershell -ExecutionPolicy Bypass -File tools\set-pin.ps1 -Random'
    exit 0
}

$newPin = if ($Random) { (Get-Random -Minimum 100000 -Maximum 999999).ToString() } else { $Pin }
$oldPin = Get-CurrentPin

Set-PinValue -NewPin $newPin

# 校验写出来的还是合法 JSON，避免手滑把配置写坏
$check = node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('ok')" $ConfigPath 2>&1
if ($check -notmatch 'ok') {
    Write-Host '❌ 写入后的 config.json 不是合法 JSON，正在回滚' -ForegroundColor Red
    Set-PinValue -NewPin $oldPin
    Write-Host "   $check" -ForegroundColor DarkGray
    exit 1
}

Write-Host "✅ 访问码已更新：$oldPin → $newPin" -ForegroundColor Green

if ($NoRestart) {
    Write-Host ''
    Write-Host '已跳过重启，新访问码会在下次启动服务时生效。' -ForegroundColor Yellow
    exit 0
}

Write-Host ''
Write-Host '正在重启服务让新访问码生效…' -ForegroundColor Cyan

if (Test-Path $StopScript) {
    & powershell -ExecutionPolicy Bypass -File $StopScript | ForEach-Object { "  $_" }
    Start-Sleep -Seconds 2
}

& wscript.exe $StartVbs
Start-Sleep -Seconds 4

$healthy = $false
try {
    $res = Invoke-RestMethod 'http://127.0.0.1:8080/api/health' -TimeoutSec 5
    $healthy = [bool]$res.ok
} catch {
    $healthy = $false
}

if ($healthy) {
    Write-Host '✅ 服务已重启' -ForegroundColor Green
    Write-Host ''
    Write-Host "新访问码：$newPin" -ForegroundColor Green
    Write-Host '所有设备都需要重新输入这个访问码。' -ForegroundColor Yellow
} else {
    Write-Host '⚠️ 服务重启后没有响应，请检查 data\server.log' -ForegroundColor Red
    $log = Join-Path $ProjectRoot 'data\server.log'
    if (Test-Path $log) {
        Write-Host '日志末尾：' -ForegroundColor DarkGray
        Get-Content $log -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    exit 1
}
