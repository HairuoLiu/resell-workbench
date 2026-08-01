#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "============================================================"
echo "  二手转卖工作台 - 本机桥接服务 (local bridge)"
echo "============================================================"
command -v node >/dev/null 2>&1 || { echo "[错误] 没找到 Node.js，请先安装 https://nodejs.org"; exit 1; }

if [ ! -d node_modules/playwright ]; then
  echo "[安装] 首次运行，安装 playwright ..."
  npm install
fi

echo "[启动] 桥接服务: http://127.0.0.1:8891"
echo "[提示] 保持此终端打开；Ctrl+C 停止服务。"
echo "[提示] 首次发 FB/Karrot/小红书前，先在工作台'设置-桥接'里点'登录'按钮手动登一次。"
echo
node server.js
