@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   二手转卖工作台 - 本机桥接服务 (local bridge)
echo   在浏览器打开工作台 -> 审核通过 -> 真·一键发布
echo ============================================================
where node >nul 2>nul || (echo [错误] 没找到 Node.js，请先安装 https://nodejs.org 并重启终端 & pause & exit /b)

IF NOT EXIST node_modules\playwright (
  echo [安装] 首次运行，安装 playwright（可能要一两分钟）...
  call npm install
  IF ERRORLEVEL 1 (echo [错误] 依赖安装失败，检查网络后重试 & pause & exit /b)
)

echo [启动] 桥接服务: http://127.0.0.1:8891
echo [提示] 保持此窗口打开；关闭窗口即停止服务。
echo [提示] 首次发 FB/Karrot/小红书前，先在工作台"设置-桥接"里点"登录"按钮手动登一次。
echo.
node server.js
echo.
echo [已停止] 按任意键退出。
pause
