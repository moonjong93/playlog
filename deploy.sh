#!/usr/bin/env bash
# app LXC 에서 코드를 갱신하고 재배포한다.
#
#   cd ~/playlog && ./deploy.sh
#
# - news-web: 이미지 재빌드 후 재기동 (cloudflared/DB/시크릿은 건드리지 않음)
# - collector/writer: 의존성 동기화 후 systemd --user 재시작
#
# 부분 배포는 README 의 "개발 → 배포 흐름" 참고.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

echo "== 코드 갱신 =="
git pull --ff-only
git log --oneline -1

echo "== news-web 빌드/기동 =="
docker compose up -d --build news-web

echo "== collector/writer 의존성 =="
(cd collector && uv sync -q)
(cd writer && uv sync -q)

echo "== 서비스 재시작 =="
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if systemctl --user is-enabled collector-run.service >/dev/null 2>&1; then
  systemctl --user restart collector-run.service writer-run.service
  systemctl --user is-active collector-run.service writer-run.service
else
  echo "(systemd --user 유닛 미설치 — 건너뜀)"
fi

echo "== 상태 =="
docker compose ps
