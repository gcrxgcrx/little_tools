#requires -Version 5.1
<#
.SYNOPSIS
    观影室的防睡眠设置。

.DESCRIPTION
    这台电脑要一直开着当片库服务器，屏幕可以关，但系统不能休眠 ——
    一旦休眠，正在看片的一方会直接断流。

    这是本方案唯一真实存在的持续成本（电费）之外最容易被忽略的运维点。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\prevent-sleep.ps1
    powershell -ExecutionPolicy Bypass -File tools\prevent-sleep.ps1 -Enable
    powershell -ExecutionPolicy Bypass -File tools\prevent-sleep.ps1 -Disable
#>

[CmdletBinding()]
param(
    [switch]$Enable,
    [switch]$Disable
)

function Get-PowerTimeouts {
    $raw = powercfg /query SCHEME_CURRENT SUB_SLEEP 2>$null
    $result = [ordered]@{}

    $current = $null
    foreach ($line in $raw) {
        if ($line -match '电源设置索引|Power Setting Index|GUID 别名|GUID Alias') {
            if ($line -match '([0-9a-fA-F-]{36})') { $current = $Matches[1] }
        }
        if ($current -and $line -match '当前交流电源设置索引:\s*(0x[0-9a-fA-F]+)|Current AC Power Setting Index:\s*(0x[0-9a-fA-F]+)') {
            $hex = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
            $result[$current] = [Convert]::ToInt32($hex, 16)
            $current = $null
        }
    }
    return $result
}

function Show-Status {
    Write-Host '当前电源设置（交流电）:' -ForegroundColor Cyan
    $standby = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null | Select-String '当前交流电源设置索引|Current AC Power Setting Index') -join ''
    $hibernate = (powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 2>$null | Select-String '当前交流电源设置索引|Current AC Power Setting Index') -join ''
    $disk = (powercfg /query SCHEME_CURRENT SUB_DISK DISKIDLE 2>$null | Select-String '当前交流电源设置索引|Current AC Power Setting Index') -join ''

    foreach ($pair in @(@('系统睡眠 standby', $standby), @('休眠 hibernate', $hibernate), @('硬盘 disk', $disk))) {
        $label = $pair[0]
        $line = $pair[1]
        if ($line -match '(0x[0-9a-fA-F]+)') {
            $seconds = [Convert]::ToInt32($Matches[1], 16)
            $human = if ($seconds -eq 0) { '永不（已关闭）' } else { "$([math]::Round($seconds / 60, 1)) 分钟" }
            $color = if ($seconds -eq 0) { 'Green' } else { 'Yellow' }
            Write-Host ("  {0,-20} {1}" -f $label, $human) -ForegroundColor $color
        } else {
            Write-Host ("  {0,-20} 读取失败" -f $label) -ForegroundColor DarkGray
        }
    }
    Write-Host ''
    Write-Host '说明：屏幕关闭（显示器超时）不影响服务，无需修改。' -ForegroundColor DarkGray
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host '=== 观影室 · 防睡眠设置 ===' -ForegroundColor Cyan
Write-Host ''

if (-not $Enable -and -not $Disable) {
    Show-Status
    Write-Host ''
    Write-Host '要关闭休眠（让电脑能一直当服务器），运行：' -ForegroundColor White
    Write-Host '  powershell -ExecutionPolicy Bypass -File tools\prevent-sleep.ps1 -Enable' -ForegroundColor Gray
    Write-Host '要恢复默认，运行：' -ForegroundColor White
    Write-Host '  powershell -ExecutionPolicy Bypass -File tools\prevent-sleep.ps1 -Disable' -ForegroundColor Gray
    exit 0
}

if (-not $isAdmin) {
    Write-Host '[需要管理员权限] powercfg 修改电源方案通常需要管理员。' -ForegroundColor Red
    Write-Host '请右键点击「Windows 终端(管理员)」或「PowerShell(管理员)」再运行本脚本。' -ForegroundColor Yellow
    exit 1
}

if ($Enable) {
    powercfg /change standby-timeout-ac 0 | Out-Null
    powercfg /change hibernate-timeout-ac 0 | Out-Null
    powercfg /change disk-timeout-ac 0 | Out-Null
    Write-Host '✅ 已关闭系统睡眠 / 休眠 / 硬盘休眠（仅交流电，笔记本用电池时不受影响）' -ForegroundColor Green
} else {
    powercfg /change standby-timeout-ac 30 | Out-Null
    powercfg /change hibernate-timeout-ac 60 | Out-Null
    powercfg /change disk-timeout-ac 20 | Out-Null
    Write-Host '已恢复默认（睡眠 30 分钟 / 休眠 60 分钟 / 硬盘 20 分钟）' -ForegroundColor Green
}

Write-Host ''
Show-Status
