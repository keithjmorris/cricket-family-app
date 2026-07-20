// app.js — talks only to our own /api/cricket proxy, never to Highlightly
// directly (the API key lives server-side only, see api/cricket.js).

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

async function callApi(path, params = {}) {
  const url = new URL('/api/cricket', window.location.origin);
  url.searchParams.set('path', path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// Tries a list of possible property paths — kept from the earlier version
// since Highlightly's own fields occasionally come back null rather than
// omitted, and this treats both the same way.
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

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/* ---------------- Shared data cache ---------------- */
const cache = {
  live: null,     // normalized array, built from today's + yesterday's matches
  matches: null,  // normalized array, built from a date-range sweep — shared by Fixtures AND Results
};

/* ---------------- Team filter ---------------- */
let activeFilter = 'all'; // 'all' | 'england' | free-text search (team OR competition/format)

function teamNames(match) { return (match.teams || []).map(String); }
function isEngland(name) { return /england/i.test(name); }

// For the free-text box, search across team names, format (T20/ODI/Test),
// and competition/league name (already folded into `name`, e.g.
// "...vs..., The Hundred Men's Competition 2026") — so typing "IPL" or
// "T20" or "The Hundred" all work, not just team names.
function matchSearchHaystack(match) {
  return [...(match.teams || []), match.matchType, match.name].filter(Boolean).join(' ').toLowerCase();
}

function matchPassesFilter(match) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'england') return teamNames(match).some(isEngland);
  const q = activeFilter.toLowerCase();
  return matchSearchHaystack(match).includes(q);
}

