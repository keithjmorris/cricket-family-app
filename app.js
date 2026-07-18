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

/* ---------------- Tabs ---------------- */
const loaded = { live: false, fixtures: false, results: false };

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
    tab.setAttribute('aria-selected', 'true');
    const name = tab.dataset.tab;
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'live' && !loaded.live) loadLive();
    if (name === 'fixtures' && !loaded.fixtures) loadFixtures();
    if (name === 'results' && !loaded.results) loadResults();
  });
});

$('#refresh-live').addEventListener('click', () => loadLive());

/* ---------------- Live ---------------- */
async function loadLive() {
  const box = $('#live-content');
  box.innerHTML = '<p class="hint">Loading live matches…</p>';
  try {
    const { data } = await callApi('currentMatches');
    loaded.live = true;
    const live = (data || []).filter((m) => pick(m, ['matchStarted']) && !pick(m, ['matchEnded']));
    const recentlyDone = (data || []).filter((m) => pick(m, ['matchEnded']));

    box.innerHTML = '';
    if (!live.length && !recentlyDone.length) {
      box.innerHTML = '<p class="hint">No live matches right now. Check back nearer match time, or see Fixtures.</p>';
      return;
    }
    live.forEach((m) => box.appendChild(renderScoreboard(m, 'live')));
    recentlyDone.forEach((m) => box.appendChild(renderScoreboard(m, 'done')));
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load live scores: ${escapeHtml(err.message)}</p>`;
  }
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

/* ---------------- Fixtures ---------------- */
async function loadFixtures() {
  const box = $('#fixtures-content');
  box.innerHTML = '<p class="hint">Loading fixtures…</p>';
  try {
    const { data } = await callApi('matches');
    loaded.fixtures = true;
    const upcoming = (data || [])
      .filter((m) => !pick(m, ['matchStarted']))
      .sort((a, b) => new Date(pick(a, ['dateTimeGMT', 'date'])) - new Date(pick(b, ['dateTimeGMT', 'date'])));

    box.innerHTML = '';
    if (!upcoming.length) {
      box.innerHTML = '<p class="hint">No upcoming fixtures found in the current data window.</p>';
      return;
    }
    upcoming.forEach((m) => box.appendChild(renderFixtureCard(m, false)));
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load fixtures: ${escapeHtml(err.message)}</p>`;
  }
}

/* ---------------- Results ---------------- */
async function loadResults() {
  const box = $('#results-content');
  box.innerHTML = '<p class="hint">Loading results…</p>';
  try {
    const { data } = await callApi('matches');
    loaded.results = true;
    const finished = (data || [])
      .filter((m) => pick(m, ['matchEnded']) || (pick(m, ['matchStarted']) && /won|draw|tied|abandon/i.test(pick(m, ['status'], ''))))
      .sort((a, b) => new Date(pick(b, ['dateTimeGMT', 'date'])) - new Date(pick(a, ['dateTimeGMT', 'date'])));

    box.innerHTML = '';
    if (!finished.length) {
      box.innerHTML = '<p class="hint">No recent results found in the current data window.</p>';
      return;
    }
    finished.forEach((m) => box.appendChild(renderFixtureCard(m, true)));
  } catch (err) {
    box.innerHTML = `<p class="error-msg">Couldn't load results: ${escapeHtml(err.message)}</p>`;
  }
}

function renderFixtureCard(match, isResult) {
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
        <div class="fixture-teams">${escapeHtml(name)}</div>
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
