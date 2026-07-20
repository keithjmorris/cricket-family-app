// api/cricket.js
//
// This runs on Vercel's servers, never in the browser. It's the only place
// the Highlightly API key is ever read or used. The frontend calls THIS
// endpoint (e.g. /api/cricket?path=matches&date=2026-07-19), never
// cricket.highlightly.net directly.
//
// Highlightly's auth is a header (x-rapidapi-key), not a URL parameter like
// cricketdata.org used — that's why this proxy takes the shape of the path
// as a parameter and forwards everything else, rather than an "endpoint"
// name.
const ALLOWED_ROOTS = new Set([
  'countries',
  'teams',
  'matches',       // list + /matches/{id} for full detail (scorecard, weather, predictions)
  'players',       // search + /players/{id} for career summary
  'standings',
  'head-2-head',
  'last-five-games',
  'leagues',
]);

// Highlightly documents its own refresh intervals per endpoint — these
// cache lifetimes are set to roughly match, so we're not holding onto data
// longer than Highlightly itself would refresh it, but also not re-fetching
// more often than useful.
const CACHE_SECONDS = {
  teams: 3600,          // rarely changes
  players: 3600,        // "once a day" per their docs
  standings: 1800,      // "up to an hour after a match" per their docs
  'head-2-head': 3600,
  'last-five-games': 300,
  leagues: 3600,
  countries: 86400,     // "once a day" per their docs, and essentially static
};

// `matches` is used for several very different things — a single flat
// cache lifetime doesn't fit all of them. Today's live-tracking query needs
// to stay fresh; a fixture that's already been published for next month
// basically never changes until match day.
function matchesCacheSeconds(cleanPath, params) {
  const hasId = cleanPath.includes('/'); // e.g. matches/12345 → single match detail (scorecard)
  if (hasId) return 30; // used for live scorecards — keep reasonably fresh
  if (params.homeTeamName || params.awayTeamName) return 3600; // priority-team fixture sweep — rarely changes once published
  const todayStr = new Date().toISOString().slice(0, 10);
  if (params.date === todayStr) return 20; // today — this is the live-tracking query
  if (params.date) return 1800; // any other date in the fixtures/results sweep
  return 60; // fallback
}

export default async function handler(req, res) {
  const { path, ...params } = req.query;

  if (!path) {
    res.status(400).json({ error: 'Missing path parameter' });
    return;
  }

  const cleanPath = String(path).replace(/^\/+/, '');
  const rootSegment = cleanPath.split('/')[0];

  if (!ALLOWED_ROOTS.has(rootSegment)) {
    res.status(400).json({ error: `Unknown path. Allowed roots: ${[...ALLOWED_ROOTS].join(', ')}` });
    return;
  }

  const apiKey = process.env.HIGHLIGHTLY_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing HIGHLIGHTLY_API_KEY. Set it in .env locally or in Vercel project settings.' });
    return;
  }

  const upstreamUrl = new URL(`https://cricket.highlightly.net/${cleanPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) upstreamUrl.searchParams.set(key, String(value));
  }

  try {
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      headers: { 'x-rapidapi-key': apiKey },
    });
    const data = await upstreamRes.json();

    if (!upstreamRes.ok) {
      res.status(upstreamRes.status).json({
        error: data.message || data.error || 'Upstream cricket data request failed',
      });
      return;
    }

    const seconds = rootSegment === 'matches' ? matchesCacheSeconds(cleanPath, params) : (CACHE_SECONDS[rootSegment] ?? 60);
    res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=${seconds * 3}`);
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Highlightly', details: err.message });
  }
}
