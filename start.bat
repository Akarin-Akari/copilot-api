@echo off
chcp 65001 >nul
title Copilot API Server

echo ========================================
echo   Copilot API Server
echo   Port: 8141
echo ========================================
echo.

REM 设置 GitHub Token（从环境变量读取，如果未设置则提示）
if "%GH_TOKEN%"=="" (
    echo [警告] 未设置 GH_TOKEN 环境变量
    echo 请设置环境变量: set GH_TOKEN=your_token_here
    echo 或创建 .env 文件（不会被提交到 git）
    pause
    exit /b 1
)

REM 检查依赖
if not exist node_modules (
    echo [信息] 安装依赖...
    "%USERPROFILE%\.bun\bin\bun.exe" install --ignore-scripts
    echo.
)

echo [信息] 启动 Copilot API 服务...
echo.
echo API 端点:
echo   OpenAI 兼容: http://127.0.0.1:8141/v1
echo   Anthropic 兼容: http://127.0.0.1:8141/v1/messages
echo.

"%USERPROFILE%\.bun\bin\bun.exe" run start --port 8141 --github-token %GH_TOKEN% --verbose

pause
