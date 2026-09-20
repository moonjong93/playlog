# web 작업 계획 (구현 스펙)

목표: 로컬에서만 돌던 뉴스 리더를 **전체 공개 서비스로 실제 사용 가능하게** 만든다.
범위는 `web/` 한정. writer/collector는 건드리지 않는다.

## 0. 현재 상태

- `src/index.ts` (196줄): Hono 앱 + 라우트 + `serve()`. `WEB_API_KEY` 하나로 **읽기까지 전부 잠금**, `?key=` 쿼리로 통과.
- `src/pages.ts` (530줄): 레이아웃/피드/기사/출처/커뮤니티 인용 HTML. 죽은 UI 다수(검색창, 테마토글, 알림, 네비 더미).
- `src/db.ts`: better-sqlite3, `schema.sql`을 매번 `exec` (버전관리 없음).
- `src/schema.sql`: `articles` 테이블 하나.
- 테스트 없음.
- 발행 경로: writer `publish.py` → `POST /internal/articles` (Bearer `WEB_API_KEY`). **이 계약은 유지한다.**
- 실제 데이터 46건. 본문은 사실상 전부 `<p>`+`<br>`, 섹션은 `announce|ship|talk` (+ 스모크로 들어간 `테크` 1건).

## 1. 확정 결정 (사용자 승인)

| 항목 | 결정 |
|---|---|
| 로그인 | **없음**. 읽기 전부 공개. `/internal/*`만 Bearer 키 유지 |
| 남용 방지 | 익명 세션 쿠키 + IP 기반 rate limit |
| 인터랙션 | **htmx 4.0.0** (npm `htmx.org@4.0.0`, 로컬 서빙). progressive enhancement 필수 |
| sanitize | `sanitize-html` 패키지 사용 |
| 죽은 UI | 제거 (테마토글·알림·프로필·가짜 네비) |
| HTML 생성기 | writer의 `md_to_html`은 손대지 않음. web은 방어(sanitize)만 |
| 배포 | 개인 서버 + Cloudflare Tunnel → 전체 공개 |

## 2. 환경변수 (`.env`)

| 이름 | 필수 | 기본 | 설명 |
|---|---|---|---|
| `WEB_API_KEY` | ✅ | - | `/internal/*` Bearer 키. writer와 공유 |
| `SESSION_SECRET` | ✅ | - | 세션 쿠키 HMAC 키. 없으면 기동 실패 |
| `PORT` | | 8787 | |
| `HOST` | | 127.0.0.1 | 터널 붙일 땐 127.0.0.1 유지 |
| `WEB_DB` | | `./data/web.db` | 테스트 격리용 |
| `TRUST_PROXY` | | (빈값) | `cloudflare`면 `CF-Connecting-IP`를 실제 IP로 신뢰 |
| `SITE_URL` | | (빈값) | OG/RSS/sitemap 절대 URL. 없으면 상대경로 |
| `COOKIE_SECURE` | | 0 | 1이면 쿠키 `Secure` |
| `RATE_LIMIT_DISABLED` | | 0 | 1이면 리밋 해제(부하 테스트용) |

`?key=` 쿼리 인증은 **삭제**한다.

## 3. 파일 구조

```
web/
  src/
    app.ts          # Hono 앱 + 라우트 (테스트에서 import)
    index.ts        # serve() 만
    db.ts           # sqlite 연결 + query/run/exec
    migrations.ts   # user_version 기반 마이그레이션 배열 + applyMigrations()
    env.ts          # 환경변수 로드/검증 (config() 호출 포함)
    session.ts      # 서명 쿠키 세션 (sid)
    ratelimit.ts    # 인메모리 슬라이딩 윈도우 + clientIp()
    sanitize.ts     # sanitize-html 설정 + 검색용 텍스트 추출
    sections.ts     # enum + 한글 라벨 + 탭 순서
    pages/
      layout.ts     # html shell, 헤더/푸터, head(OG/canonical)
      feed.ts       # 목록 + 페이지네이션 + 섹션 탭
      article.ts    # 기사 상세 + 출처 + 커뮤니티 인용
      search.ts     # 검색 폼/결과 파셜
      comments.ts   # 댓글 섹션/아이템 파셜
      misc.ts       # 404, 에러, 429
  test/  *.test.ts
  dist/  # app.css (tailwind 빌드), htmx.min.js (복사)
```

