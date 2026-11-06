# Node 22: Bro's own brain (node-llama-cpp) needs Node 20+, and every test runs on 22
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates bash ffmpeg openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy everything first so postinstall script is available
COPY . .

# Bro's CPU voice uses onnxruntime-node; never fetch its CUDA binaries from GitHub (we run on CPU)
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# Bro's own brain runs llama.cpp's prebuilt CPU build: never download or compile one at install time
ENV NODE_LLAMA_CPP_SKIP_DOWNLOAD=true

# Install deps (v34: no postinstall download: the old summary audio release is gone; audio-static/ is in git)
RUN npm install --production \
    && rm -rf node_modules/@node-llama-cpp/linux-x64-cuda node_modules/@node-llama-cpp/linux-x64-cuda-ext \
              node_modules/@node-llama-cpp/linux-x64-vulkan node_modules/@node-llama-cpp/linux-arm64 node_modules/@node-llama-cpp/linux-armv7l

EXPOSE 3000

CMD ["node", "server.js"]
