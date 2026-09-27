# Usa imagem oficial do yt-dlp com PO Token Provider
FROM ghcr.io/jim60105/yt-dlp:pot

# Instala Node.js 22
RUN apk add --no-cache nodejs npm

# Instala dependências do backend
WORKDIR /app
COPY package*.json ./
RUN npm install

# Copia código e inicia
COPY . .
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]