// app.js — talks only to our own /api/cricket proxy, never to cricketdata.org
// directly (the API key lives server-side only, see api/cricket.js).

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

async function callApi(endpoint, params = {}) {
  const url = new URL('/api/cricket', window.location.origin);
  url.searchParams.set('endpoint', endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// Tries a list of possible property paths (the free-tier API's exact field
// names have varied slightly across versions/docs) and returns the first hit.
function pick(obj, paths, fallback = '') {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Shared data cache ----------------
   We keep the last-fetched raw arrays in memory so that changing the team
   filter, or switching tabs back and forth, re-renders from what we already
   have instead of spending another API call. Only the Refresh button (and
   the background live poll) actually goes back to the network. */
const cache = {
  live: null,     // array from currentMatches
  matches: null,  // array from `matches` — shared by BOTH Fixtures and Results
};

/* ---------------- Team filter ---------------- */
let activeFilter = 'all'; // 'all' | 'england-men' | 'england-women' | free-text team search

function teamNames(match) { return (match.teams || []).map(String); }
function isEnglandMen(name) { return /england/i.test(name) && !/women/i.test(name); }
function isEnglandWomen(name) { return /england/i.test(name) && /women/i.test(name); }

function matchPassesFilter(match) {
  const teams = teamNames(match);
  if (activeFilter === 'all') return true;
  if (activeFilter === 'england-men') return teams.some(isEnglandMen);
  if (activeFilter === 'england-women') return teams.some(isEnglandWomen);
  const q = activeFilter.toLowerCase();
  return teams.some((t) => t.toLowerCase().includes(q));
}

function setActiveFilter(filter) {
  activeFilter = filter;
  $$('.filter-chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter)));
  if (filter === 'all' || filter === 'england-men' || filter === 'england-women') {
    $('#filter-search-input').value = '';
  }
  // Re-render whichever panel is visible, from cache — no new API call.
  const activePanel = $('.panel:not([hidden])')?.dataset.panel;
  if (activePanel === 'live' && cache.live) renderLivePanel();
  if (activePanel === 'fixtures' && cache.matches) renderFixturesPanel();
  if (activePanel === 'results' && cache.matches) renderResultsPanel();
}

$$('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => setActiveFilter(chip.dataset.filter));
});
$('#filter-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#filter-search-input').value.trim();
  if (q) setActiveFilter(q);
});
setActiveFilter('all');

/* ---------------- Tabs ---------------- */
const loaded = { live: false, matches: false };

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
    tab.setAttribute('aria-selected', 'true');
    const name = tab.dataset.tab;
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    $('#filter-bar').hidden = name === 'players';

    if (name === 'live') { loaded.live ? renderLivePanel() : loadLive(); startLivePolling(); }
    else { stopLivePolling(); }

    if (name === 'fixtures') { loaded.matches ? renderFixturesPanel() : loadMatches(); }
    if (name === 'results') { loaded.matches ? renderResultsPanel() : loadMatches(); }
  });
});

$('#refresh-live').addEventListener('click', () => loadLive(true));

/* ---------------- Budget-conscious auto-refresh ----------------
   Live scores poll automatically, but ONLY while the Live tab is the one
   showing AND the browser tab itself is in the foreground — switching away
   from either stops it. Combined with the server's edge cache (see
   api/cricket.js), this keeps a full day of intermittent live-watching
   comfortably inside the free tier's 100 requests/day. */
const LIVE_POLL_MS = 120000; // 2 minutes
let livePollTimer = null;

function startLivePolling() {
  stopLivePolling();
  livePollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadLive();
  }, LIVE_POLL_MS);
}
function stopLivePolling() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  const onLiveTab = $('.panel[data-panel="live"]') && !$('.panel[data-panel="live"]').hidden;
  if (document.visibilityState === 'visible' && onLiveTab) startLivePolling();
  else stopLivePolling();
});

