require('dotenv').config();
const express    = require('express');
const fs         = require('fs/promises');
const path       = require('path');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const webpush    = require('web-push');

const app      = express();
const PORT     = process.env.PORT || 3020;
const DATA_DIR = path.join(__dirname, 'data');
const APPT_FILE   = path.join(DATA_DIR, 'appointments.json');
const BLOCK_FILE  = path.join(DATA_DIR, 'blocked.json');
const SUBS_FILE   = path.join(DATA_DIR, 'subscriptions.json');
const STATUS_FILE = path.join(DATA_DIR, 'day-status.json');
const ADMIN_KEY  = process.env.ADMIN_KEY || '2810';

const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASS     = process.env.GMAIL_PASS;
const REMINDER_EMAIL = process.env.REMINDER_EMAIL || GMAIL_USER;

// ── Web Push setup ───────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@dalor.co.il';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Security headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────
function makeRateLimit(windowMs, max, msg) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: msg });
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

// Admin: 30 בקשות / 15 דקות
const adminRateLimit = makeRateLimit(15 * 60 * 1000, 30, 'יותר מדי בקשות, נסה שוב בעוד 15 דקות');
// הזמנת תור: 5 הזמנות / 10 דקות (מניעת ספאם)
const bookRateLimit  = makeRateLimit(10 * 60 * 1000, 5,  'יותר מדי הזמנות, נסה שוב בעוד מעט');
// בדיקת זמינות: 60 בקשות / דקה
const availRateLimit = makeRateLimit(60 * 1000, 60, 'יותר מדי בקשות');

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJSON(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function clean(v, max) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, max); }

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// All /api/admin/* routes get rate limiting + auth
app.use('/api/admin', adminRateLimit, requireAdmin);

// ── Push notifications ───────────────────────────────────────────

async function sendPush(payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const subs = await readJSON(SUBS_FILE, []);
  const dead = [];

  await Promise.allSettled(
    subs.map(async (sub, i) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) dead.push(i);
      }
    })
  );

  if (dead.length) {
    const alive = subs.filter((_, i) => !dead.includes(i));
    await writeJSON(SUBS_FILE, alive);
  }
}

// ── Email ────────────────────────────────────────────────────────

