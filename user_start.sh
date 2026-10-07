#!/bin/bash
# dragon 启动脚本：以后台方式启动段落式写作服务
cd "$(dirname "$0")"
mkdir -p logs paragraphs
nohup node server.js >> logs/start.log 2>&1 &
echo "dragon started, pid $!"
