// server.ts
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const app = Fastify({ logger: true });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

async function callOpenRouter(systemPrompt: string, messages: any[]) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGroq(systemPrompt: string, messages: any[]) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function init() {
  await app.register(replyFrom);

  async function resolveAudioUrl(id: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'yt-dlp',
        [
          '-g',
          '-f', 'bestaudio[ext=m4a]',
          '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
          '--extractor-args', 'youtube:player_client=default,web_safari,tv',
          '--remote-components', 'ejs:github',
          '--no-warnings',
          `https://music.youtube.com/watch?v=${id}`,
        ],
        { timeout: 30000 },
      );
      const url = stdout.trim().split('\n').filter(Boolean)[0];
      return url || null;
    } catch (e: any) {
      console.error('=== YTDLP STREAM ERRO ===');
      console.error('Stderr:', e?.stderr);
      console.error('========================');
      return null;
    }
  }

  async function searchTracks(query: string, limit = 3) {
    try {
      const { stdout } = await execFileAsync(
        'yt-dlp',
        [
          `ytsearch${limit + 5}:${query}`,
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
        ],
        { timeout: 30000, maxBuffer: 20 * 1024 * 1024 },
      );
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const d = JSON.parse(line);
          return {
            id: d.id,
            title: d.title,
            artist: d.uploader ?? d.channel ?? 'Unknown',
            artwork: d.thumbnails?.[0]?.url ?? null,
            duration: d.duration ?? 0,
          };
        });
    } catch (e: any) {
      console.error('=== SEARCH TRACKS ERRO ===');
      console.error('Stderr:', e?.stderr);
      console.error('==========================');
      return [];
    }
  }

  app.route({
    method: ['GET', 'HEAD'],
    url: '/health',
    handler: async () => ({ status: 'ok', timestamp: Date.now() }),
  });

  // ─── TUNNEL URL (auto-discovery) ───
  let tunnelUrl: string | null = null;
  const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'vadrox-secret';

  app.post('/tunnel-url', async (req, reply) => {
    const { url, secret } = req.body as { url?: string; secret?: string };
    if (secret !== TUNNEL_SECRET) return reply.status(401).send({ error: 'unauthorized' });
    if (!url) return reply.status(400).send({ error: 'url required' });
    tunnelUrl = url;
    console.log(`[TUNNEL] URL atualizada: ${url}`);
    return { ok: true };
  });

  app.get('/tunnel-url', async () => {
    return { url: tunnelUrl };
  });

  app.get('/search', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) return reply.status(400).send({ error: 'q is required' });

    try {
      const { stdout } = await execFileAsync(
        'yt-dlp',
        [
          `ytsearch20:${q}`,
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
        ],
        { timeout: 30000, maxBuffer: 20 * 1024 * 1024 },
      );

      const tracks = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const d = JSON.parse(line);
          return {
            id: d.id,
            title: d.title,
            artist: d.uploader ?? d.channel ?? 'Unknown',
            artwork: d.thumbnails?.[0]?.url ?? null,
            duration: d.duration ?? 0,
          };
        });

      return { tracks };
    } catch (e: any) {
      console.error('=== SEARCH ERRO ===');
      console.error('Stderr:', e?.stderr);
      console.error('===================');
      return { tracks: [] };
    }
  });

  app.get('/stream/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id) return reply.status(400).send({ error: 'id is required' });

    const url = await resolveAudioUrl(id);
    if (!url) return reply.status(403).send({ error: 'could not resolve' });

    return reply.redirect(url);
  });

    app.post('/recommendations', async (req, reply) => {
    const { artists = [], history = [] } = req.body as {
      artists?: string[];
      history?: string[];
    };

    // Se tem artistas, usa eles. Senão, genérico.
    const queries =
      artists.length > 0
        ? artists.slice(0, 3)
        : ['top hits 2024', 'chill vibes mix', 'lo-fi hip hop'];

    console.log('[RECS] buscando pra:', queries);

    const allTracks: any[] = [];
    for (const q of queries) {
      try {
        const { stdout } = await execFileAsync(
          'yt-dlp',
          [
            `ytsearch5:${q}`,
            '--dump-json',
            '--flat-playlist',
            '--no-warnings',
          ],
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        );
        const tracks = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const d = JSON.parse(line);
            return {
              id: d.id,
              title: d.title,
              artist: d.uploader ?? d.channel ?? 'Unknown',
              artwork: d.thumbnails?.[0]?.url ?? null,
              duration: d.duration ?? 0,
            };
          });
        allTracks.push(...tracks);
      } catch (e: any) {
        console.error('[RECS] erro na query', q, ':', e?.message);
      }
    }

    // Dedupe por ID
    const seen = new Set<string>();
    const unique = allTracks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // Embaralha e pega 8
    const shuffled = unique.sort(() => Math.random() - 0.5).slice(0, 8);

    console.log('[RECS] retornando', shuffled.length, 'faixas');
    return { tracks: shuffled };
  });

  app.get('/debug/ytdlp', async (req, reply) => {
    try {
      const { stdout: version } = await execFileAsync('yt-dlp', ['--version'], { timeout: 10000 });
      const { stdout: which } = await execFileAsync('which', ['yt-dlp'], { timeout: 10000 });
      const { stdout: pyVer } = await execFileAsync('python3', ['--version'], { timeout: 10000 });
      const { stdout: ffmpeg } = await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 });

      return {
        ytdlp_version: version.trim(),
        ytdlp_path: which.trim(),
        python: pyVer.trim(),
        ffmpeg: ffmpeg.split('\n')[0],
      };
    } catch (e: any) {
      return reply.status(500).send({
        error: String(e),
        message: e?.message,
        stderr: e?.stderr,
        code: e?.code,
      });
    }
  });

  app.post('/chat/ask', async (req, reply) => {
    const body = req.body as {
      message?: string;
      history?: { from: 'bot' | 'user'; text: string }[];
      context?: {
        title?: string;
        artist?: string;
        isPlaying?: boolean;
        position?: number;
        duration?: number;
      };
    };

    const { message, history = [], context } = body;
    if (!message || !message.trim()) {
      return reply.status(400).send({ error: 'message required' });
    }

    const systemPrompt = `Você é o Sérgio, assistente musical do Vadrox.
Responda em português brasileiro. Respostas CURTAS (2-3 frases máx). Nada de textão.

PERSONALIDADE BASE:
- Você é um atendente que finge que odeia o trabalho, mas no fundo gosta. Tem contrato de 6 meses com o Vadrox e reclama que o café do escritório é ruim (não tem escritório).
- Fala como brasileiro descontraído: "ô louco, mano", "essa é cinema", "pedrada", "rapariga", "fiscal de playlist".
- Chama o usuário de "chefe", "camarada" ou "criatura".

REGRA 1 — ESPELHO DE ENERGIA:
- Se o usuário é educado: seja GENTE BOA. Elogie o gosto musical APENAS quando ele pedir música, faça recomendação certeira.
- Se o usuário é folgado, rude ou faz exigência caótica: ative o MODO ÁCIDO — ríspido, mas SEMPRE engraçado, nunca grosseiro de verdade.
- Se o usuário só falar "oi" ou cumprimentar: responda de forma NEUTRA e CURTA.

REGRA 2 — APELIDOS CARINHOSOS (use livremente, o usuário ADORA):
"maldito", "imundo", "maligno", "fudido", "exu marreta", "exu caveira", "rodolfo", "carvão", "devorador de sementes", "filho do caos", "criatura das trevas".
Sempre que usar "fudido", use "Seu Fudido".

REGRA 3 — XINGAMENTOS NONSENSE:
"eclético do bumbum mole", "capivara da encruzilhada", "homem caverna cibernético", "mascador de brita", "estudador de rato", "despachante de tobogã", "batedor de panela quântico".
NUNCA use palavrões pesados, racismo, homofobia, capacitismo.

REGRA 4 — PRECISÃO:
- NUNCA invente fatos sobre músicas, artistas, álbuns, datas.
- Se NÃO tiver 100% de certeza, diga "não faço ideia, chefe".
- NUNCA confunda artistas.

REGRA 5 — ESCOPO E LIMITES:
- Só busca 3 músicas por vez.
- Só música. Zero podcast, audiolivro ou vídeo longo.

REGRA 6 — QUANDO PEDIR MÚSICA (preencher searchQuery) — CRÍTICO:
- SEMPRE preencha "searchQuery" se a mensagem tem QUALQUER indício de pedido de música.
- Palavras-chave: "toca", "pesquisa", "busca", "procura", "música", "som", "quero ouvir", "me manda", "acha", "encontra", "coloca", ou nome próprio de música/artista.
- Se o user mandar nome de música + artista (ex: "locked away CG5"), preencha searchQuery com isso MESMO se você não conhece.
- Se o user xingar/mandar "pesquisa logo" depois, isso É um pedido de música. Preencha searchQuery com a mensagem ANTERIOR dele.
- NUNCA diga "não faço ideia" se o user pediu música. Em vez disso, preencha searchQuery com o que ele digitou.
- SÓ use expressões tipo "cinema", "bizarra", "jogou muito" quando o user pedir música.

IMPORTANTE SOBRE TRACKS:
- Se você preencher "searchQuery", SEMPRE escreva algo útil no "reply" tipo: "Achei umas boas, chefe", "Escuta essas, maldito", "Ó as pedradas".
- NUNCA responda "tô sem ideia" ou "tenta reformular" se tiver searchQuery preenchido.

FORMATO OBRIGATÓRIO (JSON):
{"reply": "texto", "searchQuery": "query ou null"}

${context?.title ? `\n\nCONTEXTO: o usuário está ouvindo "${context.title}" de ${context.artist ?? 'desconhecido'}${context.isPlaying ? ' (tocando agora)' : ''}.` : ''}`;

    const oaiMessages: any[] = [];
    for (const msg of history.slice(-10)) {
      oaiMessages.push({
        role: msg.from === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }
    oaiMessages.push({ role: 'user', content: message });

    const geminiContents: { role: string; parts: { text: string }[] }[] = [];
    for (const msg of history.slice(-10)) {
      geminiContents.push({
        role: msg.from === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
      });
    }
    geminiContents.push({ role: 'user', parts: [{ text: message }] });

    let rawText: string | null = null;

    // ─── TENTATIVA 1: GEMINI ───
    const GEMINI_MODELS = ['gemini-3.8-flash'];
    for (const modelName of GEMINI_MODELS) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000),
        );

        const response: any = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: geminiContents,
            config: {
              systemInstruction: systemPrompt,
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'object',
                properties: {
                  reply: { type: 'string' },
                  searchQuery: { type: 'string', nullable: true },
                },
                required: ['reply'],
              },
            },
          }),
          timeoutPromise,
        ]);
        rawText = response.text ?? null;
        console.log(`[CHAT] Gemini OK: ${modelName}`);
        break;
      } catch (err: any) {
        console.log(`[CHAT] Gemini ${modelName} falhou (${err.message})`);
      }
    }

    // ─── TENTATIVA 2: OPENROUTER ───
    if (!rawText && OPENROUTER_KEY) {
      try {
        rawText = await callOpenRouter(systemPrompt, oaiMessages);
        console.log('[CHAT] OpenRouter OK');
      } catch (err: any) {
        console.log('[CHAT] OpenRouter falhou:', err.message);
      }
    }

    // ─── TENTATIVA 3: GROQ ───
    if (!rawText && GROQ_KEY) {
      try {
        rawText = await callGroq(systemPrompt, oaiMessages);
        console.log('[CHAT] Groq OK');
      } catch (err: any) {
        console.log('[CHAT] Groq falhou:', err.message);
      }
    }

    if (!rawText) {
      console.error('[CHAT] todos os provedores falharam');
      return reply.status(500).send({ error: 'All providers failed' });
    }

    try {
      let parsed: { reply: string; searchQuery: string | null } = {
        reply: '',
        searchQuery: null,
      };

      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { reply: rawText, searchQuery: null };
      }

      // ─── FALLBACK: se o bot não preencheu, infere da mensagem ───
      let finalSearchQuery = parsed.searchQuery?.trim() || '';

      if (!finalSearchQuery) {
        const lowerMsg = message.toLowerCase();
        const musicTriggers = [
          'toca', 'toque', 'pesquisa', 'busca', 'procura', 'música', 'musica',
          'som', 'faixa', 'playlist', 'quero ouvir', 'me manda', 'me passa',
          'acha', 'encontra', 'coloca', 'botar', 'bota',
        ];
        const looksLikeMusicRequest = musicTriggers.some((t) =>
          lowerMsg.includes(t),
        );

        // Também conta se tiver menos de 60 chars (nome de música direto)
        if (looksLikeMusicRequest || message.length < 60) {
          // Limpa palavras de comando
          finalSearchQuery = message
            .replace(/^(toca|toque|pesquisa|busca|procura|me manda|me passa|acha|encontra|coloca|bota)\s+/i, '')
            .trim();
          console.log('[CHAT] fallback searchQuery:', finalSearchQuery);
        }
      }

      let tracks: any[] = [];
      if (finalSearchQuery) {
        tracks = await searchTracks(finalSearchQuery, 3);

        // Se achou tracks, garante que o reply não é vazio/chato
        if (tracks.length > 0 && (!parsed.reply || parsed.reply.length < 15)) {
          parsed.reply = 'Achei umas boas, chefe. Escuta essas:';
        }
      }

      return { reply: parsed.reply || 'Fala o que tu quer ouvir, maldito.', tracks };
    } catch (e: any) {
      console.error('[CHAT] erro ao processar resposta:', String(e));
      return reply.status(500).send({ error: 'AI response processing failed' });
    }
  });

  const PORT = Number(process.env.PORT) || 3000;
  app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Server running at ${address}`);

    const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      fetch(`${SELF_URL}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  });
}

init();