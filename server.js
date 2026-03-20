// ════════════════════════════════════════════════════════════════
// COLACO BACKEND — server.js
// What this does:
//   1. Calls Consumet API to get anime episode stream URLs
//   2. Calls AniWatch API as a second source
//   3. Proxies every HLS request (strips X-Frame, adds CORS)
//   4. Serves the frontend from /public
// ════════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Keep-alive agents for faster upstream requests ───────────────
const httpAgent  = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Upstream API hosts ───────────────────────────────────────────
const CONSUMET = [
  'https://consumet-api.onrender.com',
  'https://api.consumet.org',
];
const ANIWATCH = [
  'https://api-aniwatch.onrender.com',
];

// Browser-like headers to avoid being blocked
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Helper: try multiple hosts until one works
async function tryHosts(hosts, urlPath, params = {}, timeout = 15000) {
  let lastErr;
  for (const host of hosts) {
    try {
      const res = await axios.get(`${host}${urlPath}`, {
        params,
        timeout,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        httpAgent,
        httpsAgent,
      });
      if (res.data) return res.data;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('All hosts failed');
}

// ════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════

// ── Search gogoanime for an anime title ──────────────────────────
// GET /api/search?q=attack+on+titan
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q is required' });
    const data = await tryHosts(CONSUMET, `/anime/gogoanime/${encodeURIComponent(q)}`);
    res.json(data);
  } catch (e) {
    console.error('[/api/search]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Get episode list for a gogoanime anime ───────────────────────
// GET /api/info?id=attack-on-titan
app.get('/api/info', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await tryHosts(CONSUMET, `/anime/gogoanime/info/${encodeURIComponent(id)}`);
    res.json(data);
  } catch (e) {
    console.error('[/api/info]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Get stream sources (m3u8 URLs) for an episode ────────────────
// GET /api/stream?id=attack-on-titan-episode-1&server=gogocdn
app.get('/api/stream', async (req, res) => {
  try {
    const { id, server = 'gogocdn' } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await tryHosts(
      CONSUMET,
      `/anime/gogoanime/watch/${encodeURIComponent(id)}`,
      { server }
    );
    res.json(data);
  } catch (e) {
    console.error('[/api/stream]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AniWatch: search ─────────────────────────────────────────────
// GET /api/aw/search?q=naruto
app.get('/api/aw/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q is required' });
    const data = await tryHosts(ANIWATCH, '/anime/search', { keyword: q, page: 1 });
    res.json(data);
  } catch (e) {
    console.error('[/api/aw/search]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AniWatch: episode list ───────────────────────────────────────
// GET /api/aw/episodes?id=attack-on-titan-3n5e
app.get('/api/aw/episodes', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await tryHosts(ANIWATCH, `/anime/${encodeURIComponent(id)}/episodes`);
    res.json(data);
  } catch (e) {
    console.error('[/api/aw/episodes]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AniWatch: stream sources ─────────────────────────────────────
// GET /api/aw/stream?id=EPISODE_ID&server=vidstreaming&type=sub
app.get('/api/aw/stream', async (req, res) => {
  try {
    const { id, server = 'vidstreaming', type = 'sub' } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await tryHosts(ANIWATCH, '/anime/episode-srcs', {
      id, server, category: type
    });
    res.json(data);
  } catch (e) {
    console.error('[/api/aw/stream]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// HLS PROXY — The key that makes everything work
// Fetches .m3u8 and .ts files server-side, strips X-Frame-Options,
// rewrites segment URLs so they also go through the proxy
// ════════════════════════════════════════════════════════════════
app.get('/proxy', async (req, res) => {
  const { url, ref } = req.query;

  if (!url) return res.status(400).send('url required');

  // Decode the URL
  const target = decodeURIComponent(url);
  const referer = ref ? decodeURIComponent(ref) : 'https://gogoanime.bid/';

  try {
    const upstream = await axios.get(target, {
      timeout: 20000,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      httpAgent,
      httpsAgent,
      headers: {
        'User-Agent':        UA,
        'Accept':            '*/*',
        'Accept-Language':   'en-US,en;q=0.9',
        'Referer':           referer,
        'Origin':            new URL(referer).origin,
      },
    });

    // Set response headers — allow everything, strip blocks
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    res.set({
      'Content-Type':                ct,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':'*',
      'Cache-Control':               'public, max-age=300',
    });
    // Remove headers that block embedding
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');

    const isM3U8 = ct.includes('mpegurl') || ct.includes('x-mpegurl') || target.includes('.m3u8');

    if (isM3U8) {
      // Rewrite all segment and key URLs in the playlist
      let text = Buffer.from(upstream.data).toString('utf-8');
      const base = target.substring(0, target.lastIndexOf('/') + 1);
      const myBase = `/proxy?ref=${encodeURIComponent(referer)}&url=`;

      // Rewrite .ts segment lines
      text = text.replace(/^([^#\s].+)$/gm, (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const absUrl = trimmed.startsWith('http') ? trimmed : base + trimmed;
        return `${myBase}${encodeURIComponent(absUrl)}`;
      });

      // Rewrite encryption key URI
      text = text.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absUri = uri.startsWith('http') ? uri : base + uri;
        return `URI="${myBase}${encodeURIComponent(absUri)}"`;
      });

      return res.send(text);
    }

    // Binary (ts segments, keys)
    res.send(Buffer.from(upstream.data));

  } catch (e) {
    console.error('[/proxy]', e.message, target.slice(0, 80));
    res.status(502).send('Proxy error: ' + e.message);
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'Colaco' }));

// ── Serve frontend for all other routes ──────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎌  Colaco running → http://localhost:${PORT}`);
});
