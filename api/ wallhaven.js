/**
 * wall-ANI — Serverless API: /api/wallhaven
 * ─────────────────────────────────────────────
 * Fetches anime wallpapers from Wallhaven API securely.
 * API key is NEVER exposed to the frontend.
 *
 * Query params:
 *   page     : int    (default 1)
 *   q        : string (search query, default 'anime')
 *   category : string (e.g. 'naruto', 'attack on titan')
 *
 * Environment variables (set on Vercel dashboard):
 *   WALLHAVEN_KEY — your Wallhaven API key
 */

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

// Strict integer parser
function parseIntParam(val, defaultVal, min = 1, max = 100) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

// Sanitize search query — strip anything dangerous
function sanitizeQuery(q) {
  if (!q || typeof q !== 'string') return 'anime';
  return q.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().slice(0, 100) || 'anime';
}

module.exports = async (req, res) => {
  // ── CORS ──────────────────────────────────────────────────────────
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : ALLOWED_ORIGINS.includes(origin) ? origin : '';

  res.setHeader('Access-Control-Allow-Origin', corsOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  // ── VALIDATE ENV ──────────────────────────────────────────────────
  const apiKey = process.env.WALLHAVEN_KEY;
  if (!apiKey) {
    console.error('[wall-ANI] Missing WALLHAVEN_KEY env variable');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── PARSE PARAMS ──────────────────────────────────────────────────
  const page = parseIntParam(req.query.page, 1, 1, 999);
  const rawQ = req.query.q || 'anime';
  const q = sanitizeQuery(rawQ);

  // ── BUILD WALLHAVEN URL ───────────────────────────────────────────
  // categories: 100 = anime/people, sorting by date_added, purity = sfw only
  const params = new URLSearchParams({
    apikey: apiKey,
    q,
    categories: '010',   // 010 = anime only
    purity: '100',       // SFW only
    sorting: 'date_added',
    order: 'desc',
    page: String(page),
    atleast: '1920x1080',
  });

  const wallhavenUrl = `https://wallhaven.cc/api/v1/search?${params}`;

  try {
    const response = await fetch(wallhavenUrl, {
      headers: { 'User-Agent': 'wall-ANI/1.0' },
    });

    if (!response.ok) {
      console.error('[wall-ANI] Wallhaven error:', response.status);
      return res.status(502).json({ error: 'Failed to fetch from Wallhaven' });
    }

    const json = await response.json();
    const raw = json.data || [];
    const meta = json.meta || {};

    // ── NORMALIZE DATA ────────────────────────────────────────────
    // Map Wallhaven format → our app format
    const wallpapers = raw.map(w => ({
      id: `wh_${w.id}`,
      title: w.id,
      image_url: w.path,
      thumbnail_url: w.thumbs?.large || w.thumbs?.original || w.path,
      category: w.category || 'anime',
      date_added: w.created_at,
      type: 'wallhaven',
      resolution: w.resolution,
      colors: w.colors || [],
    }));

    // ── CACHE ─────────────────────────────────────────────────────
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

    return res.status(200).json({
      data: wallpapers,
      totalCount: meta.total || wallpapers.length,
      page: meta.current_page || page,
      totalPages: meta.last_page || 1,
      source: 'wallhaven',
    });

  } catch (err) {
    console.error('[wall-ANI] Wallhaven fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
