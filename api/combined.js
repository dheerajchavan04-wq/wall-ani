/**
 * wall-ANI — Serverless API: /api/combined
 * ─────────────────────────────────────────────
 * Fetches wallpapers from BOTH Supabase AND Wallhaven,
 * merges them, shuffles, and returns a unified feed.
 * API key is NEVER exposed to the frontend — server-side only.
 *
 * Query params:
 *   page  : int    (default 1)
 *   limit : int    (default 20)
 *   sort  : 'newest' | 'oldest' | 'random'
 *   q     : string (search/category filter)
 *
 * Environment variables (set on Vercel dashboard):
 *   SUPABASE_URL      — your Supabase project URL
 *   SUPABASE_ANON_KEY — your Supabase anon key
 *   WALLHAVEN_KEY     — your Wallhaven API key
 */

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

function parseIntParam(val, defaultVal, min = 1, max = 100) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

function sanitizeQuery(q) {
  if (!q || typeof q !== 'string') return 'anime';
  return q.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().slice(0, 100) || 'anime';
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── FETCH FROM WALLHAVEN ──────────────────────────────────────────────
async function fetchFromWallhaven(apiKey, page, q) {
  // Guard: never call Wallhaven without a valid key
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    console.error('[wall-ANI] Wallhaven API key is missing or invalid');
    return { data: [], total: 0 };
  }

  try {
    const params = new URLSearchParams({
      apikey: apiKey.trim(),
      q,
      categories: '010',
      purity: '100',
      sorting: 'date_added',
      order: 'desc',
      page: String(page),
      atleast: '1920x1080',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(`https://wallhaven.cc/api/v1/search?${params}`, {
      headers: {
        'User-Agent': 'wall-ANI/1.0',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Handle Wallhaven rate limiting gracefully
    if (res.status === 429) {
      console.warn('[wall-ANI] Wallhaven rate limit hit — returning empty');
      return { data: [], total: 0, rateLimited: true };
    }

    if (res.status === 401) {
      console.error('[wall-ANI] Wallhaven API key rejected (401)');
      return { data: [], total: 0, authError: true };
    }

    if (!res.ok) {
      console.error('[wall-ANI] Wallhaven error status:', res.status);
      return { data: [], total: 0 };
    }

    const json = await res.json();
    const raw = json.data || [];

    const data = raw.map(w => ({
      id: `wh_${w.id}`,
      title: w.id,
      image_url: w.path,
      thumbnail_url: w.thumbs?.large || w.thumbs?.original || w.path,
      category: w.category || 'anime',
      date_added: w.created_at,
      type: 'wallhaven',
      source: 'wallhaven',
      resolution: w.resolution || null,
    }));

    return { data, total: json.meta?.total || data.length };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[wall-ANI] Wallhaven request timed out');
    } else {
      console.error('[wall-ANI] Wallhaven fetch error:', err.message);
    }
    return { data: [], total: 0 };
  }
}

// ── FETCH FROM SUPABASE ───────────────────────────────────────────────
async function fetchFromSupabase(supabaseUrl, supabaseKey, page, limit, sort) {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { count } = await supabase
      .from('wallpapers')
      .select('*', { count: 'exact', head: true });

    let query = supabase
      .from('wallpapers')
      .select('id, title, image_url, thumbnail_url, category, date_added, type');

    if (sort === 'oldest') {
      query = query.order('date_added', { ascending: true });
    } else {
      query = query.order('date_added', { ascending: false });
    }

    query = query.range(from, to);

    const { data, error } = await query;
    if (error) {
      console.error('[wall-ANI] Supabase query error:', error.message);
      return { data: [], total: 0 };
    }

    const normalized = (data || []).map(w => ({ ...w, source: 'supabase' }));
    return { data: normalized, total: count || 0 };
  } catch (err) {
    console.error('[wall-ANI] Supabase error:', err.message);
    return { data: [], total: 0 };
  }
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
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_ANON_KEY;
  const wallhavenKey = process.env.WALLHAVEN_KEY;

  // Log which vars are present (never log values!)
  if (!supabaseUrl)  console.error('[wall-ANI] SUPABASE_URL is not set');
  if (!supabaseKey)  console.error('[wall-ANI] SUPABASE_ANON_KEY is not set');
  if (!wallhavenKey) console.error('[wall-ANI] WALLHAVEN_KEY is not set');

  // If ALL are missing something is very wrong
  if (!supabaseUrl && !supabaseKey && !wallhavenKey) {
    return res.status(500).json({ error: 'Server configuration error — env vars missing' });
  }

  // ── PARSE PARAMS ──────────────────────────────────────────────────
  const page  = parseIntParam(req.query.page, 1, 1, 999);
  const limit = parseIntParam(req.query.limit, 20, 1, 40);
  const sort  = ['newest', 'oldest', 'random'].includes(req.query.sort)
    ? req.query.sort : 'newest';
  const q = sanitizeQuery(req.query.q || 'anime');

  try {
    // ── FETCH BOTH SOURCES IN PARALLEL ───────────────────────────
    const [wallhavenResult, supabaseResult] = await Promise.allSettled([
      wallhavenKey
        ? fetchFromWallhaven(wallhavenKey, page, q)
        : Promise.resolve({ data: [], total: 0 }),
      (supabaseUrl && supabaseKey)
        ? fetchFromSupabase(supabaseUrl, supabaseKey, page, limit, sort)
        : Promise.resolve({ data: [], total: 0 }),
    ]);

    const wallhavenData = wallhavenResult.status === 'fulfilled'
      ? wallhavenResult.value.data : [];
    const supabaseData = supabaseResult.status === 'fulfilled'
      ? supabaseResult.value.data : [];
    const supabaseTotal = supabaseResult.status === 'fulfilled'
      ? supabaseResult.value.total : 0;
    const wallhavenTotal = wallhavenResult.status === 'fulfilled'
      ? wallhavenResult.value.total : 0;

    // ── MERGE + SORT ──────────────────────────────────────────────
    let merged = [...supabaseData, ...wallhavenData];

    // If completely empty — return graceful empty response (not 500)
    if (merged.length === 0) {
      return res.status(200).json({
        data: [],
        totalCount: 0,
        page,
        limit,
        sort,
        totalPages: 1,
        sources: { wallhaven: 0, supabase: 0 },
        warning: 'No wallpapers returned from either source',
      });
    }

    if (sort === 'random') {
      merged = shuffleArray(merged);
    } else if (sort === 'newest') {
      merged.sort((a, b) => new Date(b.date_added) - new Date(a.date_added));
    } else if (sort === 'oldest') {
      merged.sort((a, b) => new Date(a.date_added) - new Date(b.date_added));
    }

    const totalCount = supabaseTotal + wallhavenTotal;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    // ── CACHE ─────────────────────────────────────────────────────
    const cacheAge = sort === 'random' ? 10 : 60;
    res.setHeader('Cache-Control', `public, s-maxage=${cacheAge}, stale-while-revalidate=120`);

    return res.status(200).json({
      data: merged,
      totalCount,
      page,
      limit,
      sort,
      totalPages,
      sources: {
        wallhaven: wallhavenData.length,
        supabase: supabaseData.length,
      },
    });

  } catch (err) {
    console.error('[wall-ANI] Combined fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
