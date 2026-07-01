require('dotenv').config();
const express    = require('express');
const path       = require('path');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const webpush    = require('web-push');
const admin      = require('firebase-admin');

// ── Firebase / Firestore ─────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(require('./firebase-key.json')),
});
const db = admin.firestore();

const app      = express();
const PORT     = process.env.PORT || 3020;
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

const adminRateLimit = makeRateLimit(15 * 60 * 1000, 300, 'יותר מדי בקשות, נסה שוב בעוד 15 דקות');
const bookRateLimit  = makeRateLimit(10 * 60 * 1000, 5,  'יותר מדי הזמנות, נסה שוב בעוד מעט');
const availRateLimit = makeRateLimit(60 * 1000, 60, 'יותר מדי בקשות');

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Firestore helpers ─────────────────────────────────────────────

async function getAppointmentsByDate(date) {
  const snap = await db.collection('appointments').where('date', '==', date).get();
  return snap.docs.map(d => d.data());
}

async function getAllAppointments() {
  const snap = await db.collection('appointments').get();
  return snap.docs.map(d => d.data());
}

async function addAppointment(appt) {
  await db.collection('appointments').doc(appt.id).set(appt);
}

async function updateAppointment(id, updates) {
  await db.collection('appointments').doc(id).update(updates);
}

async function deleteAppointment(id) {
  await db.collection('appointments').doc(id).delete();
}

async function getConfig(key, fallback) {
  try {
    const doc = await db.collection('config').doc(key).get();
    if (!doc.exists) return fallback;
    const val = doc.data().value;
    return val !== undefined ? val : fallback;
  } catch { return fallback; }
}

async function setConfig(key, value) {
  await db.collection('config').doc(key).set({ value });
}

// ─────────────────────────────────────────────────────────────────

function clean(v, max) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, max); }

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api/admin', adminRateLimit, requireAdmin);

// ── Push notifications ───────────────────────────────────────────

