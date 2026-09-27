#!/bin/sh
set -e

echo "🚀 Iniciando PO Token Provider (porta 4416)..."
cd /opt/bgutil-ytdlp-pot-provider/server
node build/main.js --port 4416 &
POT_PID=$!
sleep 5
echo "✅ PO Token Provider rodando (PID $POT_PID)"

echo "🚀 Iniciando servidor Vadrox..."
cd /app
npx tsx server.ts