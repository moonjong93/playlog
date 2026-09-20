# web 배포용 이미지 (개인 서버 + Cloudflare Tunnel)
#
#   docker compose up -d --build
#
# better-sqlite3 는 네이티브 모듈이라 빌드 도구(python3/make/g++)를 넣는다.
# prebuild 바이너리가 있으면 안 쓰이지만, 없을 때 node-gyp 이 깨지는 편이 더 아프다.

FROM node:24-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# NODE_ENV=production 은 설정하지 않는다. 그러면 npm ci 가 devDependencies
# (tsx, tailwindcss)를 빼버려서 `npm start` 와 CSS 빌드가 그대로 깨진다.

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# dist/ 는 커밋하지 않으므로(.gitignore/.dockerignore) 이미지 안에서 CSS 와
# htmx 를 만들어야 한다. 이 단계가 없으면 스타일 없는 페이지가 뜨고
# /assets/htmx.min.js 가 404 가 된다. (prestart 에도 같은 단계가 있다)
RUN npm run css && npm run assets

# node 이미지에 기본 포함된 비루트 사용자(node, uid 1000)로 실행한다.
# prestart 가 dist/app.css 를 다시 쓰고 SQLite 가 data/ 에 쓰므로 /app 권한을 준다.
# data/ 는 compose 가 호스트 디렉터리를 마운트한다.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787

CMD ["npm", "start"]