`pages.ts`는 위 구조로 분해한다. 기존 HTML/CSS 클래스는 그대로 재사용(디자인 회귀 금지).

htmx는 `npm i htmx.org@4.0.0` 후 빌드 스크립트에서 `node_modules/htmx.org/dist/htmx.min.js`를 `dist/htmx.min.js`로 복사.
라우트: `GET /assets/htmx.min.js` (Content-Type `text/javascript`, 장기 캐시는 하지 말 것).

## 4. DB 마이그레이션

`PRAGMA user_version` 기반. `migrations.ts`에 `{ version, up(db) }` 배열.

- **v1**: 현 `schema.sql` 그대로 (articles).
- **v2**: 검색/댓글/정규화
  ```sql
  ALTER TABLE articles ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
  UPDATE articles SET section = '' WHERE section NOT IN ('industry','announce','ship','talk','review');
  CREATE INDEX IF NOT EXISTS idx_articles_section_published ON articles(section, published_at DESC);
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL REFERENCES articles(slug) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    body TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(slug, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id, created_at DESC);
  ```
  마이그레이션 후 `search_text` 백필(태그 제거 → 공백 정리 → 4000자 컷).

## 5. 라우트 스펙

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | `ok` (리밋 제외) |
| GET | `/` | 피드. `?section=`, `?page=` (20/페이지) |
| GET | `/s/:slug` | 기사 + 출처 + 커뮤니티 인용 + 댓글. 없으면 404 |
| GET | `/search` | 검색. `HX-Request-Type: partial`이면 결과 파셜만 |
| GET | `/rss.xml` | 최신 20 |
| GET | `/sitemap.xml` | 전체 slug + 발행일 |
| GET | `/robots.txt` | sitemap 안내 |
| GET | `/assets/htmx.min.js` | 정적 |
| POST | `/internal/articles` | 발행 ingest (Bearer). **응답/필드 계약 유지** + sanitize/정규화 추가 |
| DELETE | `/internal/comments/:id` | 운영 삭제 (Bearer) |
| POST | `/s/:slug/comments` | 댓글 작성 (익명+닉네임) |
| POST | `/comments/:id/delete` | 본인 세션 댓글 삭제 |

미들웨어 순서: `health 예외 → clientIp/세션 확보 → Origin 검사(POST) → rate limit → 라우트`.
`/internal/*`는 Bearer 검사(상수시간 비교) 후 리밋 대상(IP 120/분).

## 6. 세션 · 레이트 리밋

- 쿠키 `sid`, 값 `<16바이트 hex>.<HMAC-SHA256(secret, id)>`. `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=31536000`, `COOKIE_SECURE=1`이면 `Secure`.
- 서명 검증 실패/없음 → 새로 발급. 세션은 상태 없음(DB 저장 안 함). 용도: 리밋 주체 + 댓글 소유권.
- `clientIp(c)`: `TRUST_PROXY=cloudflare`면 `CF-Connecting-IP`, 아니면 `getConnInfo(c).remote.address`. IPv4-mapped IPv6(`::ffff:`) 정규화.
- 슬라이딩 윈도우 인메모리 버킷. 주기적 정리(30초 간격, `unref()`), 버킷 키 상한.
- 한도 (초과 시 `429` + `Retry-After` + HTML 조각):
  - 전역 IP: 300/분
  - 검색 IP: 60/분
  - 댓글 세션: 30초에 1개
  - 댓글 IP: 10/시간
