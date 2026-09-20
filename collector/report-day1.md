# collector 리포트 — 2026-09-18 01:15 UTC (최근 24시간)

## 1. 저장 현황
- sources: **21**
- raw_items: **1,108**
- source_fetches: **78**
- item_embeddings: **1,080**
- DB 크기: 7.6 MB

## 2. raw_items 상태 (writer 관점)
- embedded: 1,080
- filtered: 28
- **writer 에 넘길 수 있는 건수(embedded): 1,080 / 1,108 (97.5%)**

## 3. 수집 (최근 24시간)
- 실행 78회 → 신규 1,108건 / 중복 925건 / 수집항목 2,033건
- 실패 3회 (성공률 96%)

### 피드별 (최근 24시간)
- 4Gamer: 신규 180 / 실행 4 / 마지막 2026-09-18T00:28:10Z
- Rock Paper Shotgun: 신규 108 / 실행 4 / 마지막 2026-09-18T00:28:07Z
- VG247: 신규 100 / 실행 4 / 마지막 2026-09-18T00:28:07Z
- PCGamesN: 신규 85 / 실행 4 / 마지막 2026-09-18T00:28:08Z
- Automaton: 신규 80 / 실행 4 / 마지막 2026-09-18T00:27:02Z
- Reddit r/gaming (top/day): 신규 80 / 실행 2 / 마지막 2026-09-18T00:28:11Z
- PC Gamer: 신규 75 / 실행 4 / 마지막 2026-09-18T00:26:54Z
- Reddit r/Games (top/day): 신규 59 / 실행 2 / 마지막 2026-09-18T00:27:03Z
- Reddit r/pcgaming (top/day): 신규 43 / 실행 2 / 마지막 2026-09-18T00:30:04Z
- Gematsu: 신규 40 / 실행 4 / 마지막 2026-09-18T00:26:59Z
- Push Square: 신규 40 / 실행 4 / 마지막 2026-09-18T00:27:01Z
- IGN: 신규 38 / 실행 4 / 마지막 2026-09-18T00:26:55Z
- Nintendo Life: 신규 35 / 실행 4 / 마지막 2026-09-18T00:28:09Z
- GameSpot: 신규 30 / 실행 4 / 마지막 2026-09-18T00:26:56Z
- Siliconera: 신규 23 / 실행 4 / 마지막 2026-09-18T00:27:00Z
- Xbox Wire: 신규 20 / 실행 4 / 마지막 2026-09-18T00:26:53Z
- Steam News: 신규 20 / 실행 5 / 마지막 2026-09-18T00:59:06Z
- Nintendo Everything: 신규 20 / 실행 4 / 마지막 2026-09-18T00:28:06Z
- Polygon: 신규 20 / 실행 4 / 마지막 2026-09-18T00:26:57Z
- PlayStation Blog: 신규 12 / 실행 4 / 마지막 2026-09-18T00:26:51Z

## 4. 노이즈 필터
- 제외 28건 (2.5%)
  - 영화·TV (게임 무관): 14
  - 리딤코드·쿠폰: 6
  - 단순 할인·딜: 6
  - 리딤코드 목록: 2

## 5. 분포
### 언어
- en: 848
- ja: 260
### kind
- article: 926
- community: 182
### 커뮤니티 댓글 저장된 글
- 8건

### 요약(본문 대체) 커버리지
- RSS 요약 보유 1,084건 (98%) / 평균 344자 · 최대 4,001자
- 요약이 4000자 상한에 걸려 잘린 건 15건
- 본문(content) 보유 8건 — 지금은 Reddit 댓글 전용이다. **기사 본문은 수집하지 않는다**
### 소스별 평균 요약 길이
- GameSpot: 2397자 (n=30)
- Steam News: 1464자 (n=20)
- Reddit r/gaming (top/day): 606자 (n=80)
- Rock Paper Shotgun: 567자 (n=108)
- Nintendo Life: 491자 (n=35)
- Nintendo Everything: 484자 (n=20)
- Push Square: 399자 (n=40)
- Xbox Wire: 385자 (n=20)
- PlayStation Blog: 339자 (n=12)
- VG247: 270자 (n=100)
- Reddit r/pcgaming (top/day): 242자 (n=43)
- Reddit r/Games (top/day): 234자 (n=59)
- PCGamesN: 137자 (n=85)
- Polygon: 126자 (n=20)
- 4Gamer: 121자 (n=180)
- IGN: 114자 (n=38)
- Siliconera: 107자 (n=23)
- Gematsu: 99자 (n=40)
- Automaton: 67자 (n=80)
- PC Gamer: 60자 (n=75)

