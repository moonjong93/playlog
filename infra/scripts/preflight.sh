#!/usr/bin/env bash
# app LXC 배포 전 점검. 실패 항목이 있으면 exit 1.
#
#   infra/scripts/preflight.sh
#
# 확인: docker/compose, 빌드 컨텍스트, env 파일, 시크릿 일치, cloudflared,
#       볼륨 권한, 포트 점유, 리포 상태.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
FAIL=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

echo "== 도구 =="
command -v docker >/dev/null && ok "docker $(docker --version 2>/dev/null | awk '{print $3}')" || bad "docker 없음"
docker compose version >/dev/null 2>&1 && ok "docker compose $(docker compose version --short 2>/dev/null)" || bad "docker compose 없음"

echo "== 빌드 컨텍스트 =="
[ -f web/Dockerfile ] && ok "web/Dockerfile" || bad "web/Dockerfile 없음"
[ -f infra/compose/docker-compose.yml ] && ok "compose 파일" || bad "compose 파일 없음"

echo "== env =="
[ -f infra/env/news-web.env ] && ok "infra/env/news-web.env" || bad "infra/env/news-web.env 없음"
for f in collector/.env writer/.env; do
  [ -f "$f" ] && ok "$f" || bad "$f 없음 (app에는 collector/writer env도 필요)"
done
if [ -f infra/env/news-web.env ]; then
  ref=""
  if [ -f infra/env/writer.env ]; then ref="infra/env/writer.env"; elif [ -f writer/.env ]; then ref="writer/.env"; fi
  if [ -n "$ref" ]; then
    a=$(awk -F= '/^WEB_API_KEY=/{print $2}' infra/env/news-web.env | tr -d '"')
    b=$(awk -F= '/^WEB_API_KEY=/{print $2}' "$ref" | tr -d '"')
    [ -n "$a" ] && [ "$a" = "$b" ] && ok "WEB_API_KEY 일치 ($ref)" || bad "WEB_API_KEY 불일치($ref) — 발행이 401"
  fi
fi
if grep -q '^OPENROUTER_API_KEY=..*' writer/.env 2>/dev/null; then ok "OpenRouter 키 있음"; else bad "writer/.env OPENROUTER_API_KEY 없음"; fi

echo "== cloudflared =="
[ -f infra/cloudflared/config.yml ] && ok "config.yml" || bad "config.yml 없음 (예시 복사 필요)"
ls infra/cloudflared/*.json >/dev/null 2>&1 && ok "터널 자격증명 json" || bad "터널 자격증명 json 없음"
grep -q 'REPLACE-WITH-TUNNEL-ID' infra/cloudflared/config.yml 2>/dev/null && bad "config.yml 의 tunnel ID 미교체"

echo "== 볼륨 =="
if [ -d infra/compose/data/news-web ]; then
  owner=$(stat -c '%u' infra/compose/data/news-web)
  [ "$owner" = "1000" ] && ok "news-web 볼륨 소유자 1000" || bad "news-web 볼륨 소유자 $owner → sudo chown -R 1000:1000"
else
  warn "infra/compose/data/news-web 없음 → mkdir -p + chown 1000:1000 필요"
fi

echo "== 포트 =="
ss -tln 2>/dev/null | grep -q ':8787 ' && warn "8787 이미 점유 중 (기존 web 프로세스 확인)" || ok "8787 비어 있음"

echo "== 리포 =="
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then warn "미커밋 변경 있음 — app 클론에는 반영 안 됨"; else ok "작업 트리 깨끗"; fi

echo
[ "$FAIL" = 0 ] && echo "점검 통과 — 배포 가능" || echo "점검 실패 — 위 FAIL 항목 먼저"
exit "$FAIL"
