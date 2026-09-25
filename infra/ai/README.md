# ai LXC — 임베딩(RAG) + Laya

공개 서비스와 분리된 **내부 전용** LXC. 정확히 두 서비스만 둔다(Ollama 등 대형 LLM 없음).

| 서비스 | 모델 | 포트 | 상주 RAM |
|---|---|---|---|
| embed | LiquidAI/LFM2.5-Embedding-350M (collector와 같은 가중치) | 8000 | 1.0~1.3GB (bfloat16) |
| laya | convaiinnovations/laya-multilingual (322M) | 8080 | 0.7GB |

생성(글쓰기)은 OpenRouter 가 담당하고, 이 LXC 는 **판정/검색 전용**이다.

## 준비 (호스트)

```bash
pct create <VMID> local:vztmpl/debian-13-standard_<버전>.tar.zst \
  --hostname ai --cores 4 --memory 4096 --swap 1024 \
  --rootfs local-lvm:30 \
  --net0 name=eth0,bridge=vmbr0,ip=<고정IP>/24,gw=<게이트웨이>,firewall=1 \
  --unprivileged 1 --onboot 1
```

- **포트 개방 금지.** Proxmox 방화벽으로 app LXC IP 에서만 8000/8080 허용.
- GPU 패스스루 불필요(322M/350M CPU 추론).

## embed (RAG)

- 서버: sentence-transformers 래퍼 + FastAPI. `collector/src/collector/embed.py` 의
  `LocalEmbedder` 프롬프트 규칙(`document: `)을 그대로 재사용한다.
- OpenAI 호환 `/v1/embeddings` 로 서빙 → collector/writer 는 `EMBED_PROVIDER=openrouter`,
  `EMBED_BASE_URL=http://<ai-IP>:8000/v1`, `EMBED_API_KEY=dummy`, `EMBED_MODEL=lfm2.5-embedding-350m`
  로 전환(코드 수정 없음). 로컬 전환 시 `embed --rebuild --purge` 로 벡터를 새로 만든다.
- llama.cpp/TEI 는 LFM2 커스텀 arch 지원이 불확실해 쓰지 않는다.

## laya

```bash
pip install laya
```

- 판정 질문: 같은 사건인가(`noul`) / 관계 followup·related·무관(`choice`) / 재료 게이트(`noul`) /
  태그 선택(`choice`, 20개 이하).
- writer 는 `judge.py` 인터페이스로 붙인다(예정). 그 전까지는 OpenRouter 저가 모델이 판정하고,
  그 로그가 Laya 학습/캘리브레이션 데이터가 된다.
- 주의: base 체크포인트는 zero-shot 이 약하고 확률이 과신이다(모델 카드). 도입 전 자체 라벨로
  캘리브레이션 → 고확신 구간만 자동 판정, 나머지는 LLM/사람.
