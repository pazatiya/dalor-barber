// מסלולי API של מערכת ההזמנות החכמה.
//   /api/v2/*     — ציבורי (לקוח): קטלוג, לוח שנה, זמינות, הזמנה, ביטול עצמי לפי קישור
//   /api/staff/*  — צוות: מנהל (ADMIN_KEY) או ספר (קוד אישי). לספר גישה רק לתורים שלו.
'use strict';
const E = require('./engine');
const { BookingError, normalizePhone } = require('./booking');
const { ValidationError, redactBarbers } = require('./validate');

module.exports = function mount(app, { db, svc, authenticate, sender, rl, notifyNewBooking }) {
  // עטיפת שגיאות אחידה
  const h = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof BookingError || e instanceof ValidationError) return res.status(e.status).json({ error: e.code, message: e.message });
      console.error(`[${req.method} ${req.path}]`, e);
      res.status(500).json({ error: 'server_error', message: 'שגיאת שרת, נסו שוב' });
    }
  };

  // ── ציבורי ───────────────────────────────────────────────────
  app.get('/api/v2/catalog', rl.avail, h(async (req, res) => {
    res.json(svc.publicCatalog(await svc.loadConfig()));
  }));
  app.get('/api/v2/calendar', rl.avail, h(async (req, res) => res.json(await svc.calendarMeta())));
  app.post('/api/v2/quote', rl.avail, h(async (req, res) => res.json(await svc.quote(req.body.people))));
  app.post('/api/v2/availability', rl.avail, h(async (req, res) => {
    res.json(await svc.availability({ date: String(req.body.date || ''), people: req.body.people, mode: req.body.mode || 'any' }));
  }));
  app.post('/api/v2/availability/range', rl.avail, h(async (req, res) => {
    res.json(await svc.availabilityRange({ from: String(req.body.from || ''), to: String(req.body.to || ''), people: req.body.people, mode: req.body.mode || 'any' }));
  }));
  app.post('/api/v2/bookings', rl.book, h(async (req, res) => {
    const b = req.body || {};
    const r = await svc.createBooking({ customer: b.customer, people: b.people, mode: b.mode, date: b.date, time: b.time });
    // ללקוח לא חושפים ספר/שיבוץ. ה-token מוחזר פעם אחת, לקישור ביטול.
    res.status(201).json({
      ok: true, bookingId: r.bookingId, manageToken: r.manageToken, status: r.status, date: r.date, time: r.time, endTime: r.endTime,
      people: r.people, mode: r.mode, quote: r.quote,
    });
    notifyNewBooking(r);
  }));
  app.get('/api/v2/bookings/:id', rl.avail, h(async (req, res) => {
    res.json(await svc.getBookingByToken(req.params.id, String(req.query.token || '')));
  }));
  app.post('/api/v2/bookings/:id/cancel', rl.book, h(async (req, res) => {
    res.json(await svc.cancelBooking(req.params.id, { token: String((req.body || {}).token || ''), by: 'customer' }));
  }));

  // ── הרשאות צוות ──────────────────────────────────────────────
  const requireStaff = async (req, res, next) => {
    try {
      const p = await authenticate(req.headers['x-admin-key']);
      if (!p) return res.status(401).json({ error: 'unauthorized', message: 'מפתח שגוי' });
      req.principal = p; next();
    } catch (e) { console.error('[auth]', e); res.status(500).json({ error: 'server_error' }); }
  };
  const adminOnly = (req, res, next) => req.principal.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden', message: 'פעולה למנהל בלבד' });
  app.use('/api/staff', rl.admin, requireStaff);

  const myApptFilter = async principal => {
    if (principal.role === 'admin') return () => true;
    const cfg = await svc.loadConfig();
    return a => E.normAppt(a, cfg).barberId === principal.barberId;
  };

  app.get('/api/staff/me', (req, res) => res.json(req.principal));

  app.get('/api/staff/config', h(async (req, res) => {
    const cfg = await svc.loadConfig();
    if (req.principal.role === 'admin') {
      return res.json({ settings: cfg.settings, services: cfg.services, addons: cfg.addons, barbers: redactBarbers(cfg.barbers), policyText: E.policyText(cfg.settings) });
    }
    res.json({ services: cfg.services, addons: cfg.addons, barbers: cfg.barbers.map(b => ({ id: b.id, name: b.name, active: b.active, sortOrder: b.sortOrder })) });
  }));

  app.put('/api/staff/config/:section', adminOnly, h(async (req, res) => {
    const next = await svc.updateConfigSection(req.params.section, req.body.value);
    authenticate.invalidate();
    res.json({ ok: true, value: req.params.section === 'barbers' ? redactBarbers(next) : next });
  }));

  app.get('/api/staff/appointments', h(async (req, res) => {
    const from = String(req.query.from || ''), to = String(req.query.to || from);
    if (!E.isDate(from) || !E.isDate(to) || to < from || E.addDays(from, 62) < to) return res.status(400).json({ error: 'bad_range', message: 'טווח תאריכים לא תקין (עד 62 יום)' });
    const snap = await db.collection('appointments').where('date', '>=', from).where('date', '<=', to).get();
    const mine = await myApptFilter(req.principal);
    const cfg = await svc.loadConfig();
    let out = snap.docs.map(d => d.data()).filter(mine);
    if (req.query.barberId && req.principal.role === 'admin') out = out.filter(a => E.normAppt(a, cfg).barberId === req.query.barberId);
    out = out.map(a => { const n = E.normAppt(a, cfg); return { ...a, barberId: n.barberId, startMin: n.startMin, endMin: n.endMin, endTime: E.toHHMM(n.endMin) }; });
    out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    res.json(out);
  }));

  app.patch('/api/staff/appointments/:id', h(async (req, res) => {
    res.json(await svc.setStatus(req.params.id, String(req.body.status || ''), req.principal));
  }));
  app.post('/api/staff/appointments/:id/modify', adminOnly, h(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ['date', 'time', 'barberId', 'serviceId', 'addonIds', 'haircutType']) if (b[k] !== undefined) patch[k] = b[k];
    patch.override = b.override === true;
    res.json(await svc.modifyAppointment(req.params.id, patch, req.principal));
  }));
  app.post('/api/staff/bookings/:id/cancel', adminOnly, h(async (req, res) => {
    res.json(await svc.cancelBooking(req.params.id, { by: 'admin' }));
  }));

  // זמינות והזמנה ידנית (מנהל): ללא מגבלת "מראש", עם אפשרות לכפות ספר או לעקוף שעות פעילות
  app.post('/api/staff/availability', adminOnly, h(async (req, res) => {
    res.json(await svc.availability({ date: String(req.body.date || ''), people: req.body.people, mode: req.body.mode || 'any', ignoreLead: true, barberId: req.body.barberId }));
  }));
  app.post('/api/staff/bookings', adminOnly, h(async (req, res) => {
    const b = req.body || {};
    const r = await svc.createBooking({ customer: b.customer, people: b.people, mode: b.mode, date: b.date, time: b.time },
      { admin: true, ignoreLead: true, ignoreHours: b.override === true, forceBarberId: b.barberId || null });
    res.status(201).json({ ok: true, bookingId: r.bookingId, appointments: r.appointments, quote: r.quote });
  }));

  // לקוחות והיסטוריה (מנהל בלבד)
  const customersFromAppts = async () => {
    const all = (await db.collection('appointments').get()).docs.map(d => d.data());
    const map = new Map();
    for (const a of all) {
      const ph = normalizePhone(a.phone) || a.phone;
      const base = a.fullName.replace(/ \(אדם \d+\)$/, '');
      const c = map.get(ph) || { phone: ph, fullName: base, visits: 0, bookings: 0, lastDate: '', noShows: 0 };
      c.bookings++;
      if (a.status === 'completed') c.visits++;
      if (a.status === 'no_show') c.noShows++;
      if (a.date > c.lastDate) { c.lastDate = a.date; c.fullName = base; }
      map.set(ph, c);
    }
    return { map, all };
  };
  app.get('/api/staff/customers', adminOnly, h(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const digits = q.replace(/\D/g, '');
    const { map } = await customersFromAppts();
    res.json([...map.values()].filter(c => c.fullName.toLowerCase().includes(q) || (digits.length >= 3 && c.phone.includes(digits)))
      .sort((a, b) => b.lastDate.localeCompare(a.lastDate)).slice(0, 30));
  }));
  app.get('/api/staff/customers/:phone/history', adminOnly, h(async (req, res) => {
    const ph = normalizePhone(req.params.phone);
    if (!ph) return res.status(400).json({ error: 'bad_phone' });
    const { all } = await customersFromAppts();
    const cfg = await svc.loadConfig();
    const hist = all.filter(a => (normalizePhone(a.phone) || a.phone) === ph).map(a => ({ ...a, barberId: E.normAppt(a, cfg).barberId }))
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const cust = await db.collection('customers').doc(ph).get();
    res.json({ phone: ph, customer: cust.exists ? { ...cust.data() } : null, appointments: hist });
  }));

  // הודעות ללקוחות (מנהל): רשימה + סימון "נשלח ידנית" כשאין ספק וואטסאפ מוגדר
  app.get('/api/staff/outbox', adminOnly, h(async (req, res) => {
    const snap = await db.collection('outbox').where('status', '==', 'pending').get();
    const nowMs = Date.now();
    const items = snap.docs.map(d => d.data()).filter(o => Date.parse(o.scheduledFor) <= nowMs)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)).slice(0, 100);
    res.json({ providerConfigured: sender.configured, items });
  }));
  app.post('/api/staff/outbox/:id/mark-sent', adminOnly, h(async (req, res) => {
    const ref = db.collection('outbox').doc(req.params.id);
    const ok = await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'pending') return false;
      tx.update(ref, { status: 'sent', sentAt: new Date().toISOString(), channel: 'manual_whatsapp' });
      return true;
    });
    res.status(ok ? 200 : 409).json({ ok });
  }));
};
