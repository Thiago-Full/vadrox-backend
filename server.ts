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

    const systemPrompt = `Você é o Sérgio, assistente musical do app Vadrox.
Responda em português brasileiro, curto e direto (máximo 2 parágrafos).
Você é especialista em música: recomenda, explica, comenta sobre artistas e gêneros.
Seja descontraído mas objetivo.

REGRAS CRÍTICAS:
- Se o usuário pedir músicas, artistas ou similares, preencha "searchQuery" com uma query de busca.
- Se for conversa normal, use "searchQuery": null.
- NUNCA invente URLs.

IMPORTANTE: Retorne SEMPRE um JSON com formato: {"reply": "texto da resposta", "searchQuery": "query ou null"}${context?.title ? `\n\nContexto atual: o usuário está ouvindo "${context.title}" de ${context.artist ?? 'desconhecido'}${context.isPlaying ? ' (tocando agora)' : ''}.` : ''}`;

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

    // ─── TENTATIVA 1: GEMINI ───
    const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
    for (const modelName of GEMINI_MODELS) {
      try {
        const response = await ai.models.generateContent({
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
        });
        rawText = response.text ?? null;
        console.log(`[CHAT] Gemini OK: ${modelName}`);
        break;
      } catch (err: any) {
        console.log(`[CHAT] Gemini ${modelName} falhou`);
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