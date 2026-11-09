# Sticker Art CRM

Bryant's own replacement for Highrise and the Outreach Tracker.

- **Data:** Supabase (Postgres). Schema in `supabase/schema.sql`.
- **Website:** plain HTML/JS in `public/` (no build step). Hosted on Cloudflare Workers (free) with the code in `src/worker.js`.
- **Claude access:** an MCP server built into the same Worker at `/mcp/<MCP_SECRET>`. Add that URL as a custom connector in claude.ai.
- **Editing:** any editor works (GitHub web editor, Replit, VS Code). Push to `main` and Cloudflare redeploys.

## What's where

| Path | What |
|---|---|
| `public/index.html`, `public/app.js`, `public/style.css` | The web app: Today list, Stores (filters, search), store page with timeline, Tasks, Orders, Activity |
| `public/config.js` | Supabase URL and public (anon) key. Safe to publish; the database only lets signed-in users in. |
| `src/worker.js` | Serves the site and the MCP server for Claude |
| `supabase/schema.sql` | Tables: stores, contacts, timeline, tasks, orders |
| `scripts/` | One-time import from Highrise and the Outreach Tracker |

## Deploy by hand

```
npm install -g wrangler
wrangler login
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put CRM_KEY
wrangler secret put MCP_SECRET
wrangler deploy
```

## Running without Claude or Replit

Everything is a normal website on your own Supabase and Cloudflare accounts. Sign in, add stores, notes, people and tasks by hand. Back up any time from Supabase (Database → Backups, or Table editor → Export CSV).
