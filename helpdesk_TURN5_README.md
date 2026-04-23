# ADVANCED Helpdesk — Deployment Guide

A standalone IT ticketing portal with persistent server-side storage. Tickets submitted by any user are visible to the IT manager from any computer — true shared state, not per-browser localStorage.

## What's in this bundle

```
.
├── server.js         — Express server with REST API + Railway volume persistence
├── package.json      — Node manifest
└── public/
    └── index.html    — The full helpdesk frontend (end-user wizard + IT admin console)
```

## Deploy to Railway — step by step

### Step 1. Push to a new GitHub repo

1. Create a new private repo: `advanced-helpdesk`
2. Upload all three files (`server.js`, `package.json`, `public/index.html`) preserving the folder structure
3. Commit

### Step 2. Create the Railway project

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick `advanced-helpdesk`
2. Wait ~30 seconds for the first deploy

### Step 3. **CRITICAL — Add a persistent Volume** (this is what makes data survive restarts and be shared across browsers)

1. In your Railway project → click your service → **Settings** tab
2. Scroll to **Volumes** → click **+ New Volume**
3. **Mount Path:** `/data`
4. Click **Add**
5. Service redeploys automatically

### Step 4. Tell the server to use that volume

1. Still in **Settings** → scroll to **Variables**
2. Click **+ New Variable**
3. **Key:** `DATA_DIR`
4. **Value:** `/data`
5. Save

### Step 5. Generate a public URL

1. Settings → **Networking** → **Generate Domain**
2. You get something like `advanced-helpdesk-production.up.railway.app`

### Step 6. Test it

1. Open the URL on your phone — submit a test ticket
2. Open the same URL on your desktop browser → click **IT Login** → password `advanced`
3. **You should see the ticket from your phone** — that's how you know persistence works

### Step 7. Lock it down

1. In the admin console → **Settings** → change the admin password
2. The new password persists to the server, so use it everywhere

### Step 8. Add to Command Center launchpad

In Command Center → External Dashboards → **+ Add Custom Tile**:
- **Name:** `Helpdesk Portal`
- **URL:** your Railway URL
- **Tag:** `Helpdesk`

Bookmark `<your-url>/#admin` for yourself — it auto-opens the IT login modal.

## How persistence works

**Source of truth:** the JSON file on the Railway Volume at `/data/helpdesk_db.json`. Backups stored in `/data/backups/` (last 20 kept).

**Frontend behavior:**
- On page load: fetches `/api/db` from the server, falls back to localStorage if server is unreachable
- On every save: writes to localStorage instantly + pushes to server (debounced 400ms)
- Every 10 seconds: polls server for new data — admin sees newly-submitted tickets without refreshing
- On page unload: uses `sendBeacon` to push any pending save reliably

**Sync indicator:** the admin topbar shows a small pill — `● Synced` (green), `⟳ Saving…` (amber, pulsing), or `⚠ Offline` (red) — so you always know the state.

**End-user submit:** uses the atomic `/api/ticket` endpoint so two simultaneous submitters can't collide on the same ticket #.

## API endpoints (for reference)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/db` | Fetch full DB |
| POST | `/api/save` | Overwrite full DB |
| POST | `/api/ticket` | Submit a new ticket atomically (server assigns ID) |
| PUT | `/api/ticket/:id` | Update a single ticket |
| POST | `/api/settings` | Patch settings only |
| POST | `/api/backup` | Manually trigger backup |
| GET | `/health` | Service health + DATA_DIR location |

## Troubleshooting

**Tickets disappear after Railway redeploys** → You forgot Step 3. Add the Volume at `/data` and set `DATA_DIR=/data`. Without the volume, data lives in container ephemeral storage and gets wiped on every redeploy.

**Sync pill shows "Offline" permanently** → Server is unreachable. Check Railway logs (Service → Deployments → Logs) for crash messages. Hit `/health` to see what state the server is in.

**End user submits a ticket but admin doesn't see it** → Check the sync pill. If it's green ("Synced"), the data IS on the server. Refresh the admin console. If still not visible, check Railway logs for `/api/ticket` errors.

**Admin password change didn't stick** → Password is stored in `DB.settings.adminPassword` which is in the server's DB file. Confirm the sync pill went green after you saved. If not, the change only saved to your local browser.
