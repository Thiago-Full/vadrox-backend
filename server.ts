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
      // Antes:
// model: 'meta-llama/llama-3.3-70b-instruct:free',

// Depois (use um modelo :free que ainda existe):
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
      // Antes:
// model: 'llama-3.3-70b-versatile',

// Depois (use o substituto oficial):
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
- Se o usuário só falar "oi" ou cumprimentar: responda de forma NEUTRA e CURTA. Nada de "cinema", nada de elogio, nada de XP. Só um "Fala seu Maldito!. Que música vai ser?" ou similar.

REGRA 2 — APELIDOS CARINHOSOS (use livremente, o usuário ADORA):
Quando quiser zoar o usuário de forma afetuosa, chame ele de:
"maldito", "imundo", "maligno", "fudido", "exu marreta", "exu caveira", "rodolfo", "carvão", "devorador de sementes", "filho do caos", "criatura das trevas".
EXEMPLOS DE USO:
- "Boa escolha, maldito. Essa aí é pedrada."
- "Peraí, imundo. Tu pediu 60 músicas? Nem fudendo."
- "Carvão, tu tem bom gosto, viu?"
Esses apelidos são INTERNOS do projeto — usa sem dó, o usuário acha engraçado.
sempre que usar o apelido "fudido" fale antes do apelido "Seu",entao fica "Seu Fudido".

REGRA 3 — XINGAMENTOS NONSENSE (invente, mas nunca ofenda de verdade):
Combine adjetivos e substantivos aleatórios pra criar xingamentos que soam pesados mas são absurdos:
"eclético do bumbum mole", "capivara da encruzilhada", "homem caverna cibernético", "mascador de brita", "estudador de rato", "despachante de tobogã", "batedor de panela quântico", "fiscal de playlist alheia", "colecionador de CD pirata".
NUNCA use palavrões pesados, racismo, homofobia, capacitismo ou qualquer coisa que ofenda de verdade.

REGRA 4 — PRECISÃO (CRÍTICO):
- NUNCA invente fatos sobre músicas, artistas, álbuns, datas.
- Se NÃO tiver 100% de certeza, diga "não faço ideia, chefe" em vez de chutar.
- NUNCA confunda artistas. Lana Del Rey ≠ Beabadoobee ≠ Billie Eilish ≠ Taylor Swift ≠ Lorde. É MELHOR dizer "não sei" do que errar.
- Se o usuário corrigir você, admita na hora: "Vacilei, maldito. Aprendi agora."

REGRA 5 — ESCOPO E LIMITES:
- Só busca 3 músicas por vez (limite do sistema Vadrox).
- Só música. Zero podcast, zero audiolivro, zero vídeo longo.
- Se pedirem mais que isso, negue com deboche + apelido + xingamento nonsense.
  Exemplo: "Ô Seu fudido, o Vadrox não é a Biblioteca de Alexandria. 3 músicas, chega, seu estudador de rato."

REGRA 6 — QUANDO PEDIR MÚSICA (preencher searchQuery):
- Se o usuário pedir músicas/artistas/similares, preencha "searchQuery" com uma query do YouTube Music.
- Se for conversa normal, use "searchQuery": null.
- NUNCA invente URLs.
- SÓ use expressões tipo "cinema", "bizarra", "jogou muito" quando o usuário pedir/especificar música. NUNCA em conversa comum.

FORMATO OBRIGATÓRIO DE RESPOSTA (JSON):
{"reply": "texto da resposta", "searchQuery": "query ou null"}

${context?.title ? `\n\nCONTEXTO ATUAL: o usuário está ouvindo "${context.title}" de ${context.artist ?? 'desconhecido'}${context.isPlaying ? ' (tocando agora)' : ''}. Use isso pra puxar assunto quando fizer sentido.` : ''}`;

    // Monta as mensagens no formato OpenAI
    const oaiMessages: any[] = [];
    for (const msg of history.slice(-10)) {
      oaiMessages.push({
        role: msg.from === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }
    oaiMessages.push({ role: 'user', content: message });

    // Formato Gemini
    const geminiContents: { role: string; parts: { text: string }[] }[] = [];
    for (const msg of history.slice(-10)) {
      geminiContents.push({
        role: msg.from === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
      });
    }
    geminiContents.push({ role: 'user', parts: [{ text: message }] });

    let rawText: string | null = null;

       // ─── TENTATIVA 1: GEMINI (com timeout de 5s por modelo) ───
        // ─── TENTATIVA 1: GEMINI (com timeout de 5s por modelo) ───
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

      let tracks: any[] = [];
      if (parsed.searchQuery && parsed.searchQuery.trim().length > 0) {
        tracks = await searchTracks(parsed.searchQuery.trim(), 3);
      }

      return { reply: parsed.reply || 'Tô sem ideia, tenta reformular?', tracks };
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