async function sendPush(payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[Push] VAPID keys missing — skipping');
    return;
  }
  const subs = await getConfig('subscriptions', []);
  console.log(`[Push] sending "${payload.title}" to ${subs.length} subscriber(s)`);
  if (!subs.length) return;

  const dead = [];
  await Promise.allSettled(
    subs.map(async (sub, i) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        console.log(`[Push] sent ok to sub #${i}`);
      } catch (err) {
        console.error(`[Push] failed sub #${i}:`, err.statusCode, err.message);
        if (err.statusCode === 410 || err.statusCode === 404) dead.push(i);
      }
    })
  );

  if (dead.length) {
    const alive = subs.filter((_, i) => !dead.includes(i));
    await setConfig('subscriptions', alive);
    console.log(`[Push] removed ${dead.length} dead subscription(s)`);
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
    <a href="https://dalorbook.duckdns.org/admin.html" style="display:block;margin-top:20px;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);color:#f0d783;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;font-size:.95rem">פתח ממשק ניהול</a>
  </div>
</div>`,
  });
  console.log(`📋 Daily summary sent (${appts.length} appointments)`);
}

// ── Reminder logic ───────────────────────────────────────────────

const WINDOW_24H = { min: 82800000, max: 90000000 };
const WINDOW_30M = { min: 1200000,  max: 2400000  };

async function processDueReminders() {
  const snap = await db.collection('appointments').where('status', '==', 'confirmed').get();
  const now = Date.now();
  const due = [];

  await Promise.all(snap.docs.map(async (docSnap) => {
    const appt = docSnap.data();
    const diff = new Date(`${appt.date}T${appt.time}:00`).getTime() - now;
    const updates = {};

    if (!appt.reminderSent24h && diff >= WINDOW_24H.min && diff <= WINDOW_24H.max) {
      updates.reminderSent24h   = true;
      updates.reminderSent24hAt = new Date().toISOString();
      due.push({ ...appt, reminderType: '24h' });
    }
    if (!appt.reminderSent30m && diff >= WINDOW_30M.min && diff <= WINDOW_30M.max) {
      updates.reminderSent30m   = true;
      updates.reminderSent30mAt = new Date().toISOString();
      due.push({ ...appt, reminderType: '30m' });
    }

    if (Object.keys(updates).length) {
      await docSnap.ref.update(updates);
    }
  }));

  return due;
}

// ── Cron: 08:00 daily — day summary ─────────────────────────────

cron.schedule('0 8 * * *', async () => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const todays = (await getAppointmentsByDate(today)).filter(a => a.status === 'confirmed');

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
      await Promise.allSettled([sendPush(pushPayload), sendDailySummaryEmail(todays)]);
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
  const appts  = await getAppointmentsByDate(date);
  const booked = appts.filter(a => a.status !== 'cancelled').map(a => a.time);
  const dayStatus = await getConfig('day-status', {});
  const closeAt = dayStatus[date]?.closeAt || null;
  res.json({ booked, ...(closeAt && { closeAt }) });
});

app.get('/api/blocked', async (req, res) => {
  res.json(await getConfig('blocked', []));
});

app.get('/api/day-status', async (req, res) => {
  res.json(await getConfig('day-status', {}));
});

app.post('/api/appointments', bookRateLimit, async (req, res) => {
  const fullName = clean(req.body.fullName, 80);
  const phone    = clean(req.body.phone, 24);
  const notes    = clean(req.body.notes, 400);
  const date     = clean(req.body.date, 20);
  const time     = clean(req.body.time, 10);

  if (!fullName || !phone || !date || !time) return res.status(400).json({ error: 'Missing fields' });

  const existing = await getAppointmentsByDate(date);
  if (existing.some(a => a.time === time && a.status !== 'cancelled'))
    return res.status(409).json({ error: 'Time already booked' });

  const appt = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fullName, phone, notes, date, time,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    source: 'client',
  };
  await addAppointment(appt);
  res.status(201).json({ ok: true, id: appt.id, date: appt.date, time: appt.time });

  sendPush({
    title: `💈 תור חדש — ${appt.fullName}`,
    body: `${appt.date} · ${appt.time}`,
    tag: `new-${appt.id}`,
    url: '/admin.html',
  });
});

// ── Admin ────────────────────────────────────────────────────────

app.get('/api/admin/auth', requireAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/admin/push-subscribe', requireAdmin, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Bad subscription' });

  const subs = await getConfig('subscriptions', []);
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    await setConfig('subscriptions', subs);
  }
  res.json({ ok: true });
});

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
  const { date, from, to } = req.query;
  let out;

  if (date) {
    out = await getAppointmentsByDate(date);
  } else {
    out = await getAllAppointments();
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

  const existing = await getAppointmentsByDate(date);
  if (existing.some(a => a.time === time && a.status !== 'cancelled'))
    return res.status(409).json({ error: 'Time already booked' });

  const appt = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fullName, phone, notes, date, time,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    source: 'admin',
  };
  await addAppointment(appt);
  res.status(201).json(appt);
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['confirmed', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Bad status' });

  const docRef = db.collection('appointments').doc(id);
  const doc    = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });

  const updatedAt = new Date().toISOString();
  await docRef.update({ status, updatedAt });
  res.json({ ...doc.data(), status, updatedAt });
});

app.delete('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const docRef = db.collection('appointments').doc(id);
  const doc    = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  await docRef.delete();
  res.json({ ok: true });
});

app.get('/api/admin/due-reminders', requireAdmin, async (req, res) => {
  try { res.json(await processDueReminders()); }
  catch { res.json([]); }
});

app.put('/api/admin/blocked', requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  await setConfig('blocked', req.body);
  res.json({ ok: true });
});

// ── Day Status (admin) ───────────────────────────────────────────

app.put('/api/admin/day-status', async (req, res) => {
  const date    = clean(req.body.date    || '', 10);
  const type    = clean(req.body.type    || '', 20);
  const note    = clean(req.body.note    || '', 200);
  const closeAt = clean(req.body.closeAt || '', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  const valid = ['vacation','phone_only','walkin_only','closed','busy','custom','close_at'];
  if (!valid.includes(type)) return res.status(400).json({ error: 'Bad type' });
  if (closeAt && !/^\d{2}:\d{2}$/.test(closeAt)) return res.status(400).json({ error: 'Bad closeAt' });

  const all = await getConfig('day-status', {});
  all[date] = { type, ...(note && { note }), ...(closeAt && { closeAt }) };
  await setConfig('day-status', all);
  res.json({ ok: true });
});

app.delete('/api/admin/day-status/:date', async (req, res) => {
  const date = req.params.date;
  const all  = await getConfig('day-status', {});
  delete all[date];
  await setConfig('day-status', all);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✦ DALOR Barber Studio — http://localhost:${PORT}`);
  console.log(`✦ Admin:     http://localhost:${PORT}/admin.html`);
  console.log(`✦ Key:       ${ADMIN_KEY}`);
  console.log(`✦ Email:     ${GMAIL_USER ? `✅ ${GMAIL_USER}` : '⚠️  לא מוגדר (.env)'}`);
  console.log(`✦ Push:      ${VAPID_PUBLIC ? '✅ מוגדר' : '⚠️  לא מוגדר (.env)'}`);
  console.log(`✦ Firebase:  ${process.env.FIREBASE_PROJECT_ID ? `✅ ${process.env.FIREBASE_PROJECT_ID}` : '⚠️  לא מוגדר (.env)'}\n`);
});
