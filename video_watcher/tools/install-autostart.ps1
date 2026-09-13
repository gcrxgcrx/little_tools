#requires -Version 5.1
<#
.SYNOPSIS
    把观影室注册成开机自启（或查看 / 移除）。

.DESCRIPTION
    默认用「登录时启动」：不需要管理员权限，你登录 Windows 后延迟 20 秒自动拉起，
    完全后台运行，日志写到 data\server.log。

    如果这台电脑会在没人登录的情况下重启（比如半夜自动更新），
    登录触发就不会执行。那种场景需要「开机即启动」模式，用 -Mode Boot，
    它把任务注册为 SYSTEM 运行、无需登录，但需要管理员权限。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Mode Boot
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Status
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove
#>

[CmdletBinding()]
param(
    [ValidateSet('Logon', 'Boot')]
    [string]$Mode = 'Logon',
    [switch]$Status,
    [switch]$Remove
)

$TaskName = 'VideoWatcher'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$LogFile = Join-Path $ProjectRoot 'data\server.log'
$PidFile = Join-Path $ProjectRoot 'data\server.pid'

<#
    schtasks 在"任务不存在"时会往 stderr 写东西并返回非 0。
    在 $ErrorActionPreference='Stop' 下这会被当成终止性错误抛出，
    所以这里临时切回 Continue 并显式取回退出码。
#>
function Invoke-Schtasks {
    param([string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & schtasks @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{
        Code   = $code
        Output = @($output | ForEach-Object { "$_" })
    }
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

function Get-RegisteredTask {
    return Invoke-Schtasks -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST', '/V')
}

function Show-Task {
    $result = Get-RegisteredTask
    if ($result.Code -ne 0) {
        Write-Host '开机自启：未注册' -ForegroundColor Yellow
        return $false
    }

    Write-Host '开机自启：已注册' -ForegroundColor Green
    $patterns = 'TaskName|Status|Logon Mode|Next Run Time|Schedule Type|Task To Run|Run As User|任务名|状态|登录模式|下次运行时间|计划类型|要运行的任务|以用户身份运行'
    foreach ($line in $result.Output) {
        if ($line -match $patterns) { Write-Host "  $($line.Trim())" }
    }
    return $true
}

function Show-Process {
    Write-Host ''

    $running = @()

    if (Test-Path $PidFile) {
        $pidText = (Get-Content $PidFile -Raw).Trim()
        $target = 0
        if ([int]::TryParse($pidText, [ref]$target) -and $target -gt 0) {
            if (Get-Process -Id $target -ErrorAction SilentlyContinue) {
                $running += $target
            }
        }
    }

    # pid 文件不可信时，按"命令行同时包含本项目路径和 src\server.js"精确匹配
    $serverPath = Join-Path $ProjectRoot 'src\server.js'
    $candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) }
    foreach ($c in $candidates) {
        if ($running -notcontains $c.ProcessId) { $running += $c.ProcessId }
    }

    if ($running.Count -gt 0) {
        Write-Host "服务状态：正在运行（PID $($running -join ', ')）" -ForegroundColor Green
    } else {
        Write-Host '服务状态：未在运行' -ForegroundColor Yellow
        Write-Host '  立刻启动：双击 tools\start.bat，或运行 tools\start-hidden.vbs' -ForegroundColor DarkGray
    }
}

Write-Host '=== 观影室 · 开机自启 ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $Vbs)) {
    Write-Host "找不到启动脚本: $Vbs" -ForegroundColor Red
    exit 1
}

if ($Status) {
    Show-Task | Out-Null
    Show-Process
    exit 0
}

if ($Remove) {
    $result = Invoke-Schtasks -Arguments @('/Delete', '/TN', $TaskName, '/F')
    if ($result.Code -eq 0) {
        Write-Host '✅ 已移除开机自启（正在运行的服务不受影响）' -ForegroundColor Green
    } else {
        Write-Host '本来就没有注册，无需移除' -ForegroundColor Yellow
    }
    Write-Host ''
    Show-Process
    exit 0
}

$action = "wscript.exe `"$Vbs`""

if ($Mode -eq 'Boot') {
    if (-not (Test-Admin)) {
        Write-Host '[需要管理员权限] 开机即启动模式要把任务注册成 SYSTEM 运行。' -ForegroundColor Red
        Write-Host '请用管理员身份的 PowerShell 重新运行本脚本。' -ForegroundColor Yellow
        exit 1
    }
    $result = Invoke-Schtasks -Arguments @(
        '/Create', '/TN', $TaskName, '/TR', $action, '/SC', 'ONSTART',
        '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/DELAY', '0000:20', '/F'
    )
    $describe = '开机即启动（无需登录，以 SYSTEM 运行）'
} else {
    $result = Invoke-Schtasks -Arguments @(
        '/Create', '/TN', $TaskName, '/TR', $action, '/SC', 'ONLOGON',
        '/DELAY', '0000:20', '/F'
    )
    $describe = '登录后自动启动（延迟 20 秒）'
}

if ($result.Code -eq 0) {
    Write-Host "✅ 已注册：$describe" -ForegroundColor Green
    Write-Host ''
    Write-Host '说明：' -ForegroundColor White
    Write-Host '  · 完全后台运行，没有控制台窗口'
    Write-Host "  · 日志写到 $LogFile"
    Write-Host '  · 想立刻启动一次：双击 tools\start.bat，或运行 tools\start-hidden.vbs'
    Write-Host '  · 想停掉：tools\stop-server.ps1'
    Write-Host '  · 想取消自启：本脚本加 -Remove'
    if ($Mode -eq 'Logon') {
        Write-Host ''
        Write-Host '注意：这个模式需要你登录 Windows 之后才会触发。' -ForegroundColor Yellow
        Write-Host '      如果电脑会在没人登录时重启，请改用 -Mode Boot（需管理员）。' -ForegroundColor Yellow
    }
} else {
    Write-Host '❌ 注册失败，输出如下：' -ForegroundColor Red
    $result.Output | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    Write-Host '可以试着用管理员身份的 PowerShell 再运行一次。' -ForegroundColor Yellow
    exit 1
}
