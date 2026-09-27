FROM node:22-slim

# Instala Python + pip + ffmpeg (yt-dlp precisa)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instala yt-dlp globalmente
RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app

# Copia arquivos de dependência
COPY package*.json ./

# Instala dependências Node
RUN npm install

# Copia o restante do código
COPY . .

# Render injeta PORT via env var
EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]