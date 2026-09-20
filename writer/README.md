# writer

collector 가 모은 `raw_items` + `item_embeddings` 를 읽어 **같은 사건을 묶고**, RAG 로 관련 항목을 붙인 뒤 OpenRouter 로 **한글 단신**을 쓴다.

LLM 프레임워크가 아니다. collector 와 같은 로컬 Python + SQLite + systemd. OpenRouter 는 스토리당 **한 번** 친다.

```
collector (15분)                 writer (3시간)
RSS → raw_items                  같은 data/news.db
    → item_embeddings
                                 1. 미소비 embedded 로드
                                 2. 교차매체 유사도 클러스터 (0.72)
                                 3. 센트로이드 RAG 확장
                                 4. 휴리스틱 선별 / 기존 스토리 병합
                                 5. OpenRouter 한 번 (한글 단신)
                                 6. stories + out/YYYY-MM-DD/*.md
```

**하지 않는 것**: collector 4테이블 수정, 기사 HTML 본문 수집, 임의 질의 브리핑, 웹 발행.

---

# 소유 경계

| 소유자 | 테이블 | 규칙 |
|---|---|---|
| collector | `sources` `raw_items` `source_fetches` `item_embeddings` | writer 는 **SELECT 만** |
| writer | `writer_runs` `stories` `story_sources` `story_relations` `writing_items` `articles` `llm_usage` `writer_meta` | 이 테이블만 쓴다 |

소비 커서는 `writing_items` 다. `raw_items.status` 는 건드리지 않는다.

---

# 설치

```bash
cd ~/Develop/news/writer
cp .env.example .env          # OPENROUTER_API_KEY, WRITER_MODEL
uv sync
uv run writer init-db
uv run writer doctor
```

`NEWS_DB` 기본값은 `../collector/data/news.db`. `EMBED_MODEL` 은 collector 가 넣은 벡터 키와 같아야 한다 (로컬 기본 `lfm2.5-embedding-350m`).

---

# 사용

| 명령 | 설명 |
|---|---|
| `writer init-db` | writer 스키마 적용 |
| `writer doctor` | DB/모델 키/API 키 점검 |
| `writer cluster [--lookback 36] [--dry-run]` | 묶기+RAG+선별. LLM 없음 |
| `writer write --story-id N` | 스토리 하나 초안+편집+md |
| `writer stories` | 최근 스토리 |
| `writer run [--once] [--dry-run] [--no-write]` | 주기 실행 |
| `writer bench` / `writer batch` | `.env BENCH_MODELS` 로 경합. **발행하지 않는다** |
| `writer bench show [--run-id N]` | 벤치 마크다운 |

처음엔 LLM 없이 묶임만 본다:

```bash
uv run writer cluster --lookback 36 --dry-run
uv run writer run --once --no-write     # 스토리만 저장
uv run writer write --story-id 1        # 한 편만 실제로 쓰기
uv run writer run --once                # 남은 clustered 를 전부 쓰기
```

모델을 바꿀 때는 발행 파이프를 건드리지 말고 벤치로 고른다.

```bash
# .env 의 BENCH_MODELS 로 바로 돈다 (writer batch 도 같음)
uv run writer bench
uv run writer batch

uv run writer bench --task write --limit 3
uv run writer bench show
```

결과는 마크다운이다.

```bash
uv run writer bench show              # 최신 리포트 출력
uv run writer bench show --open       # macOS 에서 파일 열기
uv run writer bench show --list       # 런 목록
uv run writer bench show --run-id 6
```

파일:

- `out/bench/latest.md` — 가장 최근 결과
- `out/bench/run-N.md` — 런별
- `out/bench/index.md` — 목록

같은 원문 아래 모델별 제목·본문이 나란히 있다. 자동 점수는 없고 눈으로 고른 뒤 `WRITER_MODEL=` 만 바꾼다.

기본 모델은 `.env` 의 `BENCH_MODELS` (쉼표 구분):

```
BENCH_MODELS=inclusionai/ling-3.0-flash,deepseek/deepseek-v4-flash,google/gemma-4-26b-a4b-it,google/gemma-4-31b-it,upstage/solar-pro4,google/gemini-2.5-flash-lite,openai/gpt-5.6-luna
```

리포트 요약에 `한자누출`(한자·가나가 섞인 출력 건수)과 `원제누락`(로마자 원제를 안 쓴 건수)이 플래그로 붙는다. **출력은 고치지 않고 표시만** 한다. `write` 태스크는 요약(lede)도 같이 보여준다.

`translate` 는 싸다. 한국어 문장·고유명사·사실 날조를 먼저 본다. `write` 는 실제 기자 프롬프트라 더 비싸지만 본게임 품질에 가깝다.

벤치는 thinking 을 끈다 (`reasoning.effort=none`, Qwen 은 `/no_think`). 고유명사는 원문 유지가 기본이다.

---

# 선별 규칙 (1차, LLM 없음)

- **제목만 있는 소스**(요약·본문 없음) → `skipped` (항목은 소비해서 다음 주기에 안 나옴)
- 그 외 클러스터는 모두 쓴다. 매체 수·weight 는 importance 점수일 뿐 발매 게이트가 아니다
- 기존 스토리 센트로이드 ≥ 0.80 → 같은 사건에 붙이고 (새 시드가 있으면) 갱신
- 0.70~0.80 → 새 스토리 + `related`
- `WRITER_MAX_PER_RUN` > 0 이면 한 주기 상한 (기본 0 = 무제한). 초과분은 소비하지 않고 다음 주기로 넘긴다.

RAG: 시드 센트로이드로 7일 창을 전수 내적. 기사 0.65+ top-8, 커뮤니티 0.70+ top-3. 0.72 미만 retrieved 는 팩에만 넣고 소비하지 않는다.

---

# 운영

```bash
cp systemd/writer-run.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now writer-run.service
```

collector 가 먼저 돌아야 한다. writer 는 torch 를 안 올린다.

---

# 테스트

네트워크를 쓰지 않는다 (가짜 OpenRouter + 픽스처 벡터).

```bash
uv run pytest
```
