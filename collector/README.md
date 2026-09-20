# collector

RSS/Reddit **수집 + 관리**만 하는 프로그램. **LLM을 쓰지 않는다.** 임베딩만 사용한다.
이 문서 하나로 사용법과 운영/관리 방법을 모두 다룬다.

```
외부 인터넷 (RSS 17 + Reddit 3)
        ↓
   ┌─────────────────────────────┐
   │ collector                   │   ← 여기까지가 이 프로그램
   │  1. fetch (UA/지문/백오프)   │
   │  2. parse → URL 정규화       │
   │  3. 중복 제거 → raw_items    │
   │  4. 노이즈 1차 필터 (규칙)    │
   │  5. 임베딩 저장 (로컬 내장)   │
   └─────────────────────────────┘
        ↓
   raw_items + item_embeddings
        ↓
   ┌─────────────────────────────┐
   │ writer (별도, 나중에)         │  ← 클라우드 모델로 묶기 + 발행
   └─────────────────────────────┘
```

**하지 않는 것**: LLM 호출, 기사 본문 수집, 사건 묶기(clustering), 발행.

---

# 1. 소유 경계 (관리할 때 제일 중요)

| 소유자 | 테이블 | 규칙 |
|---|---|---|
| **collector** | `sources` `raw_items` `source_fetches` `item_embeddings` | `sources` 는 yaml에서만 고친다. `raw_items` 는 **append-only** — 만든 뒤 내용을 고치지 않는다(상태 전이만) |
| writer (나중) | `writer_runs` `writing_items` `stories` `story_sources` `story_relations` `llm_usage` | writer 는 같은 `news.db` 를 읽되 위 4개 테이블은 건드리지 않는다 |

- collector 는 `stories` 를 만들지 않는다. **다른 매체가 같은 사건을 쓴 것도 지우지 않는다** — 그걸 묶는 게 writer 의 일이다.
- DB 파일은 `data/news.db` 하나. 벡터도 같은 파일(`item_embeddings`, float32 BLOB 4KB/건)에 있다.
  별도 벡터DB는 없다. 1024차원 정규화 벡터라 유사도 = 내적이고, 현재 규모(1천 건)에서 전수 비교가 즉시 끝난다.

### 상태 전이 (`raw_items.status`)

```
new ──(노이즈 규칙에 걸림)──▶ filtered     삭제 아님. noise_reason 기록. writer 가 되살릴 수 있다
 │
 └──(임베딩 완료)──────────▶ embedded     writer 가 가져갈 수 있는 상태

failed : 스키마에만 있고 현재 코드는 쓰지 않는다
```

운영상 알아야 할 결과:

- 임베딩은 `status='new'` 만 처리한다 → **노이즈 필터가 먼저 돌아야 한다**. `run` 은 그 순서로 돈다.
- 임베딩 실패는 예외를 안 삼키고 `new` 로 남긴다 → 다음 주기에 자동 재시도.
- `filtered` 로 간 항목은 `--rebuild` 를 해도 큐로 돌아오지 않는다.
- 임베딩이 끝난 항목을 지우거나 다시 만들지 않는다. 모델을 바꾸면 `--rebuild` 로 새 벡터를 추가하고 `--purge` 로 옛 것을 지운다.

---

# 2. 파일 지도

| 경로 | 역할 |
|---|---|
| `config/sources.yaml` | 피드 정의(이름/URL/UA/impersonate/enabled). **여기가 소스의 기준** |
| `config/noise_rules.yaml` | 노이즈 규칙 (allow → allow패턴 → deny패턴 → 보존) |
| `db/schema.sql` | 스키마. 매 실행마다 재적용된다(`IF NOT EXISTS`) |
| `.env` | 기계별 설정(경로, 임베딩 백엔드 등). `.gitignore` 대상 |
| `data/news.db` | SQLite. 수집 데이터 + 벡터 |
| `src/collector/collector.py` | fetch→parse→중복제거→insert |
| `src/collector/fetcher.py` | HTTP 계층 (UA, curl_cffi impersonate, 백오프) |
| `src/collector/urlnorm.py` | canonical URL + 해시. **중복 판정이 전부 여기 규칙에 의존** |
| `src/collector/noise.py` | 규칙 필터 |
| `src/collector/embed.py` | 임베딩 백엔드(로컬/OpenRouter) + 벡터 저장/조회 |
| `src/collector/report.py` | 검증 리포트 |
| `src/collector/cli.py` | 명령어 |
| `systemd/collector-run.service` | 상시 실행 유닛 |
| `report-day1.md` | 리포트 출력물(생성물, 지워도 됨) |