function setActiveFilter(filter) {
  activeFilter = filter;
  $$('.filter-chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter)));
  if (filter === 'all' || filter === 'england') {
    $('#filter-search-input').value = '';
  }
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

/* ---------------- Auto-refresh ----------------
   Live scores poll automatically, but ONLY while the Live tab is showing
   AND the browser tab itself is in the foreground. On the 7,500 requests/
   day Highlightly plan this can run considerably faster than the old
   cricketdata.org setup allowed. */
const LIVE_POLL_MS = 20000; // 20 seconds
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

/* ---------------- Normalizing Highlightly matches ----------------
   Highlightly's match shape (homeTeam/awayTeam objects, state.description,
   startTime, format, league) is different from what the rest of this file
   was originally built around — so everything gets converted once, here,
   into a common shape the render functions below already know how to draw:
   { id, name, teams[], matchType, dateTimeGMT, status, score[],
     matchStarted, matchEnded }. */
const LIVE_STATES = ['In play', 'Stumps', 'Lunch', 'Innings break', 'Drinks', 'Timeout', 'Tea'];
const FINISHED_STATES = ['Finished', 'Abandoned', 'Cancelled'];

function parseHlTeamScore(scoreStr, infoStr) {
  const m = String(scoreStr || '').match(/(\d+)\s*\/\s*(\d+)/);
  const oMatch = String(infoStr || '').match(/([\d.]+)\s*ov/);
  return {
    r: m ? m[1] : '-',
    w: m ? m[2] : '-',
    o: oMatch ? oMatch[1] : '',
  };
}

function normalizeMatch(m) {
  const home = m.homeTeam || {};
  const away = m.awayTeam || {};
  const teams = [home.name, away.name].filter(Boolean);
  const desc = pick(m, ['state.description'], '');
  const isLive = LIVE_STATES.includes(desc);
  const isFinished = FINISHED_STATES.includes(desc);

  const score = [];
  const stateTeams = m.state && m.state.teams;
  if (stateTeams) {
    if (home.name && stateTeams.home) score.push({ inning: home.name, ...parseHlTeamScore(stateTeams.home.score, stateTeams.home.info) });
    if (away.name && stateTeams.away) score.push({ inning: away.name, ...parseHlTeamScore(stateTeams.away.score, stateTeams.away.info) });
  }

  return {
    id: m.id,
    name: teams.join(' vs ') + (m.league ? `, ${m.league.name}` : ''),
    teams,
    matchType: m.format,
    dateTimeGMT: m.startTime || m.startDate,
    status: pick(m, ['state.report'], desc),
    score,
    matchStarted: isLive || isFinished,
    matchEnded: isFinished,
  };
}

function mergeById(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const m of list || []) {
      const id = pick(m, ['id']);
      const key = id || JSON.stringify(m);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
  }
  return merged;
}

/* ---------------- Live ----------------
   Highlightly doesn't have a single "current live matches" endpoint — it's
   built from querying by date. Today's and yesterday's dates cover matches
   still running past midnight UTC (e.g. Tests, or a match that started late
   yesterday) without needing to sweep a wide range every poll. */
async function loadLive(forceFresh = false) {
  const box = $('#live-content');
  if (!cache.live || forceFresh) box.innerHTML = '<p class="hint">Loading live matches…</p>';
  try {
    const [today, yesterday] = await Promise.all([
      callApi('matches', { date: todayISO(0) }),
      callApi('matches', { date: todayISO(-1) }),
    ]);
    const merged = mergeById(today.data, yesterday.data);
    loaded.live = true;
    cache.live = merged.map(normalizeMatch);
    renderLivePanel();
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load live scores: ${escapeHtml(err.message)}</p>`;
  }
}

function renderLivePanel() {
  const box = $('#live-content');
  const all = cache.live || [];
  const filtered = all.filter(matchPassesFilter);
  const live = filtered.filter((m) => m.matchStarted && !m.matchEnded);
  const recentlyDone = filtered.filter((m) => m.matchEnded);

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
    const inningTeam = pick(s, ['inning'], '');
    const r = pick(s, ['r'], '-');
    const w = pick(s, ['w'], '-');
    const o = pick(s, ['o'], '');
    return `<div class="board-row">
      <span class="board-team">${escapeHtml(inningTeam)}</span>
      <span class="board-score">${escapeHtml(r)}/${escapeHtml(w)}${o ? ` <span style="opacity:.6">(${escapeHtml(o)} ov)</span>` : ''}</span>
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
   Highlightly's /matches requires at least one "primary" query parameter —
   there's no open-ended "everything upcoming" call. So this sweeps a fixed
   date window (a few days back, plus a week and a half forward) with one
   call per day, merges the results, and lets the existing team filters and
   upcoming/finished classification work exactly as they did before. */
const FIXTURES_DAYS_PAST = 3;
const FIXTURES_DAYS_FUTURE = 10;

// Highlightly can be queried directly by team name, with no date limit —
// "pass a date, a league, a country code, or a team name; a single
// parameter is all you need" per their docs. That's a much better way to
// guarantee England's fixtures show up months out than sweeping every date
// between now and December (which would mean 100+ extra requests every
// time Fixtures is opened). Both the men's and women's team names are
// queried, as home AND away, so a full season shows regardless of venue.
const PRIORITY_TEAM_NAMES = ['England', 'England Women'];

async function fetchPriorityTeamMatches() {
  const calls = PRIORITY_TEAM_NAMES.flatMap((name) => [
    callApi('matches', { homeTeamName: name }).catch(() => ({ data: [] })),
    callApi('matches', { awayTeamName: name }).catch(() => ({ data: [] })),
  ]);
  const results = await Promise.all(calls);
  return mergeById(...results.map((r) => r.data || []));
}

async function loadMatches() {
  const fixturesBox = $('#fixtures-content');
  const resultsBox = $('#results-content');
  if (!fixturesBox.hidden) fixturesBox.innerHTML = '<p class="hint">Loading fixtures…</p>';
  if (!resultsBox.hidden) resultsBox.innerHTML = '<p class="hint">Loading results…</p>';
  try {
    const offsets = [];
    for (let i = -FIXTURES_DAYS_PAST; i <= FIXTURES_DAYS_FUTURE; i++) offsets.push(i);
    const datePromises = offsets.map((offset) => callApi('matches', { date: todayISO(offset) }));
    const [pages, priorityMatches] = await Promise.all([Promise.all(datePromises), fetchPriorityTeamMatches()]);
    const merged = mergeById(...pages.map((p) => p.data || []), priorityMatches);

    loaded.matches = true;
    cache.matches = merged.map(normalizeMatch);
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
  const now = Date.now();
  const upcoming = all
    .filter((m) => !m.matchStarted)
    // Belt-and-braces: Highlightly occasionally has provisional/placeholder
    // fixtures that aren't flagged as started but whose date has already
    // passed (likely unconfirmed scheduling data) — a genuinely future
    // date is required here too, not just the flag, to keep those out of
    // "upcoming" and out of the sort order mess they'd otherwise cause.
    .filter((m) => {
      const d = new Date(pick(m, ['dateTimeGMT']));
      return isNaN(d) || d.getTime() > now;
    })
    .filter(matchPassesFilter)
    .sort((a, b) => new Date(pick(a, ['dateTimeGMT'])) - new Date(pick(b, ['dateTimeGMT'])));

  // Always surface England's fixtures first, regardless of date — but
  // only when no more specific filter is already narrowing the list.
  let ordered = upcoming;
  let pinnedCount = 0;
  if (activeFilter === 'all') {
    const pinned = upcoming.filter((m) => teamNames(m).some(isEngland));
    const rest = upcoming.filter((m) => !teamNames(m).some(isEngland));
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
    .filter((m) => m.matchEnded)
    .filter(matchPassesFilter)
    .sort((a, b) => new Date(pick(b, ['dateTimeGMT'])) - new Date(pick(a, ['dateTimeGMT'])));

  box.innerHTML = '';
  if (!finished.length) {
    box.innerHTML = '<p class="hint">No recent results found for that filter in the current data window.</p>';
    return;
  }
  finished.forEach((m) => box.appendChild(renderFixtureCard(m, true, false)));
}

function renderFixtureCard(match, isResult, isPinned = false) {
  const name = pick(match, ['name'], (match.teams || []).join(' vs '));
  const matchType = pick(match, ['matchType'], '');
  const dateStr = pick(match, ['dateTimeGMT'], '');
  const status = pick(match, ['status'], '');
  let dateLabel = '';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d)) dateLabel = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: isResult ? undefined : '2-digit', minute: isResult ? undefined : '2-digit' });
  }

  const node = el(`
    <div class="fixture-card ${isResult ? 'result' : ''}" tabindex="0" role="button" aria-label="Open details for ${escapeHtml(name)}">
      <div>
        <div class="fixture-teams">${escapeHtml(name)}${isPinned ? '<span class="pinned-tag">Pinned</span>' : ''}</div>
        <div class="fixture-meta">${escapeHtml(matchType || '')}</div>
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
    const result = await callApi(`matches/${matchId}`);
    // Highlightly wraps a single match-detail result in an array.
    const data = Array.isArray(result) ? result[0] : (result.data ? result.data[0] || result.data : result);
    if (!data) {
      box.innerHTML = '<p class="hint">No scorecard details are available for this match.</p>';
      return;
    }
    box.innerHTML = renderScorecard(data);
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load this scorecard: ${escapeHtml(err.message)}</p>`;
  }
}

