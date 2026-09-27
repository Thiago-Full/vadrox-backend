FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Força a instalação da versão mais recente (nightly) do yt-dlp e do plugin
RUN pip3 install --break-system-packages --upgrade \
    "git+https://github.com/yt-dlp/yt-dlp.git@master" \
    bgutil-ytdlp-pot-provider

WORKDIR /opt
RUN git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    && cd bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]