function buildMailer() {
  if (!GMAIL_USER || !GMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
}

async function sendReminderEmail(appt, type) {
  const mailer = buildMailer();
  if (!mailer) return;

  const is24h   = type === '24h';
  const whenStr = is24h ? `מחר ב-${appt.time}` : `בעוד ~30 דקות (${appt.time})`;
  const waText  = is24h
    ? `שלום ${appt.fullName}! 😊 תזכורת לתורך מחר ב-${appt.time} במספרת DALOR. מחכים לך! 💈`
    : `שלום ${appt.fullName}! ⏰ תזכורת – התור שלך במספרת DALOR בעוד כ-30 דקות, ב-${appt.time}. ניפגש בקרוב! 💈`;
  const waLink  = `https://wa.me/${appt.phone.replace(/\D/g,'')}?text=${encodeURIComponent(waText)}`;
  const subject = is24h
    ? `📅 תור מחר — ${appt.fullName}, ${appt.time}`
    : `⏰ תור בעוד 30 דקות — ${appt.fullName}`;

  await mailer.sendMail({
    from: `"DALOR מספרה 💈" <${GMAIL_USER}>`,
    to: REMINDER_EMAIL,
    subject,
    html: `
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;border-radius:14px;overflow:hidden;border:1px solid #2a2a2a">
  <div style="background:linear-gradient(135deg,#c9a84c,#f0d783);padding:22px 24px;text-align:center">
    <div style="font-size:1.5rem;font-weight:900;color:#15110a;letter-spacing:.1em">DALOR</div>
    <div style="font-size:.85rem;color:#15110a;opacity:.75;margin-top:2px">${is24h ? '⏰ תזכורת 24 שעות' : '⚡ תזכורת 30 דקות'}</div>
  </div>
  <div style="background:#111115;padding:24px">
    <p style="font-size:1.1rem;font-weight:bold;margin:0 0 8px;color:#f5f0e8">${appt.fullName}</p>
    <p style="color:#9a9590;margin:0 0 4px;font-size:.9rem">📞 ${appt.phone}</p>
    <p style="color:#9a9590;margin:0 0 ${appt.notes ? '4px' : '20px'};font-size:.9rem">⏰ ${whenStr}</p>
    ${appt.notes ? `<p style="color:#9a9590;margin:0 0 20px;font-size:.88rem;font-style:italic">📝 ${appt.notes}</p>` : ''}
    <a href="${waLink}" style="display:block;background:#25d366;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:700;font-size:1rem">📲 שלח תזכורת בוואטסאפ</a>
  </div>
</div>`,
  });
  console.log(`✉️  Email reminder (${type}) → ${appt.fullName}`);
}

async function sendDailySummaryEmail(appts) {
  const mailer = buildMailer();
  if (!mailer || !appts.length) return;

  const today = new Date().toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const rows = appts
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(a => `
      <tr>
        <td style="padding:10px 14px;font-weight:700;color:#f0d783;font-size:1rem">${a.time}</td>
        <td style="padding:10px 14px;color:#f5f0e8;font-size:.95rem">${a.fullName}</td>
        <td style="padding:10px 14px;color:#9a9590;font-size:.88rem">${a.phone}</td>
        <td style="padding:10px 14px;color:#9a9590;font-size:.82rem;font-style:italic">${a.notes || ''}</td>
      </tr>`)
    .join('');

  await mailer.sendMail({
    from: `"DALOR מספרה 💈" <${GMAIL_USER}>`,
    to: REMINDER_EMAIL,
    subject: `📋 לוח יום — ${appts.length} תורים להיום`,
    html: `
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border-radius:14px;overflow:hidden;border:1px solid #2a2a2a">
  <div style="background:linear-gradient(135deg,#c9a84c,#f0d783);padding:22px 24px;text-align:center">
    <div style="font-size:1.5rem;font-weight:900;color:#15110a;letter-spacing:.1em">DALOR</div>
    <div style="font-size:.9rem;color:#15110a;opacity:.8;margin-top:4px">📋 סיכום יום — ${today}</div>
  </div>
  <div style="background:#111115;padding:20px">
    <p style="color:#9a9590;margin:0 0 16px;font-size:.9rem">יש לך <strong style="color:#f0d783">${appts.length} תורים</strong> היום:</p>
    <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#1e1e24">
          <th style="padding:8px 14px;color:#9a9590;font-size:.78rem;font-weight:700;text-align:right">שעה</th>
          <th style="padding:8px 14px;color:#9a9590;font-size:.78rem;font-weight:700;text-align:right">שם</th>
          <th style="padding:8px 14px;color:#9a9590;font-size:.78rem;font-weight:700;text-align:right">טלפון</th>
          <th style="padding:8px 14px;color:#9a9590;font-size:.78rem;font-weight:700;text-align:right">הערות</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <a href="http://localhost:3020/admin.html" style="display:block;margin-top:20px;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);color:#f0d783;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;font-size:.95rem">פתח ממשק ניהול</a>
  </div>
</div>`,
  });
  console.log(`📋 Daily summary sent (${appts.length} appointments)`);
}

// ── Reminder logic ───────────────────────────────────────────────

const WINDOW_24H = { min: 82800000, max: 90000000 };
const WINDOW_30M = { min: 1200000,  max: 2400000  };

async function processDueReminders() {
  const all = await readJSON(APPT_FILE, []);
  const now = Date.now();
  const due = [];
  let changed = false;

  for (const appt of all) {
    if (appt.status !== 'confirmed') continue;
    const diff = new Date(`${appt.date}T${appt.time}:00`).getTime() - now;

    if (!appt.reminderSent24h && diff >= WINDOW_24H.min && diff <= WINDOW_24H.max) {
      appt.reminderSent24h = true;
      appt.reminderSent24hAt = new Date().toISOString();
      due.push({ ...appt, reminderType: '24h' });
      changed = true;
    }
    if (!appt.reminderSent30m && diff >= WINDOW_30M.min && diff <= WINDOW_30M.max) {
      appt.reminderSent30m = true;
      appt.reminderSent30mAt = new Date().toISOString();
      due.push({ ...appt, reminderType: '30m' });
      changed = true;
    }
  }

  if (changed) await writeJSON(APPT_FILE, all);
  return due;
}

// ── Cron: every minute — mark client reminders (toast shown in admin) ──
// No email/push to Yair for 24h/30m — only admin toast triggers via /api/admin/due-reminders
// (processDueReminders is called by the admin poll endpoint — no action needed here)

// ── Cron: 08:00 daily — day summary ─────────────────────────────

cron.schedule('0 8 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const all   = await readJSON(APPT_FILE, []);
    const todays = all.filter(a => a.date === today && a.status === 'confirmed');

    if (todays.length) {
      const pushPayload = {
        title: `📋 ${todays.length} תורים היום`,
        body: todays
          .sort((a,b) => a.time.localeCompare(b.time))
          .map(a => `${a.time} ${a.fullName}`)
          .join(' · '),
        tag: `daily-${today}`,
        url: '/admin.html',
      };
      await Promise.allSettled([
        sendPush(pushPayload),
        sendDailySummaryEmail(todays),
      ]);
    } else {
      await sendPush({ title: 'DALOR — אין תורים היום 😌', body: '', tag: `daily-${today}`, url: '/admin.html' });
    }
  } catch (err) {
    console.error('Cron daily error:', err.message);
  }
});

// ── Public ──────────────────────────────────────────────────────

app.get('/api/vapid-public', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});

app.get('/api/availability', availRateLimit, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  const all = await readJSON(APPT_FILE, []);
  const booked = all.filter(a => a.date === date && a.status !== 'cancelled').map(a => a.time);
  res.json({ booked });
});

