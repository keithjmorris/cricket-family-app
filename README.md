# Boundary — Family Cricket Board

A simple cricket dashboard for the family: live scores, fixtures, results, and
player batting/bowling stats, powered by the [Highlightly Cricket API](https://highlightly.net/cricket-api/).

- **Frontend:** plain HTML/CSS/JS (no build step, no framework)
- **Backend:** one Vercel serverless function (`/api/cricket.js`) that holds
  the API key and proxies requests to Highlightly
- **Hosting:** Vercel
- **Repo:** GitHub

The API key never reaches the browser — see "Why a serverless function?" below
if you want the reasoning.

---

## 1. Get an API key

Sign up at [highlightly.net](https://highlightly.net) (or via RapidAPI, if
that's where you subscribed) and grab your key from the dashboard.

This project was built and switched over to Highlightly's paid tier
(7,500 requests/day) after cricketdata.org's free tier turned out to have
gaps in its coverage of major England series specifically. Live polling and
caching lifetimes in this project (see `api/cricket.js` and `app.js`) are
tuned around that 7,500/day budget — if you're on a smaller plan, those
numbers are worth turning down.

## 2. Open the project in VS Code

Unzip/copy this folder, then open it in VS Code as usual.

## 3. Set up your local environment variable

```bash
cp .env.example .env
```

Open `.env` and paste your real key in place of `your_key_here`:

```
HIGHLIGHTLY_API_KEY=your-real-key
```

`.env` is already listed in `.gitignore`, so it will never be committed to
GitHub — only `.env.example` (which has no real key in it) gets checked in.

## 4. Run it locally

```bash
npm install -g vercel   # one-time, if you don't have it already
vercel dev
```

Follow the prompts (link or create a Vercel project when asked). Then open
the local URL it gives you (typically `http://localhost:3000`).

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial version of Boundary cricket dashboard"
```

Create a new empty repo on GitHub, then:

```bash
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## 6. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com), sign in, choose **New Project**,
   and import your GitHub repo.
2. Before the first deploy, add the environment variable: **Settings → 
   Environment Variables** →
   - Name: `HIGHLIGHTLY_API_KEY`
   - Value: your real key
   - Environment: Production (and Preview, if you want preview deploys to
     work too)
3. Deploy. Vercel will detect the `/api` folder automatically and turn
   `cricket.js` into a serverless function — no extra config needed.

Share the resulting `*.vercel.app` URL with the family.

## 7. If you ever rotate the key

Update it in **Vercel → Settings → Environment Variables**, and in your local
`.env`. No code changes needed either place.

---

## Why a serverless function, not just a static site?

If the HTML/JS called Highlightly directly from the browser, the API key
would have to be embedded in that JavaScript — and anyone in the family (or
anyone who found the link) could open browser dev tools and read it straight
out of the page. `/api/cricket.js` runs on Vercel's servers instead, reads
the key from the environment variable there, and is the only thing that ever
talks to Highlightly. The browser only ever talks to your own `/api`
endpoint.

## How this differs from the previous cricketdata.org version

- **Auth:** Highlightly uses a header (`x-rapidapi-key`), not a URL query
  parameter — so the proxy passes a `path` parameter (e.g.
  `path=matches&date=2026-07-19`) and attaches the header server-side.
- **No "pinned series" workaround needed:** cricketdata.org's `matches`
  endpoint returned a huge, oddly-ordered global list that could bury a
  specific match on a page never fetched — that's what caused most of the
  England-v-India headaches. Highlightly's `/matches` endpoint is queried
  by date instead, so Fixtures/Results sweep a fixed date window
  (`FIXTURES_DAYS_PAST`/`FIXTURES_DAYS_FUTURE` in `app.js`) and nothing gets
  missed by ordering.
- **Live tab** is built from today's + yesterday's date (Highlightly has no
  single "currently live" endpoint) rather than a dedicated live feed.
- **Scorecard detail** comes from `/matches/{id}`, which — unlike
  cricketdata.org's `match_scorecard` — actually has real batting/bowling
  data for England's international matches.

## Project structure

```
├── api/
│   └── cricket.js       ← serverless proxy (holds the API key)
├── index.html            ← page shell + tabs
├── style.css              ← "pavilion scoreboard" visual theme
├── app.js                 ← all frontend fetch/render logic
├── manifest.webmanifest    ← app icon metadata for home-screen installs
├── icon-192.png / icon-512.png
├── .env.example            ← template — copy to .env, add your real key
├── .gitignore
└── package.json
```
