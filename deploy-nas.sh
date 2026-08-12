#!/bin/zsh
# class-points NAS 部署脚本：本地 server/ -> NAS /vol1/1000/class-points，compose 重建
set -e
NAS="admin@100.71.254.113"
REMOTE="/vol1/1000/class-points"
export SSHPASS="$($HOME/.local/bin/agent-secret get NAS_ADMIN_PASSWORD)"

echo "== 1/4 同步代码到 NAS: $REMOTE"
sshpass -e ssh "$NAS" "mkdir -p $REMOTE/data"
sshpass -e scp -r server/src server/package.json server/package-lock.json server/Dockerfile docker-compose.yml "$NAS:$REMOTE/"

echo "== 2/4 准备 .env（本地无则从 NAS 旧值保留）"
sshpass -e ssh "$NAS" "test -f $REMOTE/.env || echo 'PIN_CODE=1984' > $REMOTE/.env"

echo "== 3/4 重建容器"
sshpass -e ssh "$NAS" "cd $REMOTE && docker compose up -d --build"

echo "== 4/4 健康检查"
sleep 3
sshpass -e ssh "$NAS" "curl -s -m 5 http://127.0.0.1:8780/api/health"
echo
echo "部署完成。SSE 端点: http://192.168.8.112:8780/api/events/stream"