- 댓글 누적 한도는 DB 조회로 판정(재시작에도 유지). 검색/전역은 인메모리로 충분.
- `RATE_LIMIT_DISABLED=1`이면 전부 통과.

## 7. 검색

- 쿼리: trim, 1자 이상 100자 이하. 2자 미만이면 "2자 이상 입력" 안내.
- 매칭: `title_ko`, `lede_ko`, `search_text`에 `LIKE '%'||?||'%'`(대소문자 무시). FTS5는 데이터 커지면 후속 과제(지금 넣지 않는다).
- 정렬: 제목 매치 > 리드 매치 > 본문 매치, 동률이면 `published_at DESC`.
- 표시: 제목/섹션/시간 + 본문 스니펫(매치 앞뒤 60자, 매치 부분 `<mark>`). 스니펫은 **escape 후** `<mark>`만 삽입.
- 빈 결과/빈 쿼리 상태 HTML 제공.
- htmx: 입력 `hx-action="/search"` `hx-method="get"` `hx-trigger="input changed delay:300ms"` `hx-target="#search-results"` `hx-push-url="true"`. 폼은 `action="/search"` `method="get"` (JS 없이도 동작). ⌘K/Ctrl+K → 검색창 포커스(작은 인라인 스크립트, htmx와 무관).
- 섹션 필터 탭은 검색에도 적용.

## 8. 발행/HTML

- `/internal/articles`는 기존 필드 계약 유지. 추가 처리:
  - `body_html` → `sanitize-html` 허용목록 통과
  - 외부 링크에 `target="_blank" rel="noopener noreferrer"` (transformTags)
  - `section` 화이트리스트 밖 → `''`
  - `search_text` 갱신
- 허용 태그: `p, br, a, strong, em, b, i, u, s, ul, ol, li, h2, h3, h4, blockquote, code, pre, hr`. 속성은 `a`의 `href/title`만. 프로토콜 `http/https/mailto`만.
- 섹션 라벨: `industry`=업계·사업, `announce`=발표·신작, `ship`=출시·패치, `talk`=발언, `review`=리뷰·공략. 매핑에 없으면 라벨 없이 원문 태그 표시.
- 피드 카드: `<!-- -->`로 꺼둔 출처 배지 주석 **제거**(다시 표시). 출처 0건이면 배지 영역 자체를 안 그린다.
- 목록: 20/페이지 페이지네이션(이전/다음 + 현재 페이지 주변 번호). 섹션 탭: 전체 + 5개 섹션.
- 상세: OG/트위터 메타(`og:title`, `og:description`(리드 첫 줄), `og:type=article`, `og:url`, `article:published_time`), canonical.

## 9. 댓글 (익명 + 닉네임)

- 폼: 닉네임(선택, 1~20자, 비면 "익명"), 내용(2~1000자, 필수). escape 후 저장/표시.
- `POST /s/:slug/comments`
  - htmx(`HX-Request-Type: partial`): 새 댓글 `<li>` + `<hx-partial id="comment-count">` 반환. 성공 시 응답 헤더 `HX-Trigger: commentPosted`로 폼을 비운다(`hx-on="commentPosted from:body -> this.reset()"`). 429/422에서는 입력을 보존한다. `hx-target="#comment-list"` `hx-swap="afterbegin"`
  - 일반 폼: `303`으로 `/s/:slug#comments` 이동
  - 검증 실패: htmx면 `422` + 에러 HTML(htmx 4는 4xx도 swap함), 일반이면 400 HTML
  - 리밋 초과: `429` + 안내 HTML
