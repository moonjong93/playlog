# 태그 전환 계획 (writer + web)

목표: 고정 enum `section`(industry|announce|ship|talk|review)을 **자유 태그**로 바꾼다.
네비에는 최근 사용 태그 5개만, 전체는 `/tags`에서 페이징으로.

## 사용자 확정 결정

| 항목 | 결정 |
|---|---|
| 태그 수 | 기사당 1~3개, 한국어 중심(영문·숫자 허용) |
| 재사용 힌트 | **없음**. writer는 기존 태그 목록을 받아오지 않는다(태그 쪼개짐은 감수) |
| 기존 45건 | section → 태그로 **백필** (한글 라벨 사용) |
| 네비 5개 | **최근 발행 기사에 붙은 태그순** |
| `/tags` 전체보기 | **사용 횟수순**, 30개/페이지 |
| collector | 손대지 않는다 |

## 인터페이스 계약 (동결)

`POST /internal/articles` (writer → web). 기존 필드는 그대로 두고 `section`만 뺀다.

```json
{
  "slug": "...", "title_ko": "...", "lede_ko": "...", "body_html": "...",
  "published_at": "...", "updated_at": "...", "story_id": 1,
  "sources": [...],
  "tags": ["닌텐도", "TGS2026"]
}
```

- `tags`: 선택. **키가 없으면 웹은 기존 태그를 유지한다**(재발행 시 태그를 지우지 않는다).
  빈 배열이면 태그를 비운다. 배열이 아니면 400.
- `section`: 레거시 호환. `tags`가 없고 `section`이 있으면 아래 매핑으로 태그 1개로 변환한다.
  - industry→`업계·사업`, announce→`발표·신작`, ship→`출시·패치`, talk→`발언`, review→`리뷰·공략`
- 응답 형태(`{ok:true,slug}` 200/201)와 나머지 필드 계약은 **변경 금지**.

## 태그 정규화 (양쪽 공통 규칙)

1. 문자열이면 쉼표/`/`로 나눠 배열로 본다(모델이 문자열로 낼 때 대비). 배열이 아니면 빈 배열.
2. 각 항목: trim → 선행 `#` 제거 → 허용 문자만 남김(`한글/영문/숫자/공백/·/+/-/&/_/./:`)
   → 연속 공백 1칸 → 20자 컷 → trim. (`/`는 허용 문자가 아니라 구분자다: 문자열 입력을 나누고,
   배열 항목에 들어 있으면 제거한다)
3. 2자 미만은 버린다. 대소문자 무시 중복 제거(먼저 나온 표기 유지)
4. 최대 3개(writer) / 최대 5개(web 저장 시 방어)

## writer 작업

1. `config/prompts.yaml`: 출력 JSON을
   `{"title_ko":"...","lede_ko":"줄1\\n줄2","body_md":"마크다운","tags":["태그1","태그2"]}`로 바꾸고
   `section:` 설명을 `tags:` 규칙으로 교체.
   - 기사당 1~3개, 한국어 2~12자, 회사·플랫폼·장르·행사 이름
   - 조사 붙은 말 금지("닌텐도가"✗), 문장 금지, 널리 쓰는 말을 고른다
   - 기사마다 새 말을 만들지 말 것(힌트는 없지만 이 지시는 유지)
2. `src/writer/publish.py`
   - `normalize_tags(value) -> list[str]` 추가(위 규칙, 최대 3개)
   - `ingest_payload(..., tags: list[str] | None)` 로 변경. `section` 파라미터 제거.
     `tags is None`이면 payload에 `tags` 키를 **넣지 않는다**
3. `src/writer/pipeline.py`
   - 새 글: `tags = normalize_tags(w.data.get("tags"))` → payload에 전달
   - 이미 `published` 상태인 스토리 재발행: `tags=None` (태그 유지)
4. `render_markdown`: front matter에 `tags: [a, b]` 한 줄 추가. `tags=None`(재발행)이면 줄 자체를 쓰지 않는다
   (웹의 기존 태그를 모르는데 `tags: []`로 거짓 기록하지 않기 위해)
