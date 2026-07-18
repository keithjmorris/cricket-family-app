# Boundary — Family Cricket Board

A simple cricket dashboard for the family: live scores, fixtures, results, and
player batting/bowling stats, powered by the free tier of
[cricketdata.org](https://cricketdata.org).

- **Frontend:** plain HTML/CSS/JS (no build step, no framework)
- **Backend:** one Vercel serverless function (`/api/cricket.js`) that holds
  the API key and proxies requests to cricketdata.org
- **Hosting:** Vercel
- **Repo:** GitHub

The API key never reaches the browser — see "Why a serverless function?" below
if you want the reasoning.

---

## 1. Get a free API key

1. Sign up at [cricketdata.org/member.aspx](https://cricketdata.org/member.aspx) (free, no card needed).
2. Copy your API key from your member area.
3. The free tier gives you **100 requests/day**. This project caches
   responses at Vercel's edge (60s for live scores, 5 minutes for fixtures/
   results, 1 hour for player data) specifically to stay well inside that
   limit even with several family members using it at once.

## 2. Open the project in VS Code

Unzip/copy this folder, then open it in VS Code as usual.

## 3. Set up your local environment variable

```bash
cp .env.example .env
```

Open `.env` and paste your real key in place of `your_key_here`:

```
CRICKET_API_KEY=abcd1234-your-real-key
```

`.env` is already listed in `.gitignore`, so it will never be committed to
GitHub — only `.env.example` (which has no real key in it) gets checked in.

## 4. Run it locally

This project uses Vercel's own local dev server, since it needs to run the
serverless function as well as serve the static files.

```bash
npm install -g vercel   # one-time, if you don't have it already
vercel dev
```

Follow the prompts (link or create a Vercel project when asked). Then open
the local URL it gives you (typically `http://localhost:3000`).

If a match happens to be live when you test, check the Live tab. Otherwise
try Fixtures, Results, and searching a well-known player name in Players —
all of those work regardless of whether anything is live right now.

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
   - Name: `CRICKET_API_KEY`
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

If the HTML/JS called cricketdata.org directly from the browser, the API key
would have to be embedded in that JavaScript — and anyone in the family (or
anyone who found the link) could open browser dev tools and read it straight
out of the page. `/api/cricket.js` runs on Vercel's servers instead, reads
the key from the environment variable there, and is the only thing that ever
talks to cricketdata.org. The browser only ever talks to your own `/api`
endpoint.

## A note on the scorecard view

The batting/bowling scorecard rendering (`renderScorecard` in `app.js`) is
built against cricketdata.org's documented response shape, but the exact
field names in their JSON have shifted slightly across API versions in the
past. It's written defensively (it tries a few likely field names before
giving up), but once you have a real key, it's worth opening a live match's
scorecard and checking it renders as expected. If a field's ever blank where
you'd expect a number, open browser dev tools → Network tab → find the
`match_scorecard` request → look at the raw JSON, and I can adjust the
matching field name in a couple of lines.

## Project structure

```
├── api/
│   └── cricket.js       ← serverless proxy (holds the API key)
├── index.html            ← page shell + tabs
├── style.css              ← "pavilion scoreboard" visual theme
├── app.js                 ← all frontend fetch/render logic
├── .env.example            ← template — copy to .env, add your real key
├── .gitignore
└── package.json
```