function renderScorecard(data) {
  const home = data.homeTeam || {};
  const away = data.awayTeam || {};
  const teams = [home.name, away.name].filter(Boolean);
  const name = teams.join(' vs ') + (data.league ? `, ${data.league.name}` : '');
  const status = pick(data, ['state.report'], pick(data, ['state.description'], ''));
  const innings = data.statistics || [];

  // Highlightly's `inplayData` covers the batters/bowlers currently active
  // in a live innings — the main `statistics` breakdown below only seems
  // to fill in properly once a player is out or an innings has finished,
  // so without this, a fast-moving live match can look nearly empty.
  const inplay = data.inplayData || {};
  const inplayBatsmen = inplay.batsmen || [];
  const inplayBowlers = inplay.bowlers || [];

  let inplayHtml = '';
  if (inplayBatsmen.length || inplayBowlers.length) {
    const batRows = inplayBatsmen.map((b) => {
      const bname = pick(b, ['player.name'], 'Unknown');
      const s = (b.player && b.player.statistics) || {};
      return `<tr>
        <td>${escapeHtml(bname)}</td>
        <td class="num">${escapeHtml(pick(s, ['runs'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['balls'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['fours'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['sixes'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['strikeRate'], '-'))}</td>
      </tr>`;
    }).join('');
    const bowlRows = inplayBowlers.map((bw) => {
      const wname = pick(bw, ['player.name'], 'Unknown');
      const s = (bw.player && bw.player.statistics) || {};
      return `<tr>
        <td>${escapeHtml(wname)}</td>
        <td class="num">${escapeHtml(pick(s, ['overs'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['runsConceded'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['wickets'], 0))}</td>
        <td class="num">${escapeHtml(pick(s, ['economy'], '-'))}</td>
      </tr>`;
    }).join('');
    inplayHtml = `
      <div class="innings-title">At the crease now</div>
      ${batRows ? `
      <table class="linescore">
        <thead><tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr></thead>
        <tbody>${batRows}</tbody>
      </table>` : ''}
      ${bowlRows ? `
      <table class="linescore" style="margin-top:12px;">
        <thead><tr><th>Bowler</th><th class="num">O</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr></thead>
        <tbody>${bowlRows}</tbody>
      </table>` : ''}
    `;
  }

  if (!innings.length && !inplayHtml) {
    return `
      <h2 style="font-family:var(--font-display); margin-top:0;">${escapeHtml(name)}</h2>
      <p class="hint">${escapeHtml(status)}</p>
      <p class="hint">Detailed scorecard isn't available for this match yet.</p>
    `;
  }

  const inningsHtml = innings.map((inn) => {
    const title = pick(inn, ['name'], pick(inn, ['team.name'], 'Innings'));
    const batting = ((inn.team && inn.team.inningBatsmen) || []).filter((b) => (b.runs !== null && b.runs !== undefined) || b.dismissalStatus);
    const bowling = ((inn.team && inn.team.inningBowlers) || []).filter((b) => b.overs !== null && b.overs !== undefined);

    const battingRows = batting.map((b) => {
      const bname = pick(b, ['player.name'], 'Unknown');
      const dismissalStatus = pick(b, ['dismissalStatus'], '');
      const fielders = (b.dismissalFielders || []).map((f) => f.name).filter(Boolean).join(', ');
      const dismissal = dismissalStatus === 'not out' || !dismissalStatus
        ? 'not out'
        : `${dismissalStatus}${fielders ? ` (${fielders})` : ''}`;
      const r = pick(b, ['runs'], 0);
      const bballs = pick(b, ['balls'], 0);
      const fours = pick(b, ['fours'], 0);
      const sixes = pick(b, ['sixes'], 0);
      const sr = pick(b, ['battingStrikeRate'], '-');
      return `<tr>
        <td>${escapeHtml(bname)}<div class="dismissal">${escapeHtml(dismissal)}</div></td>
        <td class="num">${escapeHtml(r)}</td>
        <td class="num">${escapeHtml(bballs)}</td>
        <td class="num">${escapeHtml(fours)}</td>
        <td class="num">${escapeHtml(sixes)}</td>
        <td class="num">${escapeHtml(sr)}</td>
      </tr>`;
    }).join('');

    const bowlingRows = bowling.map((bw) => {
      const wname = pick(bw, ['player.name'], 'Unknown');
      const o = pick(bw, ['overs'], 0);
      const m = pick(bw, ['maidens'], 0);
      const r = pick(bw, ['concededRuns'], 0);
      const w = pick(bw, ['wickets'], 0);
      const eco = pick(bw, ['economy'], '-');
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
    ${inplayHtml}
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
    const { data } = await callApi('players', { name: q });
    if (!data || !data.length) {
      box.innerHTML = '<p class="hint">No players found. Try a different spelling.</p>';
      return;
    }
    box.innerHTML = '';
    data.slice(0, 15).forEach((p) => {
      const currentTeam = (p.teams || []).find((t) => t.isCurrent) || (p.teams || [])[0];
      const node = el(`
        <div class="player-card" tabindex="0" role="button">
          <span class="player-name">${escapeHtml(pick(p, ['longName'], 'Unknown'))}</span>
          <span class="player-country">${escapeHtml(currentTeam ? currentTeam.abbreviation : '')}</span>
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
    const result = await callApi(`players/${playerId}`);
    const data = Array.isArray(result) ? result[0] : result;
    if (!data) {
      box.innerHTML = '<p class="hint">Couldn\'t find that player.</p>';
      return;
    }
    const name = pick(data, ['longName'], 'Player');
    const battingStyle = (data.longBattingStyles || [])[0] || '';
    const bowlingStyle = (data.longBowlingStyles || [])[0] || '';
    const summary = data.summary || [];

    // Show the most recent year on record for each format, as a snapshot —
    // full year-by-year detail is in the API but would be a lot to list here.
    const formatBoxes = summary.map((fmt) => {
      const battingYears = fmt.batting || [];
      const bowlingYears = fmt.bowling || [];
      const latestBatting = battingYears[battingYears.length - 1];
      const latestBowling = bowlingYears[bowlingYears.length - 1];
      const battingStats = latestBatting ? (latestBatting.statistics || []).map((s) => `${s.displayName}: ${s.value}`).join(' · ') : '';
      const bowlingStats = latestBowling ? (latestBowling.statistics || []).map((s) => `${s.displayName}: ${s.value}`).join(' · ') : '';
      return `<div class="stat-box">
        <div class="label">${escapeHtml(fmt.format || 'Format')}${latestBatting ? ` · ${escapeHtml(latestBatting.year)}` : ''}</div>
        ${battingStats ? `<div class="value" style="font-size:.85rem; line-height:1.5;">${escapeHtml(battingStats)}</div>` : ''}
        ${bowlingStats ? `<div class="value" style="font-size:.85rem; line-height:1.5; color:var(--cream-dim);">${escapeHtml(bowlingStats)}</div>` : ''}
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="player-card" style="cursor:default;">
        <span class="player-name">${escapeHtml(name)}</span>
        <span class="player-country">${escapeHtml([battingStyle, bowlingStyle].filter(Boolean).join(' · '))}</span>
      </div>
      ${summary.length ? `<div class="stat-grid">${formatBoxes}</div>` : '<p class="hint">No detailed stats available for this player.</p>'}
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
