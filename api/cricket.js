// api/cricket.js
//
// This runs on Vercel's servers, never in the browser. It's the only place
// the cricketdata.org API key is ever read or used. The frontend calls
// THIS endpoint (e.g. /api/cricket?endpoint=matches), never cricketdata.org
// directly.
//
// Allow-listing endpoints keeps this from being turned into an open proxy
// for arbitrary URLs by anyone who finds it.
const ALLOWED_ENDPOINTS = new Set([
  'currentMatches',   // live / recently live matches
  'matches',          // fixtures + results (filtered on the frontend by date/status)
  'match_scorecard',  // full batting + bowling scorecard for one match
  'players_info',     // search for a player by name
  'playerStats',      // career stats for one player id
  'series_info',      // details for a series/tournament
]);

// Live data goes stale fast, fixtures/results/players don't.
// These are Vercel Edge cache lifetimes in seconds, not browser cache.
const CACHE_SECONDS = {
  currentMatches: 60,
  matches: 300,
  match_scorecard: 60,
  players_info: 3600,
  playerStats: 3600,
  series_info: 3600,
};

export default async function handler(req, res) {
  const { endpoint, ...params } = req.query;

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    res.status(400).json({ error: `Unknown or missing endpoint. Allowed: ${[...ALLOWED_ENDPOINTS].join(', ')}` });
    return;
  }

  const apiKey = process.env.CRICKET_API_KEY;
  if (!apiKey) {
    // This means the CRICKET_API_KEY environment variable hasn't been set
    // (locally in .env, or in the Vercel project settings).
    res.status(500).json({ error: 'Server is missing CRICKET_API_KEY. Set it in .env locally or in Vercel project settings.' });
    return;
  }

  const upstreamUrl = new URL(`https://api.cricapi.com/v1/${endpoint}`);
  upstreamUrl.searchParams.set('apikey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) upstreamUrl.searchParams.set(key, String(value));
  }

  try {
    const upstreamRes = await fetch(upstreamUrl.toString());
    const data = await upstreamRes.json();

    if (!upstreamRes.ok || data.status === 'failure') {
      // Surface cricketdata.org's own error message (e.g. bad key, hit limit reached)
      res.status(upstreamRes.status || 502).json({
        error: data.reason || data.message || 'Upstream cricket data request failed',
      });
      return;
    }

    const seconds = CACHE_SECONDS[endpoint] ?? 120;
    // s-maxage = cached on Vercel's edge for everyone; stale-while-revalidate
    // = keep serving the cached copy while a fresh one is fetched in the background.
    res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=${seconds * 3}`);
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach cricketdata.org', details: err.message });
  }
}
