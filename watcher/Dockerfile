# Relio live watcher: Node 24, ffmpeg (with libass for captions) and a bold font; serves finished Shorts on port 8080.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/watcher
COPY watcher.mjs shorts.mjs package.json logo.png ./
COPY lib ./lib
USER node
EXPOSE 8080
CMD ["node", "watcher.mjs"]
