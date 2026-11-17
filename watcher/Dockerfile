# Relio live watcher: Node 24 and ffmpeg, no HTTP service. Build context is this folder (see build.sh).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/watcher
COPY watcher.mjs package.json ./
COPY lib ./lib
USER node
CMD ["node", "watcher.mjs"]
