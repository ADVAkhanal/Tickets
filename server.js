// ═══════════════════════════════════════════════════════════════
// ADVANCED Helpdesk — server with Railway persistent storage
// Same pattern as Command Center: Express + JSON on mounted volume
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Where to persist data. On Railway, mount a Volume at /data and set DATA_DIR=/data.
// If /data isn't writable (e.g. local dev or volume not mounted yet), fall back to ./data.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'helpdesk_db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Ensure directories exist
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log('[helpdesk] DATA_DIR =', DATA_DIR);
} catch (e) {
  console.error('[helpdesk] Failed to create data directory:', e.message);
}

// Default DB shape — matches the frontend's DB
const defaultDB = () => ({
  tickets: [],
  nextId: 1,
  settings: {
    adminPassword: 'advanced',
    orgName: 'Advanced Plastics & Machining',
    sla: { P1: 1, P2: 4, P3: 24, P4: 72 },
    cannedResponses: [
      { label: 'Acknowledged', body: "Thanks for reaching out — I've received your ticket and am looking into it now. I'll follow up shortly with next steps." },
      { label: 'More info needed', body: "To help me diagnose this faster, could you confirm: (1) When did this start? (2) Does it happen every time, or only sometimes? (3) Have you tried restarting? Reply when you have a moment — thanks." },
      { label: 'Working on it', body: "Quick update: I'm actively troubleshooting this issue. I'll have more information within the SLA window. Appreciate your patience." },
      { label: 'Need access to your machine', body: "I'd like to remote into your machine to look at this. Are you free in the next 30 minutes? If so, please leave your computer on and let me know." },
      { label: 'Resolved — please verify', body: "This should be fixed on my end. Could you give it a try and reply to confirm everything's working as expected? If not, I'll keep digging." }
    ]
  }
});

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so any missing keys are filled in
      const def = defaultDB();
      return {
        ...def,
        ...parsed,
        settings: { ...def.settings, ...(parsed.settings || {}) }
      };
    }
  } catch (e) {
    console.error('[helpdesk] loadDB error:', e.message);
  }
  return defaultDB();
}

function saveDBFile(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[helpdesk] saveDB error:', e.message);
    return false;
  }
}

function backupDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `helpdesk_${ts}.json`);
    fs.copyFileSync(DB_FILE, dest);
    // Keep only the last 20 backups
    const all = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('helpdesk_') && f.endsWith('.json'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    all.slice(20).forEach(x => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch (_) {}
    });
    return dest;
  } catch (e) {
    console.error('[helpdesk] backup error:', e.message);
    return null;
  }
}

// ─── Middleware ───
app.use(express.json({ limit: '50mb' })); // generous limit for screenshot attachments
app.use(express.static(path.join(__dirname, 'public')));

// CORS — allow Command Center (different Railway domain) to fetch the sync endpoint
// We only need it for /api/sync, but it's harmless on read-only GETs everywhere.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Pushover notification helper ───
// Set PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN as Railway env vars.
// If either is missing, this silently no-ops so the server keeps working.
const PUSHOVER_USER = process.env.PUSHOVER_USER_KEY || '';
const PUSHOVER_TOKEN = process.env.PUSHOVER_APP_TOKEN || '';
const PUSHOVER_ENABLED = !!(PUSHOVER_USER && PUSHOVER_TOKEN);

// Pushover priority levels: -2 silent, -1 quiet, 0 normal, 1 high (bypass quiet hours), 2 emergency (repeats until acknowledged)
// Map our P1-P4 to sane Pushover priorities
const PUSHOVER_PRIORITY_MAP = { P1: 1, P2: 0, P3: 0, P4: -1 };

async function sendPushover({ title, message, priority = 0, url = '', urlTitle = '' }) {
  if (!PUSHOVER_ENABLED) {
    console.log('[helpdesk] Pushover disabled (missing env vars), skipping notification');
    return { ok: false, reason: 'disabled' };
  }
  try {
    const params = new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: title.substring(0, 250),
      message: message.substring(0, 1024),
      priority: String(priority),
      sound: priority >= 1 ? 'siren' : 'pushover',
    });
    if (url) params.append('url', url);
    if (urlTitle) params.append('url_title', urlTitle.substring(0, 100));
    // Emergency priority (2) requires retry & expire params
    if (priority === 2) {
      params.append('retry', '60');     // retry every 60s
      params.append('expire', '1800');  // give up after 30 min
    }
    const r = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await r.json();
    if (data.status === 1) {
      console.log(`[helpdesk] Pushover sent: ${title}`);
      return { ok: true };
    } else {
      console.error('[helpdesk] Pushover error:', data);
      return { ok: false, error: data };
    }
  } catch (e) {
    console.error('[helpdesk] Pushover network error:', e.message);
    return { ok: false, error: e.message };
  }
}

function notifyNewTicket(t, baseUrl) {
  const pri = (PUSHOVER_PRIORITY_MAP[t.priority] != null) ? PUSHOVER_PRIORITY_MAP[t.priority] : 0;
  const title = `[${t.priority}] ${t.title}`;
  const message =
    `From: ${t.requesterName || 'Unknown'}` +
    (t.requesterDept ? ` (${t.requesterDept})` : '') +
    `\nCategory: ${t.category}${t.subCategory ? ' / ' + t.subCategory : ''}` +
    `\n\n${(t.description || '').substring(0, 500)}` +
    (t.description && t.description.length > 500 ? '…' : '');
  const ticketUrl = baseUrl ? `${baseUrl}/#admin` : '';
  return sendPushover({
    title, message, priority: pri,
    url: ticketUrl,
    urlTitle: ticketUrl ? 'Open Helpdesk Console' : ''
  });
}

// ─── Routes ───