- 목록: 최신 50개, `deleted_at IS NULL`. 상대시간 + 절대시간 `title`. 개수 표시.
- 삭제: 세션 소유 댓글에만 삭제 버튼(htmx `hx-action="/comments/:id/delete" hx-target="closest li" hx-swap="outerHTML"`). 본인 아니면 403.
- 기존 "커뮤니티 반응"(출처 인용)과 **분리된 별개 섹션**. 출처 인용은 그대로 유지.
- CSRF/스팸: `Origin` 헤더가 있으면 host와 일치해야 통과(POST 전용), `SameSite=Lax`. honeypot input 하나(채워지면 조용히 무시).

## 10. UI 정리

- 삭제: 테마 토글, 알림 버튼, 프로필 아이콘, 네비 더미(웹진 심층 분석 / AI 3줄 요약 / 특가·할인 / 커뮤니티[준비중]).
- 대체: 헤더 네비 = 섹션 탭(실제 링크) + `RSS` 링크. 검색창은 실제 동작.
- 푸터: 유지하되 `SITE_URL` 있으면 링크/저작권 문구 정리(과한 문구 추가 금지).
- 접근성: 폼 `label`, 버튼 `aria-label`, `lang="ko"` 유지.

## 11. 보안/헤더

- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `hono/compress` 적용.
- Bearer 비교는 `timingSafeEqual`.
- CSP는 이번 범위 아님(인라인 스타일/폰트). 대신 인라인 스크립트는 최소화.

## 12. 배포 (담당 분리)

- `Dockerfile`: `node:24-slim`, better-sqlite3 빌드 대비(`python3 make g++`), `npm ci`, CSS/htmx 빌드 후 `tsx src/index.ts`.
- `docker-compose.yml`: `127.0.0.1:8787:8787` 바인딩, `./data` 볼륨, env 전달, `restart: unless-stopped`.
- README에 Cloudflare Tunnel 절차(`cloudflared tunnel --url http://127.0.0.1:8787`)와 환경변수 표.
- `.env.example` 갱신(위 8개 변수 + 주석).

## 13. 테스트 (vitest)

`app.request()`로 서버 없이 라우트 검증. `WEB_DB`를 임시 파일로 지정해 격리. 필수 케이스:

1. `GET /health` 200, 공개 라우트가 키 없이 200 (인증 잠금 해제 확인)
2. `?key=` 무시되는지(더 이상 통과 경로 아님)
3. `/internal/articles`: 키 없음 401 / 키 있음 201 / 재발행 200 / `body_html` sanitize(`<script>`, `onerror`, `javascript:` 제거) / 섹션 정규화 / `search_text` 생성
4. 피드 페이지네이션(20개 컷), 섹션 필터
5. 기사 404
6. 검색: 매치/미매치, 1자 거부, 파셜 응답(HX-Request-Type)
7. 댓글: 작성 → 목록 반영, 길이 검증 422, 닉네임 기본값, 429(리밋), 삭제 403/200, honeypot
8. 세션 쿠키 발급/서명 검증
9. `/rss.xml`, `/sitemap.xml`, `/robots.txt` 200 + 형식
10. `RATE_LIMIT_DISABLED` 동작

## 14. 완료 기준 (DoD)

- `npm test` 전부 통과, `npx tsc --noEmit` 통과
- `npm run dev` 기동 → `curl`로 `/`, `/s/:slug`, `/search?q=TGS`, 댓글 작성/삭제, `/rss.xml` 확인
- 기존 46건 데이터가 목록/상세에서 정상 표시(디자인 회귀 없음)
- writer `POST /internal/articles`가 Bearer로 그대로 성공 (curl 재현)
- README/.env.example/PLAN 갱신, log.md 한 줄 추가
- **git commit 하지 않는다** (마무리 단계에서 상위 에이전트가 처리)

## 15. 하지 말 것

- writer/collector 수정, 스키마 필드명 변경, 라우트 계약 변경(발행 필드/응답 형태)
- 로그인/회원가입/관리자 UI 추가
- 라이트 테마 추가, 디자인 개편, 새 CSS 프레임워크
- FTS5 도입, Redis 등 외부 저장소 의존
- `?key=` 방식 유지
