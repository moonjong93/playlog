# news

게임 업계 뉴스 수집 → 작성 → 공개 파이프라인.

```
collector (15분)                writer (3시간)                 web
RSS/Reddit 수집 + 노이즈 + 임베딩 → 사건 묶기 + RAG + 한글 기사 → 공개(읽기) + 발행 API
collector/data/news.db          같은 DB                          data/news-web/web.db
```

- 읽기는 전부 공개, 발행(`/internal/*`)만 Bearer 키. 각 프로젝트의 README 가 상세를 다룬다.
- 작성(LLM)은 OpenRouter 를 쓰고, 로컬 모델은 임베딩/판정용으로만 쓴다.

## 로컬 개발

```bash
# env: 각 프로젝트에 하나씩 두거나, 루트 .env 하나로 공통값을 채운다
cp .env.example .env

cd collector && uv sync && uv run collector run --once    # 수집→필터→임베딩
cd writer    && uv sync && uv run writer run --once       # 묶기→기사→웹 발행
cd web       && npm ci && npm start                        # http://127.0.0.1:8787
```

## 배포 (app LXC)

```bash
apt-get update && apt-get install -y docker.io docker-compose-v2 git sqlite3
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone <repo> ~/playlog && cd ~/playlog

cp .env.example .env && vi .env      # 키/토큰 채우기 (Cloudflare 터널 토큰 포함)
mkdir -p data/news-web && chown 1000:1000 data/news-web

docker compose up -d --build          # web + cloudflared (127.0.0.1:8787 loopback)

# 상시 수집/발행
cp collector/systemd/collector-run.service writer/systemd/writer-run.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now collector-run.service writer-run.service
loginctl enable-linger "$USER"

# 최초 1회 DB 준비
(cd collector && uv sync && uv run collector init-db && uv run collector sources sync)
(cd writer    && uv sync && uv run writer init-db)
```

- Cloudflare 대시보드에서 터널 public hostname 을 `news.nevra.app → http://news-web:8787` 로 등록한다.
- 포트: 공개 `WEB_PORT`(기본 8787)는 loopback 만, collector/writer 는 포트 없음.
- DB 백업은 WAL 때문에 `sqlite3 <db> ".backup <파일>"` 로 뜬다(파일 복사 금지).
