# 커뮤니티 반응 번역·표시 계획 (writer + web)

목표: 레딧 댓글(커뮤니티 반응)을 **한국어로 번역해서** 웹에서 **댓글처럼** 보이게 한다.
번역은 writer가 발행 전에 처리한다.

## 사용자 확정 결정

| 항목 | 결정 |
|---|---|
| 번역 방식 | **전용 번역 LLM 호출** (댓글이 있을 때만, 기사당 +1 호출). 기사 생성 호출에 합치지 않는다 |
| 원문 병기 | **하지 않는다**. 번역문만 보여준다(원문은 출처 링크로 직접 확인) |
| 표시 개수 | 소스당 6개 / 전체 6개 (현재와 동일) |
| 기존 발행 2편 | 재발행해서 번역 반영(아래 검증 참고) |

## 인터페이스 계약 (동결)

payload `sources[].comments`는 **지금과 같은 모양**을 유지한다. 필드만 한국어가 된다.

```json
{
  "name": "Reddit r/Games (top/day)",
  "url": "https://www.reddit.com/r/Games/comments/...",
  "role": "community",
  "comments": [
    { "author": "SomeUser", "text": "한국어로 번역된 댓글" }
  ]
}
```

- `author`: 원문 그대로(닉네임은 번역하지 않는다)
- `text`: 한국어 번역. 원문을 덧붙이지 않는다
- 웹의 `normalizeComments`는 지금처럼 author/text만 읽는다(스키마 변경 없음)

## writer 작업

1. 새 모듈 `src/writer/translate.py`
   - `translate_comments(chat, comments: list[dict], *, model: str) -> list[dict]`
     - 입력: `[{"author": str, "text": str}]` (최대 6개)
     - 출력: 같은 순서·같은 author의 한국어 번역 리스트
     - 프롬프트 규칙: 직역 금지(읽히는 한국어), 게임/브랜드 고유명사는 로마자 원문 유지
       (예: `Wolverine`), 한자·가나는 쓰지 않는다, 원문에 없는 내용·뉴앙스 추가 금지,
       밈/비속어는 톤을 살려 한국어로, 문장 수는 원문과 같게
     - 출력 형식: `[{"author":"...","text":"..."}]` JSON 배열 하나만. 마크다운 펜스 허용
     - 검증: 개수·author가 입력과 다르면 실패로 보고 **원문을 그대로 반환**(경고 로그).
       JSON 파싱 실패도 같은 폴백
     - 이미 한국어뿐인 댓글은 호출을 건너뛴다(한글/숫자/문장부호만 있으면 스킵)
2. `src/writer/pipeline.py`
   - `write_story`에서 `sources = source_lines(hits)` 직후, 커뮤니티 댓글이 있으면 번역해서
     `sources[i]["comments"]`를 교체한다. 번역 실패 시 원문 유지(발행은 계속)
   - 재발행(`status == published`) 경로에서도 동일하게 적용(기사 본문은 재사용, 댓글만 새로 번역)
   - 번역 호출도 `llm_usage`에 기록할지 여부: **기록한다**(role="translate"). 실패해도 발행은 계속
3. `src/writer/pack.py`
   - `source_lines`의 커뮤니티 댓글 상한(MAX_COMMENTS=6)은 유지. 번역 대상도 같은 6개
4. 테스트
   - 번역 성공 경로(가짜 chat 응답) → payload comments가 한국어로 바뀐다
   - 번역 실패(JSON 깨짐/개수 불일치/HTTP 오류) → 원문 유지 + 발행 계속
   - 한국어뿐인 댓글 → 호출 없음
   - author는 번역 후에도 그대로

## web 작업

1. `src/pages/article.ts`의 `communityBox`를 **댓글 카드 스타일**로 바꾼다
   - 섹션 제목은 지금처럼 `커뮤니티 반응`(secondary 색)
   - 각 항목: `bg-surface-container-low border border-outline-variant rounded p-3.5`
     - 1행: `u/<author>`(label-ui, on-surface, semibold) + 출처 이름(작게, outline)
       — 소스 이름은 `Reddit r/Games (top/day)` 같은 문자열에서 `Reddit ` 접두와 ` (top/day)` 꼬리를 떼어
       `r/Games`처럼 보여준다(정규식 1개, 실패하면 원문 그대로)
     - 2행: 번역문 (`text-body-sm`, `whitespace-pre-wrap break-words`)
   - 항목 순서: 소스 순서 유지(현재 평탄화 로직 유지하되 소스 라벨만 붙인다)
   - 전체 6개 상한 유지
2. 테스트(`test/article` 또는 기존 테스트): 커뮤니티 댓글 렌더(작성자·소스 라벨·번역문),
   소스 라벨 정규화, 6개 상한, escape 유지
3. 발행된 기사 페이지의 출처 목록 동작은 건드리지 않는다

## 검증 (상위 에이전트가 직접)

1. `writer write --story-id 64`(이미 발행된 스토리) 재발행 → 기사 본문은 그대로, 댓글만 한국어로 갱신
2. 웹에서 `/s/dueling-industry-surveys-show-japanese-game-devs-64` 확인:
   커뮤니티 반응 6개가 한국어 + 작성자 + `r/Games`/`r/pcgaming` 라벨로 보인다
3. 필요하면 65번도 재발행
4. `log.md` 한 줄, 커밋은 상위 에이전트

## 하지 말 것

- payload에 원문/번역문을 동시에 넣지 않는다
- 댓글 개수 상한(6/6)을 늘리지 않는다
- 기사 본문 프롬프트에 번역 지시를 섞지 않는다
- 웹에서 번역을 시도하지 않는다(표시만)
