#!/usr/bin/env bash
# app LXC 에서 이미지 빌드. --save 를 주면 다른 LXC 로 옮길 tar.gz 도 만든다.
#
#   infra/scripts/build.sh            # 빌드만
#   infra/scripts/build.sh --save     # 빌드 + infra/dist/news-web.tar.gz
#
# 옮기기:  scp infra/dist/news-web.tar.gz <app>:/tmp && ssh <app> 'gunzip -c /tmp/news-web.tar.gz | docker load'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/infra/compose"

docker compose build

if [ "${1:-}" = "--save" ]; then
  mkdir -p ../dist
  docker save news-web:local | gzip -1 > ../dist/news-web.tar.gz
  echo "저장: infra/dist/news-web.tar.gz ($(du -h ../dist/news-web.tar.gz | cut -f1))"
  echo "로드: gunzip -c news-web.tar.gz | docker load"
fi
