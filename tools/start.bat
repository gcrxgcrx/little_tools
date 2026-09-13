@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo ============================================
echo   观影室 — 启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node 18 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] 首次运行，正在安装依赖...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [错误] 依赖安装失败。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已就绪
)

echo [2/2] 启动服务...
echo.
node src/server.js

echo.
echo 服务已退出。
pause
