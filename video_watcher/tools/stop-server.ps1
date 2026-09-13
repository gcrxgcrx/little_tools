#requires -Version 5.1
<#
.SYNOPSIS
    停止正在运行的观影室服务。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\stop-server.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\server.pid'

$stopped = $false

if (Test-Path $PidFile) {
    $pidText = (Get-Content $PidFile -Raw).Trim()
    $target = 0
    if ([int]::TryParse($pidText, [ref]$target) -and $target -gt 0) {
        $proc = Get-Process -Id $target -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $target -Force
            Write-Host "✅ 已停止服务（PID $target）" -ForegroundColor Green
            $stopped = $true
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
    # pid 文件缺失或进程已不在，退化为按命令行匹配
    $candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*src\server.js*' -or $_.CommandLine -like '*src/server.js*' }

    if ($candidates) {
        foreach ($c in $candidates) {
            Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "✅ 已停止服务（PID $($c.ProcessId)）" -ForegroundColor Green
            $stopped = $true
        }
    }
}

if (-not $stopped) {
    Write-Host '服务当前没有在运行。' -ForegroundColor Yellow
}
