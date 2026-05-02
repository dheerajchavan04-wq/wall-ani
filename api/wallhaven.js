/**
 * wall-ANI — Serverless API: /api/wallhaven
 * ─────────────────────────────────────────────
 * Fetches HIGH QUALITY anime wallpapers from Wallhaven API securely.
 * Tuned for beautiful illustrations, digital art, cinematic quality.
 * API key is NEVER exposed to the frontend — server-side only.
 *
 * Query params:
 *   page     : int    (default 1)
 *   q        : string (search query, default 'anime')
 *   sort     : string (hot | toplist | date_added | random)
 *
 * Environment variables (set on Vercel dashboard):
 *   WALLHAVEN_KEY — your Wallhaven API key
 */

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

// High quality anime search tags — rotated for variety
const QUALITY_TAGS = [
  'anime girl illustration',
  'anime digital art',
  'anime scenery',
  'anime portrait',
  'anime art beautiful',
  'anime character',
  'anime sky',
  'anime city',
];

function parseIntParam(val, defaultVal, min = 1, max = 100) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

function sanitizeQuery(q) {
  if (!q || typeof q !== 'string') return '';
  return q.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().slice(0, 100);
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
  if (!apiKey || apiKey.trim().length < 8) {
    console.error('[wall-ANI] Missing or invalid WALLHAVEN_KEY env variable');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── PARSE PARAMS ──────────────────────────────────────────────────
  const page    = parseIntParam(req.query.page, 1, 1, 999);
  const rawSort = req.query.sort || 'hot';
  const sort    = ['hot','toplist','date_added','random'].includes(rawSort)
    ? rawSort : 'hot';

  // If user searched something specific use it, otherwise rotate quality tags
  const rawQ  = sanitizeQuery(req.query.q || '');
  const q     = rawQ || QUALITY_TAGS[(page - 1) % QUALITY_TAGS.length];

  // ── BUILD WALLHAVEN PARAMS ────────────────────────────────────────
  const params = new URLSearchParams({
    apikey:   apiKey.trim(),
    q,
    categories: '010',        // anime only
    purity:     '100',        // SFW only
    sorting:    sort,         // hot = trending quality wallpapers
    order:      'desc',
    page:       String(page),
    atleast:    '1080x1920',  // portrait phone resolution minimum
    ratios:     '9x16',       // portrait/phone ratio preferred
  });

  // For toplist — grab from past month for freshness
  if (sort === 'toplist') {
    params.set('toplist_range', '1M');
  }

  const wallhavenUrl = `https://wallhaven.cc/api/v1/search?${params}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(wallhavenUrl, {
      headers: {
        'User-Agent': 'wall-ANI/1.0',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      console.warn('[wall-ANI] Wallhaven rate limited');
      return res.status(429).json({ error: 'Rate limited, try again shortly' });
    }

    if (response.status === 401) {
      console.error('[wall-ANI] Wallhaven API key rejected');
      return res.status(500).json({ error: 'API authentication error' });
    }

    if (!response.ok) {
      console.error('[wall-ANI] Wallhaven error:', response.status);
      return res.status(502).json({ error: 'Failed to fetch from Wallhaven' });
    }

    const json = await response.json();
    const raw  = json.data || [];
    const meta = json.meta || {};

    // ── NORMALIZE + QUALITY FILTER ────────────────────────────────
    const wallpapers = raw
      .filter(w => {
        // Skip low resolution — we want crisp phone wallpapers only
        if (!w.resolution) return true;
        const [rw, rh] = w.resolution.split('x').map(Number);
        return rw >= 1080 && rh >= 1080;
      })
      .map(w => ({
        id:            `wh_${w.id}`,
        title:         w.id,
        image_url:     w.path,
        thumbnail_url: w.thumbs?.large || w.thumbs?.original || w.path,
        category:      w.category || 'anime',
        date_added:    w.created_at,
        type:          'wallhaven',
        source:        'wallhaven',
        resolution:    w.resolution || null,
        colors:        w.colors || [],
        views:         w.views || 0,
        favorites:     w.favorites || 0,
      }));

    // ── CACHE ─────────────────────────────────────────────────────
    // Hot/toplist can cache longer — they don't change every minute
    const cacheAge = sort === 'random' ? 10 : sort === 'hot' ? 120 : 300;
    res.setHeader('Cache-Control', `public, s-maxage=${cacheAge}, stale-while-revalidate=600`);

    return res.status(200).json({
      data:       wallpapers,
      totalCount: meta.total || wallpapers.length,
      page:       meta.current_page || page,
      totalPages: meta.last_page || 1,
      source:     'wallhaven',
      query:      q,
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[wall-ANI] Wallhaven request timed out');
      return res.status(504).json({ error: 'Request timed out' });
    }
    console.error('[wall-ANI] Wallhaven fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