/* ---------------- Live ---------------- */
async function loadLive(forceFresh = false) {
  const box = $('#live-content');
  if (!cache.live || forceFresh) box.innerHTML = '<p class="hint">Loading live matches…</p>';
  try {
    const { data } = await callApi('currentMatches');
    loaded.live = true;
    cache.live = data || [];
    renderLivePanel();
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load live scores: ${escapeHtml(err.message)}</p>`;
  }
}

function renderLivePanel() {
  const box = $('#live-content');
  const all = cache.live || [];
  const filtered = all.filter(matchPassesFilter);
  const live = filtered.filter((m) => pick(m, ['matchStarted']) && !pick(m, ['matchEnded']));
  const recentlyDone = filtered.filter((m) => pick(m, ['matchEnded']));

  box.innerHTML = '';
  if (!live.length && !recentlyDone.length) {
    box.innerHTML = all.length
      ? '<p class="hint">No matches for that team right now. Try a different filter.</p>'
      : '<p class="hint">No live matches right now. Check back nearer match time, or see Fixtures.</p>';
    return;
  }
  live.forEach((m) => box.appendChild(renderScoreboard(m, 'live')));
  recentlyDone.forEach((m) => box.appendChild(renderScoreboard(m, 'done')));
}

function renderScoreboard(match, kind) {
  const name = pick(match, ['name'], `${pick(match, ['teams.0'], 'Team A')} vs ${pick(match, ['teams.1'], 'Team B')}`);
  const status = pick(match, ['status'], kind === 'live' ? 'In progress' : 'Match ended');
  const scores = match.score || [];

  const rows = scores.map((s) => {
    const inningTeam = pick(s, ['inning'], '').replace(/ Inning.*/i, '');
    const r = pick(s, ['r'], '-');
    const w = pick(s, ['w'], '-');
    const o = pick(s, ['o'], '-');
    return `<div class="board-row">
      <span class="board-team">${escapeHtml(inningTeam || '')}</span>
      <span class="board-score">${escapeHtml(r)}/${escapeHtml(w)} <span style="opacity:.6">(${escapeHtml(o)} ov)</span></span>
    </div>`;
  }).join('');

  const teamsFallback = (!scores.length) ? (match.teams || []).map((t) =>
    `<div class="board-row"><span class="board-team">${escapeHtml(t)}</span><span class="board-score">—</span></div>`
  ).join('') : '';

  const node = el(`
    <div class="scoreboard" tabindex="0" role="button" aria-label="Open scorecard for ${escapeHtml(name)}">
      <div class="scoreboard-top">
        <span class="match-name">${escapeHtml(name)}</span>
        <span class="status-tag ${kind === 'live' ? 'live' : 'done'}">${kind === 'live' ? 'Live' : 'Ended'}</span>
      </div>
      ${rows || teamsFallback}
      <div class="board-note">${escapeHtml(status)}</div>
    </div>
  `);
  const id = pick(match, ['id']);
  node.addEventListener('click', () => id && openScorecard(id));
  node.addEventListener('keypress', (e) => { if (e.key === 'Enter' && id) openScorecard(id); });
  return node;
}

/* ---------------- Fixtures + Results (one shared fetch) ----------------
   The `matches` endpoint returns a shared, worldwide list (every match
   being played anywhere), roughly 25 at a time via `offset`. A single
   high-profile match can easily sit on page 2 or 3 rather than page 1, so
   we fetch a handful of pages and merge them. This costs a few API hits
   per fetch instead of one — but it's cached client-side afterwards (see
   `cache.matches`), so it's only paid once per visit, not on every filter
   or tab change.

   On top of that, marquee series (e.g. England internationals) are pulled
   directly by their series ID via `series_info` and merged in — this
   guarantees they show up even if the global list buries them on a page
   we didn't fetch. Find a series ID from its cricketdata.org URL, e.g.
   https://cricketdata.org/cricket-data-formats/series/india-tour-of-england-2026-660b3bb0-...
   → the id is the long code at the end: 660b3bb0-f5ce-453d-835f-5456a1de1c5e */
const PINNED_SERIES = [
  { id: '660b3bb0-f5ce-453d-835f-5456a1de1c5e', label: 'India tour of England, 2026' },
];

const MATCHES_PAGES_TO_FETCH = 4; // pages of ~25 → up to ~100 matches merged

async function loadMatches() {
  const fixturesBox = $('#fixtures-content');
  const resultsBox = $('#results-content');
  if (!fixturesBox.hidden) fixturesBox.innerHTML = '<p class="hint">Loading fixtures…</p>';
  if (!resultsBox.hidden) resultsBox.innerHTML = '<p class="hint">Loading results…</p>';
  try {
    const pagePromises = Array.from({ length: MATCHES_PAGES_TO_FETCH }, (_, i) => callApi('matches', { offset: i * 25 }));
    const seriesPromises = PINNED_SERIES.map((s) => callApi('series_info', { id: s.id }).catch(() => null));
    const [pages, seriesResults] = await Promise.all([Promise.all(pagePromises), Promise.all(seriesPromises)]);

    const merged = [];
    const seenIds = new Set();
    const addMatch = (m) => {
      const id = pick(m, ['id']);
      if (id && seenIds.has(id)) return;
      if (id) seenIds.add(id);
      merged.push(m);
    };

    for (const page of pages) (page.data || []).forEach(addMatch);

    // series_info's match list has shown up under a few different keys
    // across API versions — try the likely ones defensively.
    for (const result of seriesResults) {
      if (!result) continue;
      const list = pick(result.data, ['matchList', 'matches'], null) || (Array.isArray(result.data) ? result.data : []);
      (list || []).forEach(addMatch);
    }

    loaded.matches = true;
    cache.matches = merged;
    renderFixturesPanel();
    renderResultsPanel();
  } catch (err) {
    const msg = `<p class="error-msg">Couldn't load match data: ${escapeHtml(err.message)}</p>`;
    fixturesBox.innerHTML = msg;
    resultsBox.innerHTML = msg;
  }
}

