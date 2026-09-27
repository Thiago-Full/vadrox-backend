FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Instala a versão nightly do yt-dlp com todas as dependências e o plugin bgutil
RUN pip3 install --break-system-packages --upgrade \
    "yt-dlp[default] @ https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz" \
    bgutil-ytdlp-pot-provider

# Clona e compila o PROVIDER HTTP (servidor Node.js que gera os tokens)
WORKDIR /opt
RUN git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    && cd bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

# Instala o backend Vadrox
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]