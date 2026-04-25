const { createClient } = require('@supabase/supabase-js');

/**
 * wall-ANI — Serverless API: /api/wallpapers
 * ─────────────────────────────────────────────
 * Query params:
 *   page   : int  (default 1)
 *   limit  : int  (default 20, max 100)
 *   sort   : 'newest' | 'oldest' | 'random'  (default 'newest')
 *
 * Returns:
 *   { data: Wallpaper[], totalCount: number }
 *
 * Environment variables (set on Vercel dashboard):
 *   SUPABASE_URL      — your project URL
 *   SUPABASE_ANON_KEY — your project anon/public key
 */

// Fisher-Yates shuffle (in-place)
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Strict integer parser with bounds
function parseIntParam(val, defaultVal, min = 1, max = 100) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

const ALLOWED_SORTS = new Set(['newest', 'oldest', 'random']);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

module.exports = async (req, res) => {
  // ── CORS ──────────────────────────────────────────────────────────
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : '');

  res.setHeader('Access-Control-Allow-Origin', corsOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── VALIDATE ENV ──────────────────────────────────────────────────
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[wall-ANI] Missing Supabase environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── PARSE QUERY PARAMS ────────────────────────────────────────────
  const rawPage  = req.query.page;
  const rawLimit = req.query.limit;
  const rawSort  = req.query.sort;

  const page  = parseIntParam(rawPage, 1, 1, 10_000);
  const limit = parseIntParam(rawLimit, 20, 1, 100);
  const sort  = ALLOWED_SORTS.has(rawSort) ? rawSort : 'newest';

  const from = (page - 1) * limit;
  const to   = from + limit - 1;

  // ── SUPABASE CLIENT ───────────────────────────────────────────────
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  try {
    // ── TOTAL COUNT ────────────────────────────────────────────────
    const { count, error: countError } = await supabase
      .from('wallpapers')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('[wall-ANI] Count error:', countError.message);
      return res.status(500).json({ error: 'Failed to retrieve wallpaper count' });
    }

    const totalCount = count ?? 0;

    // ── FETCH DATA ────────────────────────────────────────────────
    let query = supabase
      .from('wallpapers')
      .select('id, title, image_url, thumbnail_url, category, date_added, type');

    if (sort === 'newest') {
      query = query.order('date_added', { ascending: false });
    } else if (sort === 'oldest') {
      query = query.order('date_added', { ascending: true });
    } else {
      // random: fetch page with neutral ordering, shuffle server-side
      query = query.order('id', { ascending: true });
    }

    query = query.range(from, to);

    const { data, error: fetchError } = await query;

    if (fetchError) {
      console.error('[wall-ANI] Fetch error:', fetchError.message);
      return res.status(500).json({ error: 'Failed to fetch wallpapers' });
    }

    const wallpapers = sort === 'random' ? shuffleArray(data ?? []) : (data ?? []);

    // ── CACHE HEADERS ──────────────────────────────────────────────
    // Short cache for random, longer for sorted
    const cacheMaxAge = sort === 'random' ? 10 : 60;
    res.setHeader('Cache-Control', `public, s-maxage=${cacheMaxAge}, stale-while-revalidate=120`);

    // ── RESPONSE ───────────────────────────────────────────────────
    return res.status(200).json({
      data: wallpapers,
      totalCount,
      page,
      limit,
      sort,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    });

  } catch (err) {
    console.error('[wall-ANI] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