## 6. 임베딩 + 같은 사건 묶임 품질
- 임베딩 1,080건 (dim=1024, model=lfm2.5-embedding-350m)
- 표본 300건 / 35,745쌍 (같은 매체 쌍 제외) 유사도 분포:
  - 0.85+: 1 (0.0%)
  - 0.72-0.85: 20 (0.1%)
  - 0.60-0.72: 34 (0.1%)
  - 0.50-0.60: 59 (0.2%)
  - <0.50: 35,631 (99.7%)
- 가장 유사한 쌍 (같은 사건일 가능성):
  - 0.897 │ [Nintendo Everything] The Rogue Prince of Persia “Anniversary” upd ║ [Gematsu] The Rogue Prince of Persia ‘Anniversary’ upd
  - 0.827 │ [4Gamer] Serenity Forgeの最新作「Faraday Blues」が2027年にリリース ║ [Automaton] 『ドキドキ文芸部!』のアーティストが放つ新作『Faraday Blues』発表。“両親の
  - 0.811 │ [Siliconera] TGS 2026 Persona 4 Revival Trailer Focuses o ║ [Gematsu] Persona 4 Revival – Naoto Shirogane trailer
  - 0.809 │ [Gematsu] PHYSINT lead to be portrayed by Bill Skarsga ║ [Xbox Wire] Tokyo Game Show 2026: Bill Skarsgård Cast as
  - 0.805 │ [Gematsu] Shape of Dreams now available for PS5, Xbox  ║ [PlayStation Blog] Co-op roguelite Shape of Dreams launches tod
  - 0.797 │ [Rock Paper Shotgun] Twitch CEO expects GTA 6 online multiplayer  ║ [PC Gamer] Twitch CEO says GTA 6 multiplayer will launc
  - 0.793 │ [Push Square] Lollipop Chainsaw 2 Officially Announced for ║ [Siliconera] Lollipop Chainsaw 2 Back2Back Coming to PS5 
  - 0.781 │ [Xbox Wire] Action Roguelite Shape of Dreams Launches on ║ [PlayStation Blog] Co-op roguelite Shape of Dreams launches tod
  → 0.72 이상 쌍이 writer 가 실제로 묶을 후보

## 7. 최근 수집 샘플 (embedded 우선 20건)
- [Reddit r/pcgaming (top/day)] Art of Ism - new visual novel on Steam  `embedded`
- [Reddit r/pcgaming (top/day)] I’ve poured my heart and creativity into this strategic PC JRPG, Chronicles of  `embedded`
- [Reddit r/pcgaming (top/day)] Train Sim World 7 - Launch Trailer  `embedded`
- [Reddit r/pcgaming (top/day)] Glitch Protocol launches on Steam on September 18 — a 200-room precision platf  `embedded`
- [Reddit r/pcgaming (top/day)] Scholar Adventure returns with Lost Night! First trailer and Steam page now li  `embedded`
- [Reddit r/pcgaming (top/day)] Genigods: Nezha - Deep Dive  `embedded`
- [Reddit r/pcgaming (top/day)] The Guild 1 Remake: Europa 1410 - Early Access for Europa 1410 Now Available  `embedded`
- [Reddit r/pcgaming (top/day)] Lollipop Chainsaw 2 Back2Back - TGS 8 Minutes Gameplay  `embedded`
- [Reddit r/pcgaming (top/day)] Dragon Slayer: The Legend Of Heroes I & II Pack Releasing Worldwide; Coming To  `embedded`
- [Reddit r/pcgaming (top/day)] Gears of War: E-Day Has Gone Gold, Pre-Install Begins September 29, Full PC Sp  `embedded`
- [Reddit r/pcgaming (top/day)] The Rogue Prince of Persia - The Anniversary Update is Out Now!  `embedded`
- [Reddit r/pcgaming (top/day)] ZERO PARADES: Director's Cut - PC & PS5 Announcement Trailer  `embedded`
- [Reddit r/pcgaming (top/day)] Center Ice Hockey on Steam. Almost ready.  `embedded`
- [Reddit r/pcgaming (top/day)] ENDLESS Legend 2 - 1.0 Out Now!  `embedded`
- [Reddit r/pcgaming (top/day)] Video Games Europe warns against sweeping restrictions proposed in the EU KIDS  `embedded`
- [Reddit r/pcgaming (top/day)] Clive Barker's Hellraiser: Revival Demo is Now Available on Steam  `embedded`
- [Reddit r/pcgaming (top/day)] CONTROL Resonant - Launch Trailer  `embedded`
- [Reddit r/pcgaming (top/day)] Bungie Denies Rumor It Plans to Merge the Destiny and Marathon IPs, Confirms M  `embedded`
- [Reddit r/pcgaming (top/day)] FF13NovaFix : Fan-Made Patch Addresses Longstanding Final Fantasy XIII Trilogy  `embedded`
- [Reddit r/pcgaming (top/day)] Hideo Kojima Reveals Lead Cast Member for PHYSINT  `embedded`