function renderFixturesPanel() {
  const box = $('#fixtures-content');
  const all = cache.matches || [];
  const upcoming = all
    .filter((m) => !pick(m, ['matchStarted']))
    .filter(matchPassesFilter)
    .sort((a, b) => new Date(pick(a, ['dateTimeGMT', 'date'])) - new Date(pick(b, ['dateTimeGMT', 'date'])));

  // Always surface England Men's fixtures first, regardless of date — but
  // only when no more specific filter is already narrowing the list (if
  // you've filtered to e.g. "India", pinning England Men wouldn't make sense).
  let ordered = upcoming;
  let pinnedCount = 0;
  if (activeFilter === 'all') {
    const pinned = upcoming.filter((m) => teamNames(m).some(isEnglandMen));
    const rest = upcoming.filter((m) => !teamNames(m).some(isEnglandMen));
    ordered = [...pinned, ...rest];
    pinnedCount = pinned.length;
  }

  box.innerHTML = '';
  if (!ordered.length) {
    box.innerHTML = '<p class="hint">No upcoming fixtures found for that filter in the current data window.</p>';
    return;
  }
  ordered.forEach((m, i) => box.appendChild(renderFixtureCard(m, false, i < pinnedCount)));
}

function renderResultsPanel() {
  const box = $('#results-content');
  const all = cache.matches || [];
  const finished = all
    .filter((m) => pick(m, ['matchEnded']) || (pick(m, ['matchStarted']) && /won|draw|tied|abandon/i.test(pick(m, ['status'], ''))))
    .filter(matchPassesFilter)
    .sort((a, b) => new Date(pick(b, ['dateTimeGMT', 'date'])) - new Date(pick(a, ['dateTimeGMT', 'date'])));

  box.innerHTML = '';
  if (!finished.length) {
    box.innerHTML = '<p class="hint">No recent results found for that filter in the current data window.</p>';
    return;
  }
  finished.forEach((m) => box.appendChild(renderFixtureCard(m, true, false)));
}

