# SEO 마무리 계획 (구현 스펙)

목표: 전체 공개한 `web/`을 검색·SNS 에서 제대로 노출되게 만든다. 범위는 `web/` 한정이며
writer/collector 는 건드리지 않고, 발행 계약(`POST /internal/articles`)도 그대로다.

레퍼런스: GeekNews(news.hada.io)의 head 메타·robots·사이트맵 구성을 그대로 따라갈 만큼만 가져온다.

## 1. 요구사항 (사용자)

1. 글 내용을 요약한 부분을 우리 디자인으로 그린 OG 이미지를 **자동 발급**
2. GeekNews 참고해 SEO 를 "현실화"(실제로 크롤러가 먹는 것들)

## 2. 확정 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| OG 렌더 | `satori`(HTML→SVG) + `@resvg/resvg-js`(SVG→PNG) | 순수 JS 레이아웃(줄바꿈·lineClamp) + 프리빌트 네이티브. 브라우저/헤드리스 불필요 |
| 폰트 | Noto Sans KR(OFL) 서브셋 2웨이트 + JetBrains Mono(OFL) 서브셋 2웨이트, gzip 으로 커밋 | 한글 제목 필수. 런타임에 gunzip 해서 5MB→1.8MB 로 리포를 줄인다 |
| 캐시 | 메모리 LRU 200장, 키=`슬러그@수정시각`, 동시 요청 병합 | 발행이 갱신되면 키가 바뀌어 자동 무효화. 재생성 ~200ms |
| OG 경로 | `/og/s/:slug.png`, `/og/default.png` | 확장자 있는 URL(크롤러 친화). Hono 는 `:param.png` 를 못 잡아 `/og/*` 로 받아 직접 파싱 |
| 절대 URL | `SITE_URL` 우선, 없으면 요청 origin | 터널 도메인을 몰라도 canonical·og:image·sitemap 이 절대 URL 로 나온다 |
| 이미지 인덱싱 | 사이트맵에 `image:image` + `robots: max-image-preview:large` | 기사 카드가 검색 이미지로 노출 |
| robots | 학습 봇 차단 / 검색·미리보기 봇 허용 / 저가치 SEO 봇 차단 + `Content-Signal` | GeekNews 와 같은 정책. `/internal/`, `/search` 차단 |

## 3. 파일

```
web/
  assets/fonts/            # 서브셋 폰트(gzip) + OFL 라이선스
  src/site.ts              # 사이트 상수 + 절대 URL + JSON-LD 직렬화
  src/seo.ts               # JSON-LD 빌더(Organization/WebSite/NewsArticle/ItemList)
  src/og.ts                # OG 카드 레이아웃 + satori/resvg + 캐시
  src/brand.ts             # 로고 SVG/PNG, 매니페스트
  src/pages/layout.ts      # head 메타 일괄(OG/Twitter/canonical/icons/JSON-LD/prev·next)
  src/pages/article.ts     # NewsArticle + 관련 기사
  src/pages/feed.ts        # ItemList + 페이지 canonical/prev·next
  src/pages/search.ts      # noindex
  src/app.ts               # /og/*, 아이콘, sitemap(-news), robots, RSS 개선
```

## 4. head 메타

- `robots`: 기본 `max-image-preview:large, max-snippet:-1, max-video-preview:-1`, 검색만 `noindex, follow`
- canonical(자기 참조, 절대 URL), `rel=prev/next`(페이지네이션), `theme-color`, favicon 3종 + 매니페스트
- OG: `og:image`(1200×630, type·width·height·alt), `og:locale`, 기사면 `article:published_time/modified_time/tag`
- Twitter: `summary_large_image` + `twitter:image(:alt)`

## 5. 구조화 데이터

- 전 페이지: `WebSite`(+ SearchAction) + `Organization`
- 기사: `NewsArticle`(headline·description·image·datePublished/Modified·author/publisher=Organization·keywords·commentCount·isAccessibleForFree)
- 피드: `ItemList`(현재 페이지 기사, 2페이지부터는 이름에 범위 표기)

## 6. 사이트맵 · robots · RSS

- `/sitemap.xml`: 홈(hourly) + `/tags` + 태그 피드 + 기사(전부 `lastmod`, 기사엔 OG `image:image`)
- `/sitemap-news.xml`: 최근 48시간 기사만(최대 1000), `news:news` + `image:image`
- `/robots.txt`: `Content-Signal`, 학습 봇 15종 Disallow, 검색 봇 6종 Allow, 저가치 SEO 봇 9종 Disallow, `User-agent: *` 에서 `/internal/`·`/search` 차단, 사이트맵 2줄
- `/rss.xml`: `atom:link rel=self`, `guid isPermaLink="true"`(절대 URL), `category`(태그), `ttl`

## 7. 내부 링크

- 기사 하단 "관련 기사" 5건: 같은 태그 공유 수 → 최신순, 모자라면 최신 기사로 채움
- 홈 h1 = "게임 업계 뉴스 다이제스트"(기존 라벨 자리 그대로), 태그 피드는 h1 = "태그 #X"

## 8. 하지 않은 것

- 다국어(hreflang): 단일 언어
- 브레드크럼·FAQ/스피크아웃: 표시되는 UI 가 없어 근거 없는 마크업이 됨
- `content:encoded`(RSS 전문): 사이트 유입을 위해 요약만
- FTS/이미지 CDN: 별도 과제
