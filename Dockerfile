FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Fetch audio assets if not already present
RUN bash scripts/fetch-audio.sh || true

EXPOSE 3000

CMD ["node", "server.js"]
