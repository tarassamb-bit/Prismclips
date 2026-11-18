# Relio live watcher: Node 24, ffmpeg (with libass for captions), whisper.cpp for word-exact captions, the caption font and the
# app's watermark frames; serves finished Shorts on port 8080.
FROM node:24-bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /src/build -j --config Release --target whisper-cli
ADD https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin /models/ggml-base.bin

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper --chmod=644 /models/ggml-base.bin /opt/whisper/ggml-base.bin
ADD --chmod=644 https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf /usr/share/fonts/truetype/montserrat/Montserrat-ExtraBold.ttf
WORKDIR /opt/watcher
COPY watcher.mjs shorts.mjs package.json ./
COPY wm ./wm
COPY lib ./lib
USER node
EXPOSE 8080
CMD ["node", "watcher.mjs"]