app.get('/api/blocked', async (req, res) => {
  res.json(await readJSON(BLOCK_FILE, []));
});

app.get('/api/day-status', async (req, res) => {
  res.json(await readJSON(STATUS_FILE, {}));
});

app.post('/api/appointments', bookRateLimit, async (req, res) => {
  const fullName = clean(req.body.fullName, 80);
  const phone    = clean(req.body.phone, 24);
  const notes    = clean(req.body.notes, 400);
  const date     = clean(req.body.date, 20);
  const time     = clean(req.body.time, 10);

  if (!fullName || !phone || !date || !time) return res.status(400).json({ error: 'Missing fields' });

  const all = await readJSON(APPT_FILE, []);
  if (all.some(a => a.date === date && a.time === time && a.status !== 'cancelled'))
    return res.status(409).json({ error: 'Time already booked' });

  const appt = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fullName, phone, notes, date, time,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    source: 'client',
  };
  all.push(appt);
  await writeJSON(APPT_FILE, all);
  res.status(201).json({ ok: true, id: appt.id, date: appt.date, time: appt.time });
});

// ── Admin ────────────────────────────────────────────────────────

app.get('/api/admin/auth', requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/admin/push-subscribe', requireAdmin, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Bad subscription' });

  const subs = await readJSON(SUBS_FILE, []);
  const exists = subs.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    await writeJSON(SUBS_FILE, subs);
  }
  res.json({ ok: true });
});

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
  const all = await readJSON(APPT_FILE, []);
  const { date, from, to } = req.query;
  let out = all;
  if (date) out = out.filter(a => a.date === date);
  else {
    if (from) out = out.filter(a => a.date >= from);
    if (to)   out = out.filter(a => a.date <= to);
  }
  out.sort((a, b) => (`${a.date} ${a.time}`).localeCompare(`${b.date} ${b.time}`));
  res.json(out);
});

app.post('/api/admin/appointments', requireAdmin, async (req, res) => {
  const fullName = clean(req.body.fullName, 80);
  const phone    = clean(req.body.phone, 24);
  const notes    = clean(req.body.notes, 400);
  const date     = clean(req.body.date, 20);
  const time     = clean(req.body.time, 10);

  if (!fullName || !phone || !date || !time) return res.status(400).json({ error: 'Missing fields' });

  const all = await readJSON(APPT_FILE, []);
  if (all.some(a => a.date === date && a.time === time && a.status !== 'cancelled'))
    return res.status(409).json({ error: 'Time already booked' });

  const appt = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fullName, phone, notes, date, time,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    source: 'admin',
  };
  all.push(appt);
  await writeJSON(APPT_FILE, all);
  res.status(201).json(appt);
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const all = await readJSON(APPT_FILE, []);
  const idx = all.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body;
  if (!['confirmed', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  all[idx].status = status;
  all[idx].updatedAt = new Date().toISOString();
  await writeJSON(APPT_FILE, all);
  res.json(all[idx]);
});

app.delete('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  let all = await readJSON(APPT_FILE, []);
  const idx = all.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  all.splice(idx, 1);
  await writeJSON(APPT_FILE, all);
  res.json({ ok: true });
});

app.get('/api/admin/due-reminders', requireAdmin, async (req, res) => {
  try { res.json(await processDueReminders()); }
  catch { res.json([]); }
});

app.put('/api/admin/blocked', requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  await writeJSON(BLOCK_FILE, req.body);
  res.json({ ok: true });
});

// ── Day Status (admin) ───────────────────────────────────────────
app.put('/api/admin/day-status', async (req, res) => {
  const date = clean(req.body.date || '', 10);
  const type = clean(req.body.type || '', 20);
  const note = clean(req.body.note || '', 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  const valid = ['vacation','phone_only','walkin_only','closed','busy','custom'];
  if (!valid.includes(type)) return res.status(400).json({ error: 'Bad type' });
  const all = await readJSON(STATUS_FILE, {});
  all[date] = { type, ...(note && { note }) };
  await writeJSON(STATUS_FILE, all);
  res.json({ ok: true });
});

app.delete('/api/admin/day-status/:date', async (req, res) => {
  const date = req.params.date;
  const all = await readJSON(STATUS_FILE, {});
  delete all[date];
  await writeJSON(STATUS_FILE, all);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✦ DALOR Barber Studio — http://localhost:${PORT}`);
  console.log(`✦ Admin:  http://localhost:${PORT}/admin.html`);
  console.log(`✦ Key:    ${ADMIN_KEY}`);
  console.log(`✦ Email:  ${GMAIL_USER ? `✅ ${GMAIL_USER}` : '⚠️  לא מוגדר (.env)'}`);
  console.log(`✦ Push:   ${VAPID_PUBLIC ? '✅ מוגדר' : '⚠️  לא מוגדר (.env)'}\n`);
});
