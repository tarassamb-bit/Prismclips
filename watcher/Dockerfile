# Relio live watcher: Node 24, ffmpeg (with libass for captions) and the caption font; serves finished Shorts on port 8080.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ADD --chmod=644 https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf /usr/share/fonts/truetype/montserrat/Montserrat-ExtraBold.ttf
WORKDIR /opt/watcher
COPY watcher.mjs shorts.mjs package.json ./
COPY wm ./wm
COPY lib ./lib
USER node
EXPOSE 8080
CMD ["node", "watcher.mjs"]