---

# 3. 설치

```bash
cd ~/Develop/news/collector
cp .env.example .env          # 기계별로 한 번만 맞춘다

uv sync --extra local-embed   # 임베딩까지 (torch 포함, ~1GB)
# uv sync                     # 수집/필터/리포트만

uv run collector init-db
uv run collector sources sync
uv run collector doctor       # 첫 실행은 모델 709MB 다운로드로 오래 걸린다
```

`.env` 의 경로(`COLLECTOR_DB` 등)는 **비워두는 게 기본**이다. 비우면 `collector/` 기준 상대경로로 계산돼서
Mac 과 N100 이 같은 `.env` 를 쓸 수 있다. 절대경로를 넣으면 그 기계에서만 돈다.

---

# 4. 사용 (명령어)

| 명령 | 설명 |
|---|---|
| `collector init-db` | 스키마 생성(없으면). 매 실행 재적용이라 안전 |
| `collector sources sync` | `sources.yaml` → DB 반영. **`enabled` 포함** |
| `collector sources list [--enabled]` | 피드 목록 + 마지막 수집 시각 |
| `collector collect [--source REF] [--force] [--timeout N]` | 1회 수집. `--force` = Reddit 간격 무시 |
| `collector noise` | 노이즈 필터 (`status='new'` 만 검사) |
| `collector embed [--limit N] [--rebuild] [--purge]` | 임베딩 |
| `collector report [--hours 24] [--sim-sample 300] [--out FILE]` | 검증 지표 |
| `collector run [--interval 900] [--once]` | 수집→필터→임베딩 반복 (상시 실행) |
| `collector doctor` | DB/임베딩 백엔드 점검 |

수동으로 돌려보는 순서 (문제 확인할 때):

```bash
uv run collector collect --source IGN     # 피드 하나만
uv run collector noise
uv run collector embed --limit 10
uv run collector report --hours 2
```

`run` 은 임베딩 모델을 **루프 밖에서 한 번만 로드**해서 계속 재사용한다. 그래서 상시 실행이 가장 효율적이고,
CLI로 `embed` 를 반복 호출하면 매번 모델을 다시 로드한다(8초+).

---

# 5. 설정

### `config/sources.yaml`

```yaml
- name: Reddit r/Games (top/day)
  feed_url: https://www.reddit.com/r/Games/top/.rss?t=day&limit=50
  weight: 0.9
  lang: en
  user_agent: linux:news-collector:0.1 (by /u/실제계정)  # Reddit 은 필수. 가짜 /u/ 는 더 잘 막힌다
  impersonate: safari      # httpx TLS 지문은 차단됨 → curl_cffi 로 위장
  kind: community          # article | community
  enabled: true            # false 면 수집 대상에서 빠진다
```

- `enabled` 는 **yaml 이 기준**이다. `sources sync` 가 DB 에 반영하고, yaml 에서 사라진 피드도 자동으로 내린다.
- `kind: community`(Reddit)는 커뮤니티 반응이다. 리포트의 유사도 지표에서는 제외된다.

### `config/noise_rules.yaml`

```
1. allow_sources 에 있으면 무조건 보존
2. title_allow 패턴이 제목+요약에 걸리면 보존 (구제용)
3. title_deny 패턴이 **제목에** 걸리면 filtered
4. 아무것도 아니면 보존 (누락이 오탐보다 위험)
```

- **deny 는 제목만 본다.** 요약까지 보면 요약에 `movie` 한 단어만 있어도 게임 기사가 걸린다(실측 오탐).
- 코드 목록 글(`Genshin Impact codes (September 2026)`)은 제목 패턴으로 별도 처리한다.

### `.env`

