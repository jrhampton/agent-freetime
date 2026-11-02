FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
# Chromium for the agents' browsers (matches the playwright-core version in package.json).
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*
# Software abilities can't be installed from the UI inside a container. List the Debian packages
# to bake in instead, e.g. --build-arg FREETIME_APPS="stockfish frotz lilypond blender".
ARG FREETIME_APPS=""
RUN if [ -n "$FREETIME_APPS" ]; then apt-get update && apt-get install -y --no-install-recommends $FREETIME_APPS && rm -rf /var/lib/apt/lists/*; fi
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
