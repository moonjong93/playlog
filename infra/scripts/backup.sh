#!/usr/bin/env bash
# SQLite 백업. app LXC 에서 실행한다(dev/ai 에서는 쓰지 않는다).
#
#   infra/scripts/backup.sh /var/backups/infra
#
# WAL 파일을 그냥 복사하면 깨질 수 있어 sqlite3 .backup 을 쓴다.
# 모델 캐시(HF 등)는 백업하지 않는다 — 다시 받으면 된다.
set -euo pipefail

DEST="${1:-/var/backups/infra}"
STAMP="$(date +%F-%H%M)"
KEEP_DAYS=7

# 여기에 백업할 DB 를 추가한다(호스트 절대경로).
DBS=(
  "$HOME/playlog/collector/data/news.db"
  "$HOME/playlog/infra/compose/data/news-web/web.db"
)

command -v sqlite3 >/dev/null || { echo "sqlite3 필요: apt-get install -y sqlite3" >&2; exit 1; }
mkdir -p "$DEST"

for db in "${DBS[@]}"; do
  if [ ! -f "$db" ]; then
    echo "건너뜀(없음): $db"
    continue
  fi
  name="$(basename "$(dirname "$db")")-$(basename "$db")"
  out="$DEST/${STAMP}-${name}"
  sqlite3 "file:${db}?mode=ro" ".backup '${out}'" 2>/dev/null \
    || sqlite3 "$db" ".backup '${out}'"
  gzip -f "$out"
  echo "백업: ${out}.gz"
done

find "$DEST" -name '*.gz' -mtime "+${KEEP_DAYS}" -delete