| 변수 | 기본값 | 설명 |
|---|---|---|
| `COLLECTOR_DB` / `SOURCES_FILE` / `NOISE_RULES` | (비움) | 비우면 collector/ 기준 상대경로 |
| `COLLECT_INTERVAL` | `900` | run 주기(초) |
| `FETCH_TIMEOUT` | `20` | 피드 요청 타임아웃 |
| `NEWS_USER_AGENT` | 브라우저 UA | 기본 UA (Reddit 은 피드별 UA 사용) |
| `REDDIT_SLEEP` | `8` | Reddit 요청 사이 최소 간격(초). 인증 RSS 기준. 없으면 60초로 올린다 |
| `REDDIT_MIN_INTERVAL` | `3600` | Reddit 피드 재수집 최소 간격(초) |
| `REDDIT_COMMENT_POSTS` | `2` | 새 글 중 댓글을 받을 개수(소스당). 10 으로 올리면 한 사이클이 댓글에 묶인다 |
| `REDDIT_USER` / `REDDIT_FEED` | (비움) | `prefs/feeds` 의 `user=` / `feed=` . **모든 공개 .rss 에 붙는 인증 토큰**. upvoted 피드 자체를 소스로 쓰지 않는다 |
| `EMBED_PROVIDER` | `local` | `local`(내장) \| `openrouter` |
| `EMBED_LOCAL_MODEL` | `LiquidAI/LFM2.5-Embedding-350M` | HF repo id |
| `EMBED_DEVICE` | `cpu` | `cuda` / `mps` |
| `EMBED_DTYPE` | `bfloat16` | `float32`(빠름·2.4GB) \| `bfloat16`(느림·1.0GB) |
| `EMBED_PROMPT` | `document` | `document` \| `query` \| `none` |
| `EMBED_BATCH` | `32` | 배치 크기 |
| `EMBED_MAX_CHARS` | `400` | 임베딩에 넣는 요약 길이 |
| `EMBED_MODEL` | provider별 자동 | **DB 키**. provider 별로 다르다 |
| `EMBED_API_KEY` | (비움) | openrouter 전용. 없으면 `OPENROUTER_API_KEY` |
| `SIM_THRESHOLD` | `0.72` | 리포트에서 "같은 사건 후보" 기준 |

`.env` 는 `os.environ.setdefault` 로 읽는다 → **셸에 같은 이름이 이미 있으면 셸 값이 이긴다.**
(예: `OPENROUTER_API_KEY` 가 셸에 있으면 `.env` 값은 무시된다)

---

# 6. 임베딩 (동작 방식과 한계)

- 모델: `LiquidAI/LFM2.5-Embedding-350M` — 1024차원, CLS pooling, 512토큰, 파일 709MB
- **비대칭 프롬프트가 필수다.** 문서는 `document: `, 질의는 `query: `. 모델 설정의 `default_prompt_name` 이
  null 이라 `encode()` 가 자동으로 붙여주지 않는다 → 우리가 붙인다. 빼면 다른 사건이 거의 직교(0.05)해진다.
- 입력: `제목 + 요약 400자`. 자동 truncate 는 512토큰.
- 저장: L2 정규화한 float32 BLOB. 4KB/건.
- 로컬 실행 비용 (Apple M2, 64건 배치):

  | dtype | 속도 | peak RSS |
  |---|---|---|
  | `float32` | 24.6건/s | 2413 MB |
  | `bfloat16` | 9.0건/s | 1033 MB |

  4GB 장비는 `bfloat16`(기본). `float32` 는 빠르지만 OS 와 합치면 위험하다.
- 로컬과 OpenRouter 는 같은 가중치라 벡터가 사실상 같다(같은 쌍 0.967 vs 0.970). 그래도 DB 키는 provider 별로 다르다.
- 같은 사건 유사도 분포(실측, 교차 매체): 0.85~0.95 명백한 같은 사건 / 0.70~0.85 대부분 같은 사건 /
  **0.65 아래로 내려가면 무관한 쌍이 섞인다** → `SIM_THRESHOLD=0.72` 유지.
- 리포트의 유사도 지표는 **같은 매체 쌍을 제외**한다. 다른 매체가 같은 사건을 쓴 것을 보는 지표라서
  같은 매체끼리(4Gamer↔4Gamer) 비교는 신호가 아니다.
- 요약이 짧은 소스(Automaton 67자, PC Gamer 61자)도 커버리지 판단에는 충분하다(실측: Automaton 이 0.72+ 쌍 31개로 최다).
  부족한 건 "기사 재료"로서의 본문이지 묶기 판단이 아니다.

---

# 7. 운영 (관리)

### 일상 루틴

```bash
# 상시 실행 (systemd). 15분마다 수집→필터→임베딩
systemctl --user status collector-run.service

# 하루 1번
uv run collector report --hours 24 --out report-day1.md

# 주 1번
journalctl --user -u collector-run.service --since "7 days ago" | grep -E "WARNING|ERROR"
du -sh data/news.db
```

### 점검 지표 (리포트 기준)

