#!/bin/sh
set -e

echo "🚀 Preparando cookies em local gravável..."
if [ -f /etc/secrets/cookies.txt ]; then
  cp /etc/secrets/cookies.txt /tmp/cookies.txt
  echo "✅ cookies.txt copiado pra /tmp/"
  wc -l /tmp/cookies.txt
else
  echo "⚠️  /etc/secrets/cookies.txt NÃO EXISTE — cookie vai faltar"
fi

echo "🚀 Iniciando PO Token Provider (porta 4416)..."
cd /opt/bgutil-ytdlp-pot-provider/server
node build/main.js --port 4416 &
POT_PID=$!
sleep 5
echo "✅ PO Token Provider rodando (PID $POT_PID)"

echo "🚀 Iniciando servidor Vadrox..."
cd /app
npx tsx server.ts