5. `tests/test_publish.py` 갱신 + 신규: 태그 정규화(중복/문자열 입력/2자 미만/3개 초과),
   재발행 payload에 `tags` 키가 없는지
6. writer 전체 테스트(`uv run pytest`) 통과. `ingest_payload` 호출부가 더 있으면 같이 고친다(cli 등 grep할 것)

## web 작업

1. `src/migrations.ts` v3 추가
   ```sql
   CREATE TABLE IF NOT EXISTS article_tags (
     slug TEXT NOT NULL REFERENCES articles(slug) ON DELETE CASCADE,
     tag  TEXT NOT NULL,
     PRIMARY KEY (slug, tag)
   );
   CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags(tag, slug);
   -- 기존 section 백필 (한글 라벨)
   INSERT OR IGNORE INTO article_tags (slug, tag)
     SELECT slug, CASE section
       WHEN 'industry' THEN '업계·사업' WHEN 'announce' THEN '발표·신작'
       WHEN 'ship' THEN '출시·패치' WHEN 'talk' THEN '발언'
       WHEN 'review' THEN '리뷰·공략' END
     FROM articles WHERE section <> '';
   DROP INDEX IF EXISTS idx_articles_section_published;
   ALTER TABLE articles DROP COLUMN section;
   ```
2. `src/sections.ts` 삭제 → `src/tags.ts`: `normalizeTags`, `LEGACY_SECTION_TAGS`, 상수(`MAX_TAGS`, `TAG_MAX_LEN`, `TAGS_PAGE_SIZE=30`)
3. ingest(`app.ts`): 위 계약대로 `tags` 처리. 없는 키면 유지, 배열이면 교체.
   `article_tags`는 `DELETE`+`INSERT` 트랜잭션으로 교체
4. 태그 조회 헬퍼: `tagsFor(slugs)`, `recentTags(limit=5)`, `allTags(page)` (사용 횟수순, 최근 사용일)
5. 라우트
   - `GET /`: `?tag=` 필터 (+ `?page=`). 없는 태그면 빈 결과
   - `GET /tags?page=`: 전체 태그 목록(태그·사용 횟수·최근 발행일), 30개/페이지, 링크 `/tags?page=N`
   - `GET /search`: `?tag=` 필터 지원(기존 section 탭 자리에 태그 칩)
6. 렌더
   - 헤더 네비: 최근 태그 5개 + `전체보기`(/tags). 기존 전체/섹션 탭 제거
   - 피드 카드·기사 상세: 태그 칩(여러 개, 클릭 = `/?tag=`). `sectionTag` 제거
   - 검색 결과: 태그 칩 표시
   - canonical/OG 유지
7. 테스트 갱신: helpers의 `insertArticle`은 `tags` 배열 받기, 섹션 관련 케이스 → 태그.
   신규: ingest 태그 정규화·태그 생략 시 유지, `?tag=` 필터, `/tags` 페이징, 최근 5개 순서,
   레거시 `section` 호환
8. `npx tsc --noEmit` + `npm test` 통과

## 완료 기준

- writer `pytest` 전부 통과, web `tsc` + `vitest` 전부 통과
- 실서버 curl: `tags` 포함 ingest → 기사에 칩 표시, `/?tag=`, `/tags` 페이징, `tags` 생략 재발행 시 유지
- `?section=` 이 더 이상 필터로 동작하지 않는다(무시)
- log.md 한 줄 추가, 커밋은 상위 에이전트가

## 알려진 트레이드오프

- 태그 힌트가 없으므로 유사 태그가 쪼개질 수 있다(`닌텐도`/`닌텐도 스위치`). 문제가 되면
  `GET /internal/tags` + 프롬프트 주입을 후속으로 붙인다(웹 10줄, writer 20줄).
- 기존 45건은 섹션 라벨이 태그로 남는다(사용자가 승인).