| 축 | 봐야 할 것 | 정상 기준 |
|---|---|---|
| 수집 | 피드 성공률 | 90% 이상 (Reddit 429 는 별도) |
| 수집 | 신규/중복 비율 | 15분 주기에서 중복이 대부분인 게 정상 |
| 품질 | 노이즈 제외율 | 5~20%. 30% 넘으면 규칙이 과함 |
| 임베딩 | embedded 비율 | 95% 이상 |
| 묶임 | 유사도 0.72+ 교차매체 쌍 | 0일 수 있다(최근 몇 시간 안 겹쳤을 뿐). 0.60 아래 비율이 치솟으면 점검 |
| 운영 | 주기 실행 시간 | 3분 이내 (15분 주기 대비) |
| 운영 | failed 건수 | 0에 가까움 |

### 장애 대응

| 증상 | 확인 | 대응 |
|---|---|---|
| 특정 피드만 계속 실패 | `select name,last_error from sources where last_error is not null` | UA/주소 변경/TCP 차단. `enabled: false` 로 내린다 |
| Reddit 429 경고 | 서킷브레이커가 남은 Reddit 을 건너뜀 (다른 RSS 는 이미 끝난 상태) | `REDDIT_USER`/`REDDIT_FEED` 확인. 익명이면 1 req/min |
| embedded 비율이 안 오름 | `collector doctor` | 모델 로드 실패/디스크 부족/OOM 확인 |
| 프로세스가 죽거나 스왑 | `dmesg`, 메모리 | `EMBED_DTYPE=bfloat16`, `EMBED_BATCH` 내린다 |
| 임베딩이 400 으로 실패 | 로그의 `컨텍스트 초과` | 자동으로 배치 분할/입력 축소한다. 반복되면 `EMBED_MAX_CHARS` 내린다 |
| 차원/모델이 바뀜 | `select distinct model,dim from item_embeddings` | `embed --rebuild --purge` |
| 노이즈 오탐/누락 | `select noise_reason,title from raw_items where status='filtered'` | 규칙 수정 → `collector noise`. 단, **이미 filtered 는 자동으로 안 돌아온다** |

### 데이터 관리

- `raw_items` 는 **append-only**. 기존 행의 내용을 고치지 않는다. 지우지도 않는다.
- 보관 정책(오래된 것 삭제)은 아직 없다. 늘어나는 속도: 하루 300~500건, 벡터 4KB/건.
- 특정 모델 벡터만 지우기: `collector embed --purge` (다른 모델 벡터 삭제).
- **백업**: WAL 모드라 파일만 복사하면 깨질 수 있다. 서비스를 멈추거나:
  ```bash
  sqlite3 data/news.db ".backup '/tmp/news-$(date +%F).db'"
  ```
- **이관**(Mac↔N100): `data/news.db` + `config/` + `.env` 만 옮기면 된다. 모델 캐시(709MB)는 다시 받으면 된다.
- 오프라인 실행: 모델을 이미 받았다면 `HF_HUB_OFFLINE=1` 로 네트워크 접근을 막을 수 있다.
- 이 디렉터리는 **git 저장소가 아니다.** 백업이 유일한 안전망이다.

### 로그

```bash
journalctl --user -u collector-run.service -f          # 실시간
journalctl --user -u collector-run.service --since today
docker logs -f collector                                # docker 배포 시
```

---

# 8. 유지보수 절차

### A. 소스 추가

```yaml
# config/sources.yaml 에 추가
- name: 새 매체
  feed_url: https://example.com/feed
  weight: 1.0
  lang: en
```

```bash
uv run collector sources sync
uv run collector collect --source "새 매체"     # 실제로 뭐가 들어오는지 본다
uv run collector noise && uv run collector embed --limit 20
```

### B. 소스 중단 (삭제하지 않는다)

`enabled: false` 로 바꾸고 `sources sync`. 과거 수집 데이터는 그대로 남는다.

### C. 노이즈 규칙 수정

1. `config/noise_rules.yaml` 수정 (deny 는 제목만 본다는 것 명심)
2. `uv run collector noise` — `status='new'` 만 재검사한다
3. 오탐 확인 (이미 filtered 된 것 포함해서):
   ```sql
   select noise_reason, count(*) from raw_items where status='filtered' group by 1;
   ```
4. 잘못 걸린 것을 되살리려면 상태를 되돌린다(예외적 조작):
   ```sql
   update raw_items set status='new', noise_reason=NULL where id in (...);
   ```

### D. 임베딩 모델 교체

