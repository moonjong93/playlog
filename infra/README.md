# infra — app LXC 배포/운영

playlog 와 앞으로 추가될 공개 서비스들을 **도커로 띄우는 배포 골격**이다.
dev LXC(개발)와 분리된 `app` / `ai` 두 LXC 구성 중 `app` 쪽을 담당한다.

```
인터넷 → Cloudflare Tunnel → [app LXC]
                              ├─ cloudflared          (컨테이너)
                              ├─ news-web             (컨테이너 8787, loopback 만 개방)
                              ├─ service2             (컨테이너, 템플릿)
                              ├─ collector / writer   (네이티브 systemd + uv)
                              └─ SQLite               (compose/data/<service>/)
                                          │ 내부망
                                          ▼
                                        [ai LXC]  embed 8000 / laya 8080 (내부 전용)
```

## 원칙

- **공개 포트를 열지 않는다.** 외부 유입은 cloudflared(같은 docker 네트워크)뿐이다.
  단 writer(네이티브)가 발행할 수 있게 `127.0.0.1:8787` loopback 만 연다.
- 서비스마다 `.env`(600)·볼륨·컨테이너를 분리한다.
- collector/writer 는 news.db 를 직접 쓰므로 도커 없이 네이티브(systemd --user)로 돌린다.
- 생성(글쓰기)은 OpenRouter, 로컬은 임베딩과 Laya 만 (ai LXC).

## 릴리즈 순서

### A. 사용자가 할 것 (Proxmox / Cloudflare)

1. **app LXC 생성** — nesting 이 필수다.

   ```bash
   pct create <VMID> local:vztmpl/debian-13-standard_<버전>.tar.zst \
     --hostname app --cores 4 --memory 8192 --swap 1024 \
     --rootfs local-lvm:60 \
     --net0 name=eth0,bridge=vmbr0,ip=<고정IP>/24,gw=<게이트웨이>,firewall=1 \
     --features nesting=1,keyctl=1 --unprivileged 1 --onboot 1
   pct start <VMID>
   ```

2. **Cloudflare Tunnel 생성** (로컬 관리형)

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create playlog
   cloudflared tunnel route dns playlog news.nevra.app
   # 두 번째 서비스 도메인도 같은 방식으로
   ```

   생성된 `<TUNNEL-ID>.json` 을 dev 로 가져와 `infra/cloudflared/` 에 둔다.

3. **기존 데이터 이전 여부 결정** — 이전하려면 D 절차.

### B. dev 에서 (에이전트)

1. `infra/env/news-web.env`, `infra/env/collector.env`, `infra/env/writer.env` 채우기(시크릿).
2. `infra/cloudflared/config.yml` 작성(터널 ID/도메인).
3. 커밋·푸시 (app 은 GitHub 에서 클론).
4. `infra/scripts/preflight.sh` 로 점검.

### C. app LXC 안에서

```bash
apt-get update && apt-get install -y docker.io docker-compose-v2 git sqlite3
usermod -aG docker "$USER" && su - "$USER"          # 재로그인

git clone <repo> ~/playlog && cd ~/playlog
curl -LsSf https://astral.sh/uv/install.sh | sh

# 시크릿 (dev 에서 scp)
#   infra/env/news-web.env → ~/playlog/infra/env/
#   infra/env/collector.env → ~/playlog/collector/.env
#   infra/env/writer.env    → ~/playlog/writer/.env
#   infra/cloudflared/config.yml + <TUNNEL-ID>.json → ~/playlog/infra/cloudflared/

mkdir -p infra/compose/data/news-web && sudo chown -R 1000:1000 infra/compose/data/news-web
infra/scripts/preflight.sh

# 앱 의존성 + DB
cd collector && uv sync && uv run collector init-db && uv run collector sources sync && cd ..
cd writer    && uv sync && uv run writer init-db && cd ..

# 공개 서비스
infra/scripts/build.sh
docker compose -f infra/compose/docker-compose.yml up -d

# 상시 수집/발행
mkdir -p ~/.config/systemd/user
cp infra/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now collector-run.service writer-run.service
loginctl enable-linger "$USER"                       # 로그아웃해도 유지
```

### D. 기존 데이터 이전 (선택)

```bash
# dev 에서 (WAL 안전 백업)
infra/scripts/backup.sh /tmp/export
scp /tmp/export/*.gz <app>:/tmp/

# app 에서
gunzip -c /tmp/export/*collector*news.db.gz > ~/playlog/collector/data/news.db
gunzip -c /tmp/export/*news-web*web.db.gz   > ~/playlog/infra/compose/data/news-web/web.db
sudo chown 1000:1000 ~/playlog/infra/compose/data/news-web/web.db
```

### E. 스모크

```bash
docker compose -f infra/compose/docker-compose.yml ps
curl -sI http://127.0.0.1:8787/ | head -1          # 200
curl -s  https://news.nevra.app/ | head -3          # 터널 경유
systemctl --user status collector-run.service writer-run.service
```

## 운영

```bash
docker compose -f infra/compose/docker-compose.yml logs -f cloudflared
docker compose -f infra/compose/docker-compose.yml up -d --build news-web
infra/scripts/backup.sh /var/backups/infra          # SQLite .backup + 7일 보관
```

- **시크릿 회전**: `WEB_API_KEY` 를 바꾸면 writer `.env` 도 같이 바꿔야 발행이 안 끊긴다.
- **금지**: compose 에 공개 `ports:` 추가(loopback 제외), ai LXC 포트 개방.

## 다음 단계 (ai LXC, 필요 시점)

`infra/ai/README.md` 참고. Laya PoC/로컬 임베딩 전환 때 생성한다.
전환은 `.env` 의 `EMBED_BASE_URL=http://<ai-IP>:8000/v1` + `EMBED_MODEL` 키만 바꾸면 된다.