function renderFixtureCard(match, isResult, isPinned = false) {
  const name = pick(match, ['name'], (match.teams || []).join(' vs '));
  const venue = pick(match, ['venue'], '');
  const matchType = pick(match, ['matchType'], '');
  const dateStr = pick(match, ['dateTimeGMT', 'date'], '');
  const status = pick(match, ['status'], '');
  let dateLabel = '';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d)) dateLabel = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: isResult ? undefined : '2-digit', minute: isResult ? undefined : '2-digit' });
  }

  const node = el(`
    <div class="fixture-card ${isResult ? 'result' : ''}" tabindex="0" role="button" aria-label="Open details for ${escapeHtml(name)}">
      <div>
        <div class="fixture-teams">${escapeHtml(name)}${isPinned ? '<span class="pinned-tag">Pinned</span>' : ''}</div>
        <div class="fixture-meta">${escapeHtml([matchType, venue].filter(Boolean).join(' · '))}</div>
        ${isResult ? `<div class="result-line">${escapeHtml(status)}</div>` : ''}
      </div>
      <div class="fixture-date">${escapeHtml(dateLabel)}</div>
    </div>
  `);
  const id = pick(match, ['id']);
  if (id) {
    node.addEventListener('click', () => openScorecard(id));
    node.addEventListener('keypress', (e) => { if (e.key === 'Enter') openScorecard(id); });
  }
  return node;
}

/* ---------------- Scorecard overlay (batting + bowling) ---------------- */
const overlay = $('#scorecard-overlay');
$('#scorecard-close').addEventListener('click', closeScorecard);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeScorecard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeScorecard(); });

function closeScorecard() { overlay.hidden = true; }