```bash
# .env 에서 EMBED_PROVIDER / EMBED_MODEL / EMBED_PROMPT 수정
uv run collector embed --rebuild --purge     # 새 모델로 전체 재임베딩 + 옛 벡터 삭제
uv run collector report --hours 24           # 분포를 보고 SIM_THRESHOLD 재보정
```

`--rebuild` 는 `status='embedded'` 인데 새 모델 벡터가 없는 항목만 큐로 되돌린다(노이즈 판단은 유지).
재임베딩 시간: 로컬 CPU 로 745건 165초(float32, M2).

### E. 스키마 변경

`schema.sql` 은 매 실행 재적용되지만 `IF NOT EXISTS` 라 **기존 테이블은 안 바뀐다.**
컬럼 추가/변경은 별도 `ALTER TABLE` 이 필요하고, collector 와 writer 가 공유하는 파일이므로 신중히 한다.

---

# 9. 실측으로 확인된 함정 (고치면서 얻은 기록)

| 함정 | 대응 |
|---|---|
| Eurogamer 등 봇 UA 차단 | 기본 UA = 브라우저 UA |
| **Eurogamer 는 TCP reset** (UA·지문 무관) | `sources.yaml` 에서 `enabled: false` |
| **Reddit 이 httpx 의 TLS 지문을 차단** (403/429) | 피드별 `impersonate: safari` → curl_cffi |
| **Reddit 공식 API 신규 앱 불가** (Responsible Builder Policy) | 쓰지 않는다. 인증 RSS 만 |
| **익명 RSS 는 IP 당 1 req/min** (첫 요청만 200, 이후 429) | `.env` 의 `REDDIT_USER`/`REDDIT_FEED` 를 모든 공개 `.rss` 에 붙인다 |
| upvoted.rss 에 게임 글이 없다 | 그 URL 의 `user=`/`feed=` 만 복사해서 r/Games 같은 공개 피드에 쓴다 |
| Reddit 댓글 10개를 피드 fetch 안에서 동기 수집 | 소스당 2개 + 전역 게이트. 429 나면 그 사이클 Reddit 중단 |
| Reddit 429 가 4Gamer 등 하위 RSS 를 막음 | 일반 RSS 를 먼저 돌리고 Reddit 은 맨 뒤 |
| Reddit 은 브라우저 UA 를 오히려 429 | 피드별 정중한 전용 UA. `/u/` 는 실제 계정 |
| **같은 제목을 새 URL 로 계속 발행하는 피드** (Steam News 의 `Team Fortress 2 Update Released`) | 같은 소스 + 같은 제목이면 건너뛴다 |
| **`content:encoded` 에 본문을 넣는 피드** (IGN 43자 teaser vs 본문 2774자) | summary 와 content 중 긴 쪽을 쓴다 |
| 노이즈 deny 가 요약까지 봐서 오탐 | deny 는 제목만. 코드 목록 글은 제목 패턴으로 보강 |
| **LFM2.5 는 512토큰 초과를 절단하지 않고 400 으로 거절** | 배치 분할 → 단건 축소 재시도 |
| **transformers 5.x 와 모델 커스텀 코드 비호환** (`seq_idx`) | `transformers>=4.56,<5` 고정 |
| Linux 에서 torch 기본 설치 = CUDA 로 2GB+ | pyproject 에서 CPU 휠 인덱스(Linux 한정) |
| OpenRouter free 모델은 몰아치면 429 (Retry-After 없음) | 요청 간격 + 지수 백오프 |

---

# 10. 배포

### systemd (도커 없이 — N100 권장)

```bash
cp systemd/collector-run.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now collector-run.service
```

유닛은 `WorkingDirectory=%h/Develop/news/collector` 를 전제로 한다. 경로가 다르면 수정할 것.

### docker compose

```bash
cp .env.example .env
docker compose up -d --build      # 이미지에 torch 포함(수 GB)
```

모델은 `./data/hf-cache` 에 캐시된다(볼륨에 남아 재생성해도 다시 안 받는다).

N100 메모리 참고: **4GB 장비는 `EMBED_DTYPE=bfloat16`(기본)**. float32 는 peak 2.4GB 로 위험하다.

---

# 11. 테스트

```bash
uv run pytest
```

테스트는 네트워크를 쓰지 않는다(가짜 HTTP 응답 + `httpx.MockTransport` + 가짜 임베더).
커버: 수집/중복/제목중복/content:encoded 선택, URL 정규화, 노이즈 규칙, sources sync,
임베딩 백엔드(프롬프트·429 백오프·토큰초과 분할), 재임베딩/purge, 유사도 표본.
