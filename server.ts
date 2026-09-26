// server.ts
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = Fastify({ logger: true });

async function init() {
  await app.register(replyFrom);

  async function resolveAudioUrl(id: string): Promise<string | null> {
    try {
      console.log('[YTDLP] resolvendo stream:', id);
      const { stdout } = await execAsync(
        `yt-dlp -g -f "bestaudio[ext=m4a]" "https://music.youtube.com/watch?v=${id}"`,
        { timeout: 20000 },
      );
      const url = stdout.trim().split('\n').filter(Boolean)[0];
      console.log('[YTDLP] stream URL:', url ? 'OK' : 'VAZIA');
      return url || null;
    } catch (e: any) {
      console.error('[YTDLP] erro stream:', e.message);
      return null;
    }
  }

  app.get('/search', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) return reply.status(400).send({ error: 'q is required' });

    try {
      console.log('[YTDLP] buscando:', q);
      const { stdout } = await execAsync(
        `yt-dlp "ytsearch20:${q}" --dump-json --flat-playlist --no-warnings`,
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

      console.log('[YTDLP] busca OK, itens:', tracks.length);
      return { tracks };
    } catch (e: any) {
      console.error('[YTDLP] erro busca:', e.message);
      return { tracks: [] };
    }
  });

  app.get('/stream/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id) return reply.status(400).send({ error: 'id is required' });

    const url = await resolveAudioUrl(id);
    if (!url) return reply.status(403).send({ error: 'could not resolve' });

    return reply.from(url);
  });

  app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Server running at ${address}`);
  });
}

init();