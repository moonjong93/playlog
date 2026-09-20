2026-09-20 18:38:01 | ISSUE=writer | 모델 확정: bench로 ling→gemma-4-26b 검토 후 openai/gpt-5.6-luna로 결정 (write 24케이스: luna 한자누출 3 vs gemma 5, 2.6s vs 4.7s, 톤 일관). WRITER_MODEL=luna, batch는 비동기 전용이라 미사용
2026-09-20 18:38:01 | ISSUE=writer | prompts.yaml: 한자·가나 금지, 제목 큰따옴표 금지(JSON 깨짐 해결), lede "꼭 3줄" 해제, 본문 문장수 강제 해제 + 소프트 하한("한 문장으로 끝내지 마라")
2026-09-20 18:38:01 | ISSUE=writer | bench.py: enforce_keep_title(제목을 영어 원문으로 덮어쓰던 것) 제거 → missing_terms(플래그 전용), find_cjk_leaks 추가, 리포트에 한자누출/원제누락 플래그 + lede 표시
2026-09-20 18:38:01 | ISSUE=writer | pipeline/assign: 제목만 있는 소스(요약·본문 없음) skip (has_body_material + should_write + 쓰기 가드). publish.py: lede/본문 literal \n 정규화
2026-09-20 18:38:01 | ISSUE=writer | 문서·기본값: README·.env.example·settings.py·bench.py 기본 모델 luna로 현행화, BENCH_MODELS에서 매번 실패하는 glm-5.3-flash 제거. 테스트 57개 통과
2026-09-20 18:38:01 | ISSUE=writer | E2E 확인(gemma 시점): cluster→write→articles+md→웹 ingest 201(section 저장), 제목만 4편 자동 skip. luna는 아직 실제 발행 미실행
2026-09-20 18:38:01 | ISSUE=collector | 4Gamer 피드가 일부 항목 description을 빈 채로 발행(소스측, 100개 중 1~12%). 콜렉터 파싱은 정상 — writer의 제목만 skip으로 처리. 고칠 것 없음
2026-09-20 18:38:01 | ISSUE=writer | 위키 ja→ko 로컬 덤프(page+langlinks 366MB) 보류: luna가 새는 건 한국어 위키 문서가 없는 희귀 고유명사(ファレイドリア 등)라 ROI 낮음. 한자누출 플래그로 감시하다 필요 시 소사전
2026-09-20 18:38:01 | ISSUE=writer | 남은 것: section enum 조정(사용자 예정), luna 실제 발행 1편 미확인. 이 디렉터리는 git 아님 → 백업이 유일 안전망