async function openScorecard(matchId) {
  overlay.hidden = false;
  const box = $('#scorecard-content');
  box.innerHTML = '<p class="hint">Loading scorecard…</p>';
  try {
    const { data } = await callApi('match_scorecard', { id: matchId });
    box.innerHTML = renderScorecard(data);
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load this scorecard: ${escapeHtml(err.message)}</p>`;
  }
}

function renderScorecard(data) {
  const name = pick(data, ['name'], 'Match scorecard');
  const status = pick(data, ['status'], '');
  const innings = data.scorecard || data.scoreCard || [];

  if (!innings.length) {
    return `
      <h2 style="font-family:var(--font-display); margin-top:0;">${escapeHtml(name)}</h2>
      <p class="hint">${escapeHtml(status)}</p>
      <p class="hint">Detailed ball-by-ball scorecard isn't available for this match yet (it may not have started, or this data isn't included on the current plan).</p>
    `;
  }

  const inningsHtml = innings.map((inn) => {
    const title = pick(inn, ['inning'], 'Innings');
    const batting = inn.batting || [];
    const bowling = inn.bowling || [];

    const battingRows = batting.map((b) => {
      const bname = pick(b, ['batsman.name', 'batsman', 'name'], 'Unknown');
      const dismissal = pick(b, ['dismissal-text', 'dismissal', 'dismissal_text'], b['dismissal-text'] === '' ? 'not out' : '');
      const r = pick(b, ['r', 'runs'], 0);
      const bballs = pick(b, ['b', 'balls'], 0);
      const fours = pick(b, ['4s', 'fours'], 0);
      const sixes = pick(b, ['6s', 'sixes'], 0);
      const sr = pick(b, ['sr', 'strikeRate'], '-');
      return `<tr>
        <td>${escapeHtml(bname)}<div class="dismissal">${escapeHtml(dismissal || 'not out')}</div></td>
        <td class="num">${escapeHtml(r)}</td>
        <td class="num">${escapeHtml(bballs)}</td>
        <td class="num">${escapeHtml(fours)}</td>
        <td class="num">${escapeHtml(sixes)}</td>
        <td class="num">${escapeHtml(sr)}</td>
      </tr>`;
    }).join('');

    const bowlingRows = bowling.map((bw) => {
      const wname = pick(bw, ['bowler.name', 'bowler', 'name'], 'Unknown');
      const o = pick(bw, ['o', 'overs'], 0);
      const m = pick(bw, ['m', 'maidens'], 0);
      const r = pick(bw, ['r', 'runs'], 0);
      const w = pick(bw, ['w', 'wickets'], 0);
      const eco = pick(bw, ['eco', 'economy'], '-');
      return `<tr>
        <td>${escapeHtml(wname)}</td>
        <td class="num">${escapeHtml(o)}</td>
        <td class="num">${escapeHtml(m)}</td>
        <td class="num">${escapeHtml(r)}</td>
        <td class="num">${escapeHtml(w)}</td>
        <td class="num">${escapeHtml(eco)}</td>
      </tr>`;
    }).join('');

    return `
      <div class="innings-title">${escapeHtml(title)}</div>
      ${batting.length ? `
      <table class="linescore">
        <thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr></thead>
        <tbody>${battingRows}</tbody>
      </table>` : ''}
      ${bowling.length ? `
      <table class="linescore" style="margin-top:12px;">
        <thead><tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead>
        <tbody>${bowlingRows}</tbody>
      </table>` : ''}
    `;
  }).join('');

  return `
    <h2 style="font-family:var(--font-display); margin-top:0;">${escapeHtml(name)}</h2>
    <p class="hint">${escapeHtml(status)}</p>
    ${inningsHtml}
  `;
}

/* ---------------- Players ---------------- */
$('#player-search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#player-search-input').value.trim();
  if (!q) return;
  const box = $('#players-content');
  box.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const { data } = await callApi('players_info', { search: q });
    if (!data || !data.length) {
      box.innerHTML = '<p class="hint">No players found. Try a different spelling.</p>';
      return;
    }
    box.innerHTML = '';
    data.slice(0, 15).forEach((p) => {
      const node = el(`
        <div class="player-card" tabindex="0" role="button">
          <span class="player-name">${escapeHtml(pick(p, ['name'], 'Unknown'))}</span>
          <span class="player-country">${escapeHtml(pick(p, ['country'], ''))}</span>
        </div>
      `);
      const id = pick(p, ['id']);
      node.addEventListener('click', () => id && openPlayer(id));
      box.appendChild(node);
    });
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Search failed: ${escapeHtml(err.message)}</p>`;
  }
});

async function openPlayer(playerId) {
  const box = $('#players-content');
  box.innerHTML = '<p class="hint">Loading player…</p>';
  try {
    const { data } = await callApi('playerStats', { id: playerId });
    const name = pick(data, ['name'], 'Player');
    const country = pick(data, ['country'], '');
    const role = pick(data, ['role'], '');
    const stats = data.stats || [];

    const statBoxes = stats.map((s) => {
      const label = [pick(s, ['fn']), pick(s, ['matchtype'])].filter(Boolean).join(' · ');
      const bits = Object.entries(s).filter(([k]) => !['fn', 'matchtype'].includes(k));
      return `<div class="stat-box">
        <div class="label">${escapeHtml(label || 'Stats')}</div>
        ${bits.map(([k, v]) => `<div class="value" style="font-size:.95rem;">${escapeHtml(k)}: ${escapeHtml(v)}</div>`).join('')}
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="player-card" style="cursor:default;">
        <span class="player-name">${escapeHtml(name)}</span>
        <span class="player-country">${escapeHtml([country, role].filter(Boolean).join(' · '))}</span>
      </div>
      ${stats.length ? `<div class="stat-grid">${statBoxes}</div>` : '<p class="hint">No detailed stats available for this player on the current plan.</p>'}
      <p style="margin-top:16px;"><button class="refresh-btn" id="back-to-search">← New search</button></p>
    `;
    $('#back-to-search').addEventListener('click', () => { box.innerHTML = ''; $('#player-search-input').value = ''; $('#player-search-input').focus(); });
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load player: ${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------- Boot ---------------- */
loadLive();
startLivePolling();
