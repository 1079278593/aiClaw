@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title hyxClaw
echo ========================================
echo   hyxClaw
echo ========================================
echo.

REM 若改过 config.json 中的端口，请同步修改这里
set "OPEN_URL=http://127.0.0.1:3000"

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node.js 22.16.0 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [错误] 未找到 .env 文件。
  echo 请在本目录创建 .env，并设置数据目录，例如：
  echo   HYXCLAW_DATA_DIR=D:\MyData
  echo 可参考 .env.example。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 依赖未安装，正在执行 pnpm install ...
  call :require_pnpm
  if errorlevel 1 exit /b 1
  call pnpm install
  if errorlevel 1 (
    echo [错误] pnpm install 失败。
    echo.
    pause
    exit /b 1
  )
  echo.
)

if not exist "dist\cli\index.js" (
  echo 未找到编译产物，正在构建 ...
  call :require_pnpm
  if errorlevel 1 exit /b 1
  call pnpm build
  if errorlevel 1 (
    echo [错误] 构建失败。
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo 启动后将打开 %OPEN_URL%
echo 关闭本窗口或按 Ctrl+C 可停止服务。
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start %OPEN_URL%"
node dist\cli\index.js start
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo 服务已退出，退出码：%EXITCODE%
)
pause
exit /b %EXITCODE%

:require_pnpm
where pnpm >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 pnpm。请先安装：npm install -g pnpm
  echo.
  pause
  exit /b 1
)
exit /b 0
