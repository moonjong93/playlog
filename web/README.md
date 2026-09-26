# web

PLAYLOG(`news.nevra.app`) 웹. 게임 업계 뉴스 & 스토리. Hono + SQLite(better-sqlite3) + Tailwind v4.

- 읽기는 전부 공개다. `/`, `/s/:slug`, `/search`, `/rss.xml` 은 키 없이 열린다.
- 발행(`/internal/*`)만 키가 필요하다. writer 가 `POST /internal/articles` 를 Bearer `WEB_API_KEY` 로 호출한다.
- 예전의 `?key=` 쿼리 인증은 제거됐다.

## 로컬 실행

```bash
cd web
cp .env.example .env    # WEB_API_KEY, SESSION_SECRET 채운다
npm install
npm run dev             # http://127.0.0.1:8787
```

`npm run dev` 는 tsx watch, `npm start` 는 tsx 단발 실행이다. 둘 다 pre* 훅에서 Tailwind 를 돌려 `dist/app.css` 를 만들고 htmx 를 `dist/htmx.min.js` 로 복사한다(`npm run css`, `npm run assets`). `dist/` 는 커밋하지 않으므로 이 단계를 건너뛰면 스타일 없는 페이지가 뜨고 `/assets/htmx.min.js` 가 404 가 된다.

DB 는 기본 `data/web.db`(SQLite WAL). `WEB_DB` 로 바꿀 수 있다.

## 테스트

```bash
npm test          # vitest, WEB_DB 를 임시 파일로 잡아 격리한다
npx tsc --noEmit
```

## 발행 (ingest)

writer 와 공유하는 `WEB_API_KEY` 를 Bearer 로 넣는다.

```bash
curl -sS -X POST http://127.0.0.1:8787/internal/articles \
  -H 'Authorization: Bearer dev-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "sample-brief",
    "title_ko": "샘플 단신",
    "lede_ko": "로컬 스모크용 한 줄.",
    "body_html": "<p>본문입니다.</p>",
    "tags": ["발표·신작"],
    "published_at": "2026-09-19T12:00:00+09:00",
    "updated_at": "2026-09-19T12:00:00+09:00",
    "story_id": 1,
    "sources": [{"name": "Example", "url": "https://example.com", "role": "primary"}]
  }'
```

`body_html` 은 sanitize 되고(허용 태그 밖은 제거, 외부 링크엔 `rel="noopener noreferrer"`), `tags` 는 1~3개 자유 태그다(쉼표·슬래시로 쪼개고 길이·중복을 정리). `tags` 키가 없으면 기존 태그를 유지하고, `[]` 면 비운다(레거시 `section` 값은 태그 1개로 변환). 같은 `slug` 재발행은 갱신(200)이다.

## 환경변수