// Health check
app.get('/health', (req, res) => {
  const dbExists = fs.existsSync(DB_FILE);
  const writable = (() => {
    try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; } catch (_) { return false; }
  })();
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    dbExists,
    writable,
    time: new Date().toISOString()
  });
});

// Get full DB
app.get('/api/db', (req, res) => {
  const db = loadDB();
  res.json(db);
});

// Save full DB (overwrite). Frontend calls this after every change.
// Race-safe enough for a 1-IT-manager + ~100 user shop. For high concurrency,
// switch to per-collection patches (see /api/patch below).
app.post('/api/save', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid body' });
  }
  // Sanity-check shape
  if (!Array.isArray(incoming.tickets)) {
    return res.status(400).json({ ok: false, error: 'tickets must be an array' });
  }
  const ok = saveDBFile(incoming);
  res.json({ ok, savedAt: new Date().toISOString() });
});

// Patch a single ticket (atomic-ish: load → update → save).
// This is used when an end user submits a ticket, so two simultaneous submits don't trample each other.
app.post('/api/ticket', (req, res) => {
  const incoming = req.body;
  if (!incoming || !incoming.title) {
    return res.status(400).json({ ok: false, error: 'Missing ticket fields' });
  }
  const db = loadDB();
  // Assign ID server-side to avoid collisions when multiple clients submit at once
  const t = {
    id: db.nextId++,
    title: incoming.title || '',
    description: incoming.description || '',
    category: incoming.category || 'Other',
    subCategory: incoming.subCategory || '',
    priority: incoming.priority || 'P3',
    status: 'new',
    requesterName: incoming.requesterName || '',
    requesterEmail: incoming.requesterEmail || '',
    requesterDept: incoming.requesterDept || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: incoming.timeline || [
      { t: new Date().toISOString(), kind: 'system', author: 'System', body: 'Ticket created via portal' }
    ],
    attachment: incoming.attachment || null,
    assignee: incoming.assignee || 'Archis',
    resolution: ''
  };
  db.tickets.unshift(t);
  const ok = saveDBFile(db);
  // Fire push notification in background (don't block response on it)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  notifyNewTicket(t, baseUrl).catch(e => console.error('[helpdesk] notify failed:', e.message));
  res.json({ ok, ticket: t });
});

// Patch an existing ticket (admin updates status, priority, replies, etc.)
app.put('/api/ticket/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ ok: false, error: 'Bad id' });
  const db = loadDB();
  const idx = db.tickets.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Ticket not found' });
  // Replace the ticket entirely with the incoming version (frontend always sends full ticket)
  db.tickets[idx] = req.body;
  const ok = saveDBFile(db);
  res.json({ ok });
});

// Manual backup trigger
app.post('/api/backup', (req, res) => {
  const dest = backupDB();
  res.json({ ok: !!dest, file: dest });
});

// Save settings only (changes admin password, SLA windows, canned responses)
app.post('/api/settings', (req, res) => {
  const db = loadDB();
  db.settings = { ...db.settings, ...(req.body || {}) };
  const ok = saveDBFile(db);
  res.json({ ok, settings: db.settings });
});

// ─── SYNC ENDPOINT — read-only snapshot for Command Center ──────────────
// Returns tickets in the exact shape Command Center's tickets module expects.
// Command Center fetches this on demand (button click) and replaces its DB.tickets.
// No mutation here — Helpdesk stays the source of truth for ticket data.
app.get('/api/sync', (req, res) => {
  const db = loadDB();
  // Map status: helpdesk uses new/progress/waiting/resolved → Command Center uses open/pending/resolved
  const statusMap = { new: 'open', progress: 'pending', waiting: 'pending', resolved: 'resolved' };
  const tickets = db.tickets.map(t => ({
    id: t.id,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: statusMap[t.status] || t.status,
    requester: t.requesterName,
    email: t.requesterEmail,
    department: t.requesterDept,
    asset: '',
    resolution: t.resolution || '',
    created: (t.createdAt || '').slice(0, 10),
    updated: (t.updatedAt || '').slice(0, 10),
    // Optional richer fields Command Center may use later
    _helpdesk: {
      sourceUrl: `${req.protocol}://${req.get('host')}`,
      timelineEvents: (t.timeline || []).length,
      hasAttachment: !!t.attachment,
      assignee: t.assignee || ''
    }
  }));
  res.json({
    ok: true,
    sourceUrl: `${req.protocol}://${req.get('host')}`,
    syncedAt: new Date().toISOString(),
    count: tickets.length,
    tickets
  });
});

// ─── TEST PUSHOVER — visit this URL once to verify notifications work ─────
// Open: https://your-helpdesk.up.railway.app/api/test-pushover
app.get('/api/test-pushover', async (req, res) => {
  if (!PUSHOVER_ENABLED) {
    return res.status(400).json({
      ok: false,
      error: 'Pushover not configured',
      hint: 'Set PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN env vars in Railway, then redeploy.'
    });
  }
  const result = await sendPushover({
    title: 'ADVANCED Helpdesk — Test',
    message: 'If you see this on your phone, push notifications are working. Submit a real ticket from the helpdesk to confirm end-to-end.',
    priority: 0
  });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`[helpdesk] Server listening on port ${PORT}`);
  console.log(`[helpdesk] Health: http://localhost:${PORT}/health`);
  console.log(`[helpdesk] DB at:  ${DB_FILE}`);
  console.log(`[helpdesk] Pushover: ${PUSHOVER_ENABLED ? 'ENABLED ✓' : 'disabled (set PUSHOVER_USER_KEY + PUSHOVER_APP_TOKEN to enable)'}`);
  console.log(`[helpdesk] Sync endpoint: http://localhost:${PORT}/api/sync`);
});
