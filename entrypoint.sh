#!/bin/sh
set -e

echo "🚀 Iniciando PO Token Provider..."
node /app/node_modules/bgutil-ytdlp-pot-provider/server/build/main.js &
POT_PID=$!

# Aguarda o provider subir
sleep 5

echo "🚀 Iniciando servidor Vadrox..."
npx tsx server.ts

# Se o servidor morrer, mata o provider também
kill $POT_PID 2>/dev/null || true