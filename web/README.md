# web

로컬 뉴스 리더. Hono + SQLite + Tailwind. 글 조회와 ingest는 모두 `WEB_API_KEY`가 필요합니다. `/health`만 키 없이 200을 줍니다.

## Run

```bash
cd web
cp .env.example .env   # WEB_API_KEY=dev-key, PORT=8787
npm install
npm run dev
```

브라우저: [http://127.0.0.1:8787/?key=dev-key](http://127.0.0.1:8787/?key=dev-key)

프로덕션식 기동은 `npm start`. DB 파일은 `data/web.db`.

## Ingest

```bash
curl -sS -X POST http://127.0.0.1:8787/internal/articles \
  -H 'Authorization: Bearer dev-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "sample-brief",
    "title_ko": "샘플 단신",
    "lede_ko": "로컬 스모크용 한 줄.",
    "body_html": "<p>본문입니다.</p>",
    "section": "테크",
    "published_at": "2026-09-19T12:00:00+09:00",
    "updated_at": "2026-09-19T12:00:00+09:00",
    "story_id": 1,
    "sources": [{"name": "Example", "url": "https://example.com", "role": "primary"}]
  }'
```

쿼리 `?key=dev-key`도 같은 키로 통과합니다.
