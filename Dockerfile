FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]