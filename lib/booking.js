// שכבת שירות להזמנות: כל פעולה שמשנה יומן רצה בטרנזקציה אחת עם נעילה לפי תאריך,
// כך ששתי הזמנות לאותה שעה לא יכולות להצליח שתיהן, והזמנה קבוצתית היא הכול-או-כלום.
'use strict';
const crypto = require('crypto');
const E = require('./engine');
const { planNotifications } = require('./notify');
const { LEGACY_BARBER_ID } = require('./defaults');
const { HALF } = require('./holidays');

class BookingError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const MODES = ['sequential', 'parallel', 'any'];
const STATUSES = ['pending', 'confirmed', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show'];
const clean = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0(5\d{8}|7\d{8}|[23489]\d{7})$/.test(d) ? d : null;
}

function createBookingService({ db, baseUrl = 'https://dalorbook.duckdns.org', now = () => Date.now() }) {
  const col = n => db.collection(n);
  const CFG = () => col('config').doc('booking-v2');

  // ── קריאות ──────────────────────────────────────────────────
  async function loadConfig() {
    const s = await CFG().get();
    return E.mergeConfig(s.exists ? s.data().value : null);
  }
  async function readCfgTx(tx) {
    const s = await tx.get(CFG());
    return E.mergeConfig(s.exists ? s.data().value : null);
  }
  async function readDay(tx, date) {
    const [a, b, d, l] = await Promise.all([
      tx.get(col('appointments').where('date', '==', date)),
      tx.get(col('config').doc('blocked')),
      tx.get(col('config').doc('day-status')),
      tx.get(col('locks').doc(date)),
    ]);
    return {
      appts: a.docs.map(x => x.data()),
      blocked: b.exists ? (b.data().value || []) : [],
      dayStatus: d.exists ? (d.data().value || {}) : {},
      lockRef: col('locks').doc(date),
      lockV: l.exists ? (l.data().v || 0) : 0,
    };
  }
  async function readDayPlain(date) {
    const [a, b, d] = await Promise.all([
      col('appointments').where('date', '==', date).get(),
      col('config').doc('blocked').get(),
      col('config').doc('day-status').get(),
    ]);
    return {
      appts: a.docs.map(x => x.data()),
      blocked: b.exists ? (b.data().value || []) : [],
      dayStatus: d.exists ? (d.data().value || {}) : {},
    };
  }

  const peopleDesc = group => group.persons.map(p => ({ durationMin: p.durationMin, skills: p.skills }));
  const overrideWindows = ctx => { ctx.barbers.forEach(b => { b.windows = [[0, 1440]]; }); };

  function validateDateTime(cfg, date, time, { strictGrid }) {
    if (!E.isDate(date) || !E.isHHMM(time)) throw new BookingError(400, 'bad_datetime', 'תאריך או שעה לא תקינים');
    if (strictGrid && E.toMin(time) % cfg.settings.slotStepMin !== 0) throw new BookingError(400, 'bad_time', 'שעה לא תקינה');
  }

  // ── ציבורי: קטלוג, לוח שנה, זמינות ───────────────────────────
  function publicCatalog(cfg) {
    const pick = x => ({ id: x.id, name: x.name, price: x.price == null ? null : x.price });
    return {
      services: cfg.services.filter(s => s.active).sort((a, b) => a.sortOrder - b.sortOrder)
        .map(s => ({ ...pick(s), type: s.type, hasHaircut: !!s.hasHaircut, allowsAddons: !!s.allowsAddons })),
      addons: cfg.addons.filter(s => s.active).sort((a, b) => a.sortOrder - b.sortOrder).map(pick),
      settings: {
        maxPeople: cfg.settings.maxPeople, maxDaysAhead: cfg.settings.maxDaysAhead,
        cancelBeforeHours: cfg.settings.cancelBeforeHours, policyText: E.policyText(cfg.settings),
        waPhone: cfg.settings.shopPhoneWa, businessHours: cfg.settings.businessHours,
        specialHaircutPrice: cfg.settings.specialHaircutExtraPrice == null ? null : cfg.settings.specialHaircutExtraPrice,
      },
    };
  }

  async function calendarMeta() {
    const cfg = await loadConfig();
    const { blocked, dayStatus } = await readDayPlain('1970-01-01');
    const today = E.ilNow(now()).date;
    const closed = [], half = [], notes = {};
    for (let i = 0; i <= cfg.settings.maxDaysAhead; i++) {
      const date = E.addDays(today, i);
      const ctx = E.dayContext(date, cfg, { blocked, dayStatus });
      if (!ctx.open) { closed.push(date); if (ctx.reason.startsWith('status:')) notes[date] = dayStatus[date]; }
      else if (HALF.has(date)) half.push(date);
    }
    return { today, maxDate: E.addDays(today, cfg.settings.maxDaysAhead), closed, half, notes };
  }

  async function quote(people) {
    const cfg = await loadConfig();
    const g = E.computeGroup(cfg, people);
    if (!g.ok) throw new BookingError(400, 'bad_people', g.error);
    return publicQuote(g);
  }
  const publicQuote = g => ({
    totalDurationMin: g.totalDurationMin, price: g.price, priceComplete: g.priceComplete,
    people: g.persons.map((p, i) => ({ index: i, durationMin: p.durationMin, price: p.price, priceComplete: p.priceComplete, lines: p.lines, haircutType: p.haircutType })),
  });

  async function availability({ date, people, mode = 'any', ignoreLead = false, barberId = null }) {
    const cfg = await loadConfig();
    validateDateTime(cfg, date, '00:00', { strictGrid: false });
    if (!MODES.includes(mode)) throw new BookingError(400, 'bad_mode');
    const g = E.computeGroup(cfg, people);
    if (!g.ok) throw new BookingError(400, 'bad_people', g.error);
    const day = await readDayPlain(date);
    const ctx = E.buildContext({ cfg, date, ...day });
    if (!ctx.day.open) return { open: false, reason: ctx.day.reason, slots: [], dayStatus: day.dayStatus[date] || null };
    if (barberId) ctx.barbers = ctx.barbers.filter(b => b.id === barberId);
    const slots = E.listSlots(ctx, peopleDesc(g), mode, now(), { ignoreLead });
    return { open: true, slots: slots.map(s => ({ time: s.time, mode: s.mode, endTime: s.endTime })), quote: publicQuote(g) };
  }

  // זמינות לכמה ימים בבקשה אחת (לוח שנה): קריאת הגדרות פעם אחת ושאילתת תורים אחת לטווח.
  async function availabilityRange({ from, to, people, mode = 'any' }) {
    const cfg = await loadConfig();
    validateDateTime(cfg, from, '00:00', { strictGrid: false }); validateDateTime(cfg, to, '00:00', { strictGrid: false });
    if (to < from || E.addDays(from, 40) < to) throw new BookingError(400, 'bad_range', 'טווח תאריכים לא תקין');
    if (!MODES.includes(mode)) throw new BookingError(400, 'bad_mode');
    const g = E.computeGroup(cfg, people);
    if (!g.ok) throw new BookingError(400, 'bad_people', g.error);
    const [a, b, d] = await Promise.all([
      col('appointments').where('date', '>=', from).where('date', '<=', to).get(),
      col('config').doc('blocked').get(), col('config').doc('day-status').get(),
    ]);
    const all = a.docs.map(x => x.data());
    const blocked = b.exists ? (b.data().value || []) : [], dayStatus = d.exists ? (d.data().value || {}) : {};
    const desc = peopleDesc(g), days = {};
    for (let date = from; date <= to; date = E.addDays(date, 1)) {
      const ctx = E.buildContext({ cfg, date, appts: all.filter(x => x.date === date), blocked, dayStatus });
      days[date] = ctx.day.open ? { open: true, slots: E.listSlots(ctx, desc, mode, now()).map(s => ({ time: s.time })) } : { open: false, slots: [] };
    }
    return { days };
  }

  // ── יצירת הזמנה ──────────────────────────────────────────────
  async function createBooking(input, { admin = false, forceBarberId = null, ignoreLead = false, ignoreHours = false, source } = {}) {
    const c = input.customer || {};
    const fullName = clean(c.fullName, 80);
    const phoneNorm = normalizePhone(c.phone);
    if (fullName.length < 2) throw new BookingError(400, 'bad_name', 'נא להזין שם מלא');
    if (!phoneNorm) throw new BookingError(400, 'bad_phone', 'מספר טלפון לא תקין');
    const notes = clean(c.notes, 400);
    const mode = input.mode || 'any';
    if (!MODES.includes(mode)) throw new BookingError(400, 'bad_mode');
    const date = clean(input.date, 10), time = clean(input.time, 5);
    const consentWa = c.whatsappConsent === true;
    if (!admin && c.policyAccepted !== true) throw new BookingError(400, 'policy_required', 'יש לאשר את מדיניות השינוי והביטול');

    return db.runTransaction(async tx => {
      const cfg = await readCfgTx(tx);
      validateDateTime(cfg, date, time, { strictGrid: !admin });
      const group = E.computeGroup(cfg, input.people);
      if (!group.ok) throw new BookingError(400, 'bad_people', group.error);

      const day = await readDay(tx, date);
      const custRef = col('customers').doc(phoneNorm);
      const custSnap = await tx.get(custRef);

      const T = E.toMin(time);
      if (!ignoreLead && !E.leadOk(cfg, date, T, now())) throw new BookingError(409, 'lead_time', 'לא ניתן להזמין תור לשעה זו');

      // ignoreHours (מנהל בלבד): מתעלם גם מיום סגור/שעות פעילות, אבל לעולם לא מאפשר חפיפה בין תורים של אותו ספר
      const ctx = E.buildContext({ cfg, date, appts: day.appts, blocked: ignoreHours ? [] : day.blocked, dayStatus: ignoreHours ? {} : day.dayStatus });
      if (!ctx.day.open && !ignoreHours) throw new BookingError(409, 'day_closed', 'המספרה סגורה ביום זה');
      if (ignoreHours) overrideWindows(ctx);
      if (forceBarberId) ctx.barbers = ctx.barbers.filter(b => b.id === forceBarberId);

      const placement = E.place(ctx, peopleDesc(group), mode, T);
      if (!placement) throw new BookingError(409, 'slot_unavailable', 'השעה שנבחרה כבר לא פנויה');

      const ts = new Date(now()).toISOString();
      const bookingId = 'b' + now().toString(36) + crypto.randomBytes(4).toString('hex');
      const manageToken = crypto.randomBytes(24).toString('base64url');
      const status = (admin || cfg.settings.autoConfirm) ? 'confirmed' : 'pending';
      const n = group.persons.length;

      const appts = placement.assignments.map(a => {
        const p = group.persons[a.personIndex];
        return {
          id: `${bookingId}_${a.personIndex + 1}`, bookingId, personIndex: a.personIndex, groupSize: n,
          fullName: n > 1 && a.personIndex > 0 ? `${fullName} (אדם ${a.personIndex + 1})` : fullName,
          phone: phoneNorm, phoneNorm, notes,
          date, time: E.toHHMM(a.startMin), endTime: E.toHHMM(a.endMin), startMin: a.startMin, endMin: a.endMin,
          durationMin: p.durationMin, barberId: a.barberId,
          serviceId: p.service.id, serviceName: p.service.name,
          addonIds: p.addons.map(x => x.id), addonNames: p.addons.map(x => x.name),
          haircutType: p.haircutType, price: p.price, priceComplete: p.priceComplete,
          status, createdAt: ts, source: source || (admin ? 'admin' : 'client'), bookingMode: placement.mode,
        };
      });
      const booking = {
        id: bookingId, fullName, phone: phoneNorm, phoneNorm, notes, people: n, mode: placement.mode,
        date, time: E.toHHMM(Math.min(...appts.map(a => a.startMin))), appointmentIds: appts.map(a => a.id),
        totalDurationMin: group.totalDurationMin, price: group.price, priceComplete: group.priceComplete,
        firstVisit: typeof c.firstVisit === 'boolean' ? c.firstVisit : null,
        knownCustomer: custSnap.exists, status, version: 1, manageToken,
        consent: { whatsappReminders: consentWa, marketing: false, grantedAt: consentWa ? ts : null, textVersion: 'v1', source: admin ? 'admin' : 'online_form' },
        policyAcceptedAt: admin ? null : ts, createdAt: ts, source: source || (admin ? 'admin' : 'client'),
      };
      const plan = planNotifications({ booking, activeAppts: appts, kind: 'confirm', existing: [], cfg, nowMs: now(), baseUrl });

      // כתיבות — אחרי כל הקריאות
      tx.set(day.lockRef, { date, v: day.lockV + 1 });
      tx.set(col('bookings').doc(bookingId), booking);
      appts.forEach(a => tx.set(col('appointments').doc(a.id), a));
      const cust = custSnap.exists ? custSnap.data() : { phone: phoneNorm, firstSeen: ts, bookingsCount: 0 };
      tx.set(custRef, { ...cust, fullName, lastBookingAt: ts, bookingsCount: (cust.bookingsCount || 0) + 1, whatsappReminders: consentWa, whatsappConsentAt: consentWa ? ts : (cust.whatsappConsentAt || null) });
      plan.create.forEach(o => tx.set(col('outbox').doc(o.id), o));

      return { booking, appts, group, placement };
    }).then(({ booking, appts, group, placement }) => ({
      ok: true, bookingId: booking.id, manageToken: booking.manageToken, status: booking.status,
      date, time: booking.time, endTime: E.toHHMM(Math.max(...appts.map(a => a.endMin))),
      mode: placement.mode, people: group.persons.length, quote: publicQuote(group), appointments: appts,
    }));
  }

  // ── שינוי תור קיים (ניהול) ───────────────────────────────────
  // patch: { date?, time?, barberId?, serviceId?, addonIds?, haircutType?, override? }
  async function modifyAppointment(id, patch, actor) {
    return db.runTransaction(async tx => {
      const ref = col('appointments').doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new BookingError(404, 'not_found');
      const appt = snap.data();
      const cfg = await readCfgTx(tx);
      const date = patch.date ? clean(patch.date, 10) : appt.date;
      const time = patch.time ? clean(patch.time, 5) : appt.time;
      validateDateTime(cfg, date, time, { strictGrid: false });
      if (['cancelled', 'no_show', 'completed'].includes(appt.status)) throw new BookingError(409, 'bad_status', 'לא ניתן לשנות תור שהסתיים או בוטל');

      const serviceChange = patch.serviceId !== undefined || patch.addonIds !== undefined || patch.haircutType !== undefined;
      let durationMin = appt.durationMin || (appt.endMin != null ? appt.endMin - appt.startMin : 20);
      let skills = [appt.serviceId, ...(appt.addonIds || [])].filter(Boolean);
      let personFields = {};
      if (serviceChange) {
        const p = E.computePerson(cfg, {
          serviceId: patch.serviceId || appt.serviceId,
          addonIds: patch.addonIds !== undefined ? patch.addonIds : (appt.addonIds || []),
          haircutType: patch.haircutType !== undefined ? patch.haircutType : appt.haircutType,
        });
        if (!p.ok) throw new BookingError(400, 'bad_service', p.error);
        durationMin = p.durationMin; skills = p.skills;
        personFields = { serviceId: p.service.id, serviceName: p.service.name, addonIds: p.addons.map(x => x.id), addonNames: p.addons.map(x => x.name), haircutType: p.haircutType, price: p.price, priceComplete: p.priceComplete, durationMin };
      }

      const day = await readDay(tx, date);
      const oldDay = date !== appt.date ? await tx.get(col('locks').doc(appt.date)) : null;
      const bookingSnap = appt.bookingId ? await tx.get(col('bookings').doc(appt.bookingId)) : null;
      const sibSnap = appt.bookingId ? await tx.get(col('appointments').where('bookingId', '==', appt.bookingId)) : null;
      const outSnap = appt.bookingId ? await tx.get(col('outbox').where('bookingId', '==', appt.bookingId)) : null;

      const T = E.toMin(time);
      const ctx = E.buildContext({ cfg, date, appts: day.appts, blocked: day.blocked, dayStatus: day.dayStatus, ignoreIds: [id] });
      if (patch.override) overrideWindows(ctx);
      else if (!ctx.day.open) throw new BookingError(409, 'day_closed', 'המספרה סגורה ביום זה');

      const cur = E.normAppt(appt, cfg);
      const wantBarber = patch.barberId || cur.barberId;
      let barberId = wantBarber, reassigned = false;
      const barber = ctx.barbers.find(b => b.id === barberId);
      const ok = barber && (patch.override || E.canDo(barber, skills)) && E.fits(barber, T, T + durationMin);
      if (!ok) {
        if (patch.barberId) throw new BookingError(409, 'slot_unavailable', 'הספר שנבחר אינו פנוי בשעה זו');
        const r = E.place(ctx, [{ durationMin, skills }], 'any', T);
        if (!r) throw new BookingError(409, 'slot_unavailable', 'אין ספר פנוי בשעה זו');
        barberId = r.assignments[0].barberId; reassigned = true;
      }

      const ts = new Date(now()).toISOString();
      const updated = { ...appt, ...personFields, date, time, startMin: T, endMin: T + durationMin, endTime: E.toHHMM(T + durationMin), durationMin, barberId, updatedAt: ts };
      const timeChanged = date !== appt.date || time !== appt.time;

      tx.set(ref, updated);
      tx.set(day.lockRef, { date, v: day.lockV + 1 });
      if (oldDay) tx.set(col('locks').doc(appt.date), { date: appt.date, v: (oldDay.exists ? oldDay.data().v || 0 : 0) + 1 });
      if (bookingSnap && bookingSnap.exists) {
        const booking = { ...bookingSnap.data(), version: (bookingSnap.data().version || 1) + 1 };
        const siblings = sibSnap.docs.map(d => d.data()).map(a => a.id === id ? updated : a).filter(a => E.ACTIVE_STATUSES.has(a.status || 'confirmed'));
        tx.update(col('bookings').doc(booking.id), { version: booking.version });
        if (timeChanged) {
          const plan = planNotifications({ booking, activeAppts: siblings, kind: 'change', existing: outSnap.docs.map(d => d.data()), cfg, nowMs: now(), baseUrl });
          plan.supersede.forEach(sid => tx.update(col('outbox').doc(sid), { status: 'superseded' }));
          plan.create.forEach(o => tx.set(col('outbox').doc(o.id), o));
        }
      }
      return { ok: true, appointment: updated, reassigned };
    });
  }

  // ── סטטוס / ביטול ────────────────────────────────────────────
  async function setStatus(id, status, actor = { role: 'admin' }) {
    if (!STATUSES.includes(status)) throw new BookingError(400, 'bad_status');
    return db.runTransaction(async tx => {
      const ref = col('appointments').doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new BookingError(404, 'not_found');
      const appt = snap.data();
      const cfg = await readCfgTx(tx);
      if (actor.role === 'barber' && E.normAppt(appt, cfg).barberId !== actor.barberId) throw new BookingError(403, 'forbidden');

      // שחזור מביטול: חייב לוודא שהשעה עדיין פנויה
      const reviving = !E.ACTIVE_STATUSES.has(appt.status || 'confirmed') && E.ACTIVE_STATUSES.has(status);
      let day = null;
      if (reviving) {
        day = await readDay(tx, appt.date);
        const ctx = E.buildContext({ cfg, date: appt.date, appts: day.appts, blocked: [], dayStatus: {}, ignoreIds: [id] });
        const cur = E.normAppt(appt, cfg);
        const b = ctx.barbers.find(x => x.id === cur.barberId);
        if (b && b.busy.some(([s, e]) => cur.startMin < e && cur.endMin > s)) throw new BookingError(409, 'slot_unavailable', 'השעה כבר נתפסה — לא ניתן לשחזר');
      }
      const bookingSnap = appt.bookingId ? await tx.get(col('bookings').doc(appt.bookingId)) : null;
      const sibSnap = appt.bookingId ? await tx.get(col('appointments').where('bookingId', '==', appt.bookingId)) : null;
      const outSnap = appt.bookingId ? await tx.get(col('outbox').where('bookingId', '==', appt.bookingId)) : null;

      const ts = new Date(now()).toISOString();
      const updated = { ...appt, status, updatedAt: ts, statusLog: [...(appt.statusLog || []).slice(-9), { at: ts, status, by: actor.role + (actor.barberId ? ':' + actor.barberId : '') }] };
      tx.set(ref, updated);
      if (day) tx.set(day.lockRef, { date: appt.date, v: day.lockV + 1 });

      if (status === 'cancelled' && bookingSnap && bookingSnap.exists) {
        const booking = { ...bookingSnap.data(), version: (bookingSnap.data().version || 1) + 1 };
        const rest = sibSnap.docs.map(d => d.data()).map(a => a.id === id ? updated : a).filter(a => E.ACTIVE_STATUSES.has(a.status || 'confirmed'));
        tx.update(col('bookings').doc(booking.id), { version: booking.version, ...(rest.length ? {} : { status: 'cancelled' }) });
        const plan = planNotifications({ booking, activeAppts: rest, kind: rest.length ? 'change' : 'cancel', existing: outSnap.docs.map(d => d.data()), cfg, nowMs: now(), baseUrl });
        plan.supersede.forEach(sid => tx.update(col('outbox').doc(sid), { status: 'superseded' }));
        plan.create.forEach(o => tx.set(col('outbox').doc(o.id), o));
      }
      return updated;
    });
  }

  // ביטול עצמי של לקוח לפי קישור (token). לא חושף היסטוריה — רק את ההזמנה הספציפית.
  async function getBookingByToken(bookingId, token) {
    const s = await col('bookings').doc(String(bookingId)).get();
    if (!s.exists || !token || !require('./auth').safeEq(s.data().manageToken, token)) throw new BookingError(404, 'not_found');
    const b = s.data();
    const apps = (await col('appointments').where('bookingId', '==', b.id).get()).docs.map(d => d.data());
    const cfg = await loadConfig();
    const active = apps.filter(a => E.ACTIVE_STATUSES.has(a.status));
    const first = [...active].sort((a, c) => (a.date + a.time).localeCompare(c.date + c.time))[0];
    const deadline = first ? E.ilToEpoch(first.date, E.toMin(first.time)) - cfg.settings.cancelBeforeHours * 3600000 : null;
    return {
      bookingId: b.id, fullName: b.fullName, people: b.people, status: active.length ? b.status : 'cancelled',
      price: b.price, priceComplete: b.priceComplete,
      appointments: apps.sort((a, c) => a.personIndex - c.personIndex).map(a => ({ date: a.date, time: a.time, endTime: a.endTime, serviceName: a.serviceName, addonNames: a.addonNames, status: a.status })),
      canCancel: !!first && now() <= deadline, cancelBeforeHours: cfg.settings.cancelBeforeHours, policyText: E.policyText(cfg.settings),
    };
  }

  async function cancelBooking(bookingId, { token, by = 'customer' }) {
    return db.runTransaction(async tx => {
      const bRef = col('bookings').doc(String(bookingId));
      const bs = await tx.get(bRef);
      if (!bs.exists) throw new BookingError(404, 'not_found');
      const booking = bs.data();
      if (by === 'customer' && !(token && require('./auth').safeEq(booking.manageToken, token))) throw new BookingError(404, 'not_found');
      const cfg = await readCfgTx(tx);
      const apps = (await tx.get(col('appointments').where('bookingId', '==', booking.id))).docs.map(d => d.data());
      const outs = (await tx.get(col('outbox').where('bookingId', '==', booking.id))).docs.map(d => d.data());
      const active = apps.filter(a => E.ACTIVE_STATUSES.has(a.status));
      if (!active.length) throw new BookingError(409, 'already_cancelled', 'ההזמנה כבר בוטלה');
      if (by === 'customer') {
        const first = [...active].sort((a, c) => (a.date + a.time).localeCompare(c.date + c.time))[0];
        const deadline = E.ilToEpoch(first.date, E.toMin(first.time)) - cfg.settings.cancelBeforeHours * 3600000;
        if (now() > deadline) throw new BookingError(403, 'too_late', `ביטול עצמי אפשרי עד ${cfg.settings.cancelBeforeHours} שעות לפני התור — אנא פנו למספרה`);
        if (active.some(a => a.status !== 'confirmed' && a.status !== 'pending')) throw new BookingError(409, 'bad_status');
      }
      const ts = new Date(now()).toISOString();
      const dates = [...new Set(active.map(a => a.date))];
      const locks = await Promise.all(dates.map(d => tx.get(col('locks').doc(d))));
      active.forEach(a => tx.set(col('appointments').doc(a.id), { ...a, status: 'cancelled', cancelledBy: by, updatedAt: ts }));
      dates.forEach((d, i) => tx.set(col('locks').doc(d), { date: d, v: (locks[i].exists ? locks[i].data().v || 0 : 0) + 1 }));
      const next = { ...booking, version: (booking.version || 1) + 1 };
      tx.update(bRef, { version: next.version, status: 'cancelled', cancelledAt: ts, cancelledBy: by });
      const plan = planNotifications({ booking: next, activeAppts: [], kind: 'cancel', existing: outs, cfg, nowMs: now(), baseUrl });
      plan.supersede.forEach(sid => tx.update(col('outbox').doc(sid), { status: 'superseded' }));
      plan.create.forEach(o => tx.set(col('outbox').doc(o.id), o));
      return { ok: true, cancelled: active.length };
    });
  }

  // ── הגדרות (ניהול) ───────────────────────────────────────────
  async function updateConfigSection(section, value) {
    const { validateSection } = require('./validate');
    return db.runTransaction(async tx => {
      const s = await tx.get(CFG());
      const stored = s.exists ? s.data().value || {} : {};
      const cfg = E.mergeConfig(stored);
      const next = validateSection(section, value, cfg);
      tx.set(CFG(), { value: { ...stored, settings: cfg.settings, services: cfg.services, addons: cfg.addons, barbers: cfg.barbers, [section]: next } });
      return next;
    });
  }

  return { loadConfig, publicCatalog, calendarMeta, quote, availability, availabilityRange, createBooking, modifyAppointment, setStatus, getBookingByToken, cancelBooking, updateConfigSection, readDayPlain };
}

module.exports = { createBookingService, BookingError, normalizePhone, STATUSES, MODES, clean };