| 이름 | 필수 | 기본 | 설명 |
|---|---|---|---|
| `WEB_API_KEY` | O | - | `/internal/*` Bearer 키. writer 와 공유 |
| `SESSION_SECRET` | O | - | 세션 쿠키 HMAC 키. 없으면 기동 실패 |
| `PORT` | | 8787 | HTTP 포트 |
| `HOST` | | 127.0.0.1 | 바인드 주소. compose 안에서는 0.0.0.0 |
| `WEB_DB` | | `./data/web.db` | SQLite 파일 경로 |
| `TRUST_PROXY` | | (빈값) | `cloudflare` 면 `CF-Connecting-IP` 를 실제 IP 로 신뢰 |
| `SITE_URL` | | (빈값) | canonical·OG·RSS·sitemap 의 절대 URL 기준. 로컬은 비우면 요청 `Host`(origin)를 쓰고, compose 는 `https://news.nevra.app` 이 기본값 |
| `COOKIE_SECURE` | | 0 | 1이면 쿠키 `Secure` |
| `RATE_LIMIT_DISABLED` | | 0 | 1이면 리밋 해제(부하 테스트용) |
| `GOOGLE_SITE_VERIFICATION`, `NAVER_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | | (빈값) | 각 서치콘솔 소유확인 값. 넣으면 head 에 해당 메타태그가 붙는다 |

## SEO · 공유 카드

검색·SNS 노출에 필요한 것은 전부 서버가 만들어 준다(외부 SaaS 없음).

| 경로 | 내용 |
|---|---|
| `/og/s/:slug.png` | 기사 공유 카드(1200×630 PNG). 제목·요약 불릿·태그·날짜를 사이트 디자인으로 그린다 |
| `/og/default.png` | 홈·태그·검색 등 기사가 없는 페이지의 기본 카드 |
| `/assets/icon-192.png`, `/assets/icon-512.png`, `/assets/apple-touch-icon.png`, `/favicon.ico`, `/assets/favicon.svg` | 사이트 아이콘(접힌 리본 P + 플레이 버튼 로고) |
| `/site.webmanifest` | 웹 앱 매니페스트 |
| `/sitemap.xml` | 홈·태그 목록·태그 피드·기사 전체 + 기사 OG 이미지(`image:image`) |
| `/sitemap-news.xml` | 최근 48시간 기사(Google 뉴스 사이트맵) |
| `/robots.txt` | 검색·미리보기 봇 허용, AI 학습 수집기·저가치 SEO 크롤러 차단, sitemap 안내 |

- 카드 생성은 `satori`(HTML→SVG) + `@resvg/resvg-js`(SVG→PNG)로 한다. 슬러그+수정시각을 키로 메모리에 캐시(최대 200장)하고, 같은 URL 동시 요청은 한 번만 렌더한다. 응답은 `Cache-Control: public, max-age=86400`.
- 폰트는 `assets/fonts/*.ttf.gz`(Gzip)에 둔 서브셋이다. Noto Sans KR(OFL)에서 한글 음절·가나·기호 + 라틴, JetBrains Mono(OFL)에서 라틴을 남겼다. 라이선스 원문은 같은 디렉터리의 `OFL-*.txt`. 폰트를 바꿀 때는 두 파일을 같은 이름으로 교체하면 된다.
- 로고 원본은 `assets/logo.svg`(Figma 내보내기)다. SVG 표준에 없는 각도 그라디언트(`foreignObject` + CSS `conic-gradient`)라 그대로는 resvg 가 못 그려서, `src/brand.ts` 가 같은 도형을 부채꼴 36조각으로 나눠 칠한다(원본과 픽셀 오차 평균 0.6/255). 헤더·OG 카드·아이콘·매니페스트가 모두 이 한 마크를 쓴다.

```bash
# 서브셋 재생성(예: Noto Sans KR). 커밋된 파일은 아래 절차로 만들었다.
pip install fonttools brotli
curl -LO https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf
UNICODES="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+20A0-20BF,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2713,U+3000-303F,U+3040-30FF,U+3131-318E,U+1100-11FF,U+AC00-D7A3,U+FF01-FF60,U+FFE0-FFE6"
for W in 400 700; do
  fonttools varLib.instancer "NotoSansKR[wght].ttf" wght=$W -o "inst-$W.ttf"
  pyftsubset "inst-$W.ttf" --unicodes="$UNICODES" --no-hinting \
    --drop-tables+=DSIG --layout-features='' --output-file="NotoSansKR-$W.ttf"
  gzip -9 -c "NotoSansKR-$W.ttf" > "NotoSansKR-$W.ttf.gz"
done
```
- 구조화 데이터(JSON-LD): 모든 페이지에 `WebSite` + `Organization`, 기사에 `NewsArticle`(제목·요약·이미지·발행/수정 시각·태그·댓글 수), 피드에 `ItemList`. 전부 `<`를 이스케이프해 `</script>`로 끊기지 않게 한다.
- 검색 페이지는 `noindex, follow`, 나머지는 `max-image-preview:large, max-snippet:-1`(+ canonical, og/twitter 카드, `rel=prev/next`). 기사 하단의 "관련 기사"는 같은 태그를 많이 공유하는 순으로 붙는다(내부 링크).
- `og:image`·canonical·sitemap 은 `SITE_URL` 이 있으면 그 값, 없으면 요청의 origin 을 쓴다. compose 는 기본값이 `https://news.nevra.app` 이고 `.env` 로 덮어쓸 수 있다.
- 검색엔진 등록 순서: 도메인 확정 → `SITE_URL` 채우기 → 서치콘솔 소유확인 값(`GOOGLE_SITE_VERIFICATION` / `NAVER_SITE_VERIFICATION` / `BING_SITE_VERIFICATION`)을 넣고 재기동 → 각 콘솔에 `https://<도메인>/sitemap.xml`, `/sitemap-news.xml` 제출. `robots.txt` 는 크롤러가 자동으로 읽는다.

## 배포 (개인 서버 + Cloudflare Tunnel)

루트 `docker-compose.yml` 로 배포한다(web 단독 compose 는 없다).

```bash
cd <repo root>
cp .env.example .env      # WEB_API_KEY, SESSION_SECRET(openssl rand -hex 32), CLOUDFLARE_TUNNEL_TOKEN
docker compose up -d --build
```

- 컨테이너는 `WEB_API_KEY`, `SESSION_SECRET`, `SITE_URL` 만 받는다. 나머지는 컨테이너 값으로 고정된다: `PORT=8787`, `HOST=0.0.0.0`, `WEB_DB=/app/data/web.db`, `TRUST_PROXY=cloudflare`, `COOKIE_SECURE=1`, `RATE_LIMIT_DISABLED=0`. 로컬 개발용 설정이 컨테이너에 섞여 들어가지 않는다.
- 포트는 호스트 루프백 `127.0.0.1:${WEB_PORT}` (기본 8787)에만 열린다. 외부 유입은 cloudflared 터널뿐이고 ingress 는 Cloudflare 대시보드에서 `news.nevra.app → http://news-web:8787` 로 등록한다.
- `./data/news-web` 이 `/app/data` 볼륨이다. 컨테이너는 비루트(uid 1000)로 돌아서 리눅스에서는 미리 `mkdir -p data/news-web && chown 1000:1000 data/news-web` 한다.
- `TRUST_PROXY=cloudflare` 라서 방문자 IP 를 `CF-Connecting-IP` 로 잡는다. 터널 뒤에서만 유효하다. `COOKIE_SECURE=1` 이므로 댓글 세션은 HTTPS(터널 도메인)에서만 유지된다.
- 이미지 빌드에서 `npm run css` 가 돌아 `dist/app.css` 가 이미지 안에 들어간다.

## 운영 메모

- SQLite 는 WAL 모드다. 백업은 파일 복사 대신 `sqlite3 data/news-web/web.db ".backup '/tmp/web-$(date +%F).db'"` 로 뜬다. DB 사본은 이 볼륨이 유일하다.
- `WEB_API_KEY` 를 회전하면 writer(`publish.py`)의 `WEB_API_KEY` 도 같이 바꿔야 발행이 계속 된다. 한쪽만 바꾸면 발행이 401 로 떨어진다.
- `SESSION_SECRET` 을 바꾸면 기존 세션이 전부 무효화된다(로그인이 없어서 영향은 리밋 주체와 댓글 소유권 정도).
