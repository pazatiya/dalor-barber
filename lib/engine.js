// מנוע זמינות ותמחור — פונקציות טהורות, בלי תלות ב-Firebase (ניתן לבדיקה מלאה).
// כל הזמנים בדקות מחצות לפי שעון ישראל. תאריכים כ-YYYY-MM-DD.
'use strict';

const { CLOSED, HALF } = require('./holidays');
const { DEFAULT_SETTINGS, DEFAULT_SERVICES, DEFAULT_ADDONS, DEFAULT_BARBERS, LEGACY_SLOT_MIN, LEGACY_BARBER_ID } = require('./defaults');

const TZ = 'Asia/Jerusalem';
const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'arrived', 'in_progress', 'completed']);

// ── זמן ─────────────────────────────────────────────────────────
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const toHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));
const isHHMM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));

function tzOffsetMin(epochMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}
// תאריך+דקות (שעון ישראל) -> epoch ms
function ilToEpoch(date, min) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, min, 0);
  let off = tzOffsetMin(guess);
  let t = guess - off * 60000;
  off = tzOffsetMin(t); // תיקון סביב מעבר שעון קיץ
  return guess - off * 60000;
}
function ilNow(epochMs = Date.now()) {
  const date = new Date(epochMs).toLocaleDateString('sv-SE', { timeZone: TZ });
  const off = tzOffsetMin(epochMs);
  const local = new Date(epochMs + off * 60000);
  return { date, min: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
const dowOf = date => new Date(date + 'T12:00:00Z').getUTCDay();
const addDays = (date, n) => new Date(new Date(date + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const isSummerIL = date => tzOffsetMin(ilToEpoch(date, 12 * 60)) === 180;

// ── קונפיגורציה ──────────────────────────────────────────────────
function mergeConfig(stored) {
  const s = stored || {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}), businessHours: { ...DEFAULT_SETTINGS.businessHours, ...((s.settings || {}).businessHours || {}) } },
    services: Array.isArray(s.services) ? s.services : DEFAULT_SERVICES,
    addons: Array.isArray(s.addons) ? s.addons : DEFAULT_ADDONS,
    barbers: Array.isArray(s.barbers) ? s.barbers : DEFAULT_BARBERS,
  };
}

function policyText(settings) {
  if (settings.policyText) return settings.policyText;
  const h = settings.cancelBeforeHours;
  return `ביטול עצמי אפשר עד ${h} שעות לפני התור, דרך הקישור שיופיע באישור ההזמנה. ` +
    `לשינוי תור, או לביטול בטווח קצר יותר, יש ליצור קשר עם המספרה בוואטסאפ.`;
}

// ── תמחור ומשך (תמיד בשרת) ────────────────────────────────────────
// person: { serviceId, addonIds?, haircutType? }
function computePerson(cfg, person) {
  const service = cfg.services.find(s => s.id === person.serviceId && s.active);
  if (!service) return { ok: false, error: 'שירות לא זמין' };

  const addonIds = [...new Set(Array.isArray(person.addonIds) ? person.addonIds : [])];
  if (addonIds.length && !service.allowsAddons) return { ok: false, error: 'השירות שנבחר אינו מאפשר תוספות' };
  const addons = [];
  for (const id of addonIds) {
    const a = cfg.addons.find(x => x.id === id && x.active);
    if (!a) return { ok: false, error: 'תוספת לא זמינה' };
    addons.push(a);
  }

  let haircutType = null;
  if (service.hasHaircut) {
    haircutType = person.haircutType === 'special' ? 'special' : 'regular';
  }

  let duration = service.durationMin + (service.requiresExtraTime ? (service.extraTimeMin || 0) : 0);
  let price = 0;
  let priceComplete = true;
  const lines = [];
  const addLine = (kind, id, name, p) => {
    lines.push({ kind, id, name, price: p == null ? null : p });
    if (p == null) priceComplete = false; else price += p;
  };

  addLine('service', service.id, service.name, service.price);
  if (haircutType === 'special') {
    duration += cfg.settings.specialHaircutExtraMin || 0;
    addLine('special', 'special', 'תספורת מיוחדת / עיצוב מורכב', cfg.settings.specialHaircutExtraPrice);
  }
  for (const a of addons) { duration += a.durationMin; addLine('addon', a.id, a.name, a.price); }

  duration = Math.ceil(duration / 5) * 5;
  const skills = [service.id, ...addons.map(a => a.id)];
  return {
    ok: true, service, addons, haircutType, durationMin: duration,
    price, priceComplete, lines, skills,
  };
}

function computeGroup(cfg, people) {
  if (!Array.isArray(people) || people.length < 1) return { ok: false, error: 'לא נבחרו אנשים' };
  if (people.length > cfg.settings.maxPeople) return { ok: false, error: `ניתן להזמין עד ${cfg.settings.maxPeople} אנשים` };
  const persons = [];
  for (const p of people) {
    const r = computePerson(cfg, p || {});
    if (!r.ok) return r;
    persons.push(r);
  }
  return {
    ok: true, persons,
    totalDurationMin: persons.reduce((a, p) => a + p.durationMin, 0),
    price: persons.reduce((a, p) => a + p.price, 0),
    priceComplete: persons.every(p => p.priceComplete),
  };
}

// ── אינטרוולים ────────────────────────────────────────────────────
function subtract(windows, cut) {
  const out = [];
  for (const [s, e] of windows) {
    if (cut[1] <= s || cut[0] >= e) { out.push([s, e]); continue; }
    if (cut[0] > s) out.push([s, cut[0]]);
    if (cut[1] < e) out.push([cut[1], e]);
  }
  return out;
}
const clip = (windows, lo, hi) => windows.map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)]).filter(([s, e]) => e > s);

// ── הקשר יום ──────────────────────────────────────────────────────
// מחזיר { open, reason?, openMin, closeMin }
function dayContext(date, cfg, { blocked = [], dayStatus = {} } = {}) {
  const dow = dowOf(date);
  const bh = cfg.settings.businessHours[dow];
  if (dow === 6 || !bh) return { open: false, reason: 'shabbat' };
  if (CLOSED.has(date)) return { open: false, reason: 'holiday' };
  if (blocked.includes(date)) return { open: false, reason: 'blocked' };
  const st = dayStatus[date];
  if (st && st.type !== 'close_at') return { open: false, reason: 'status:' + st.type };

  let close = toMin(bh.close || (isSummerIL(date) ? bh.closeSummer : bh.closeWinter) || '20:00');
  if (HALF.has(date)) close = Math.min(close, toMin(cfg.settings.eveHolidayClose));
  if (st && st.type === 'close_at' && st.closeAt) close = Math.min(close, toMin(st.closeAt));
  const open = toMin(bh.open);
  if (close <= open) return { open: false, reason: 'closed_early' };
  return { open: true, openMin: open, closeMin: close };
}

function barberWindows(barber, date, day, cfg) {
  if (!barber.active || !day.open) return [];
  const dow = dowOf(date);
  if ((barber.vacations || []).some(v => v.from <= date && date <= (v.to || v.from))) return [];

  let wins;
  if (barber.weeklyHours == null) wins = [[day.openMin, day.closeMin]];
  else wins = (barber.weeklyHours[dow] || []).map(([s, e]) => [toMin(s), toMin(e)]);
  wins = clip(wins, day.openMin, day.closeMin);

  const dayBreaks = [...(cfg.settings.breaks || []), ...(barber.breaks || [])]
    .filter(b => !b.days || b.days.includes(dow));
  for (const b of dayBreaks) wins = subtract(wins, [toMin(b.start), toMin(b.end)]);
  for (const b of (barber.blocks || []).filter(b => b.date === date)) {
    wins = subtract(wins, [toMin(b.start), toMin(b.end)]);
  }
  return wins;
}

// תור קיים -> קטע תפוס (עם נרמול לתורים ישנים)
function normAppt(a, cfg) {
  const startMin = a.startMin != null ? a.startMin : toMin(a.time);
  const endMin = a.endMin != null ? a.endMin : startMin + (a.durationMin || LEGACY_SLOT_MIN);
  const known = cfg.barbers.some(b => b.id === a.barberId);
  return { ...a, startMin, endMin, barberId: known ? a.barberId : LEGACY_BARBER_ID };
}

function buildContext({ cfg, date, appts, blocked, dayStatus, ignoreIds = [] }) {
  const day = dayContext(date, cfg, { blocked, dayStatus });
  const buffer = cfg.settings.bufferMin;
  const active = appts
    .filter(a => ACTIVE_STATUSES.has(a.status || 'confirmed') && !ignoreIds.includes(a.id))
    .map(a => normAppt(a, cfg));
  const barbers = cfg.barbers.filter(b => b.active).sort((a, b) => a.sortOrder - b.sortOrder).map(b => {
    const busy = active.filter(a => a.barberId === b.id).map(a => [a.startMin - buffer, a.endMin + buffer]);
    return {
      id: b.id, sortOrder: b.sortOrder, skills: b.skills,
      windows: barberWindows(b, date, day, cfg),
      busy,
      load: active.filter(a => a.barberId === b.id).reduce((s, a) => s + (a.endMin - a.startMin), 0),
    };
  });
  return { cfg, date, day, buffer, barbers, step: cfg.settings.slotStepMin };
}

const canDo = (barber, skills) => barber.skills == null || skills.every(s => barber.skills.includes(s));
function fits(barber, s, e, extra = []) {
  if (!barber.windows.some(([ws, we]) => ws <= s && e <= we)) return false;
  return ![...barber.busy, ...extra].some(([bs, be]) => s < be && e > bs);
}

// ── שיבוץ קבוצה בשעה נתונה ───────────────────────────────────────
// people: [{ durationMin, skills }]. מחזיר [{personIndex, barberId, startMin, endMin}] או null.
function placeParallel(ctx, people, T) {
  const order = people.map((p, i) => ({ p, i, n: ctx.barbers.filter(b => canDo(b, p.skills)).length }))
    .sort((a, b) => a.n - b.n);
  const used = new Set();
  const out = [];
  const rec = k => {
    if (k === order.length) return true;
    const { p, i } = order[k];
    const cands = ctx.barbers.filter(b => !used.has(b.id) && canDo(b, p.skills) && fits(b, T, T + p.durationMin))
      .sort((a, b) => a.load - b.load || a.sortOrder - b.sortOrder);
    for (const b of cands) {
      used.add(b.id); out.push({ personIndex: i, barberId: b.id, startMin: T, endMin: T + p.durationMin });
      if (rec(k + 1)) return true;
      used.delete(b.id); out.pop();
    }
    return false;
  };
  if (!rec(0)) return null;
  return out.sort((a, b) => a.personIndex - b.personIndex);
}

function placeSequential(ctx, people, T) {
  const extra = {}; // barberId -> קטעים שנוספו זמנית
  const out = [];
  const rec = (i, start, prevBarber) => {
    if (i === people.length) return true;
    const p = people[i];
    const end = start + p.durationMin;
    const cands = ctx.barbers.filter(b => canDo(b, p.skills) && fits(b, start, end, extra[b.id] || []))
      .sort((a, b) => (b.id === prevBarber) - (a.id === prevBarber) || a.load - b.load || a.sortOrder - b.sortOrder);
    for (const b of cands) {
      (extra[b.id] = extra[b.id] || []).push([start - ctx.buffer, end + ctx.buffer]);
      out.push({ personIndex: i, barberId: b.id, startMin: start, endMin: end });
      if (rec(i + 1, end + ctx.buffer, b.id)) return true;
      extra[b.id].pop(); out.pop();
    }
    return false;
  };
  return rec(0, T, null) ? out : null;
}

// mode: 'sequential' | 'parallel' | 'any'. מחזיר { mode, assignments } או null.
function place(ctx, people, mode, T) {
  if (people.length === 1) {
    const r = placeSequential(ctx, people, T);
    return r && { mode: 'single', assignments: r };
  }
  if (mode === 'parallel') { const r = placeParallel(ctx, people, T); return r && { mode: 'parallel', assignments: r }; }
  if (mode === 'sequential') { const r = placeSequential(ctx, people, T); return r && { mode: 'sequential', assignments: r }; }
  let r = placeParallel(ctx, people, T);
  if (r) return { mode: 'parallel', assignments: r };
  r = placeSequential(ctx, people, T);
  return r && { mode: 'sequential', assignments: r };
}

// האם מותר להזמין תאריך/שעה לפי מגבלות הזמנה מראש
function leadOk(cfg, date, startMin, nowMs) {
  const now = ilNow(nowMs);
  if (date < now.date) return false;
  if (date > addDays(now.date, cfg.settings.maxDaysAhead)) return false;
  return ilToEpoch(date, startMin) >= nowMs + cfg.settings.minLeadMin * 60000;
}

function listSlots(ctx, people, mode, nowMs, { ignoreLead = false } = {}) {
  if (!ctx.day.open) return [];
  const slots = [];
  const first = Math.ceil(ctx.day.openMin / ctx.step) * ctx.step;
  for (let T = first; T < ctx.day.closeMin; T += ctx.step) {
    if (!ignoreLead && !leadOk(ctx.cfg, ctx.date, T, nowMs)) continue;
    const r = place(ctx, people, mode, T);
    if (r) {
      const end = Math.max(...r.assignments.map(a => a.endMin));
      slots.push({ time: toHHMM(T), mode: r.mode, endTime: toHHMM(end) });
    }
  }
  return slots;
}

module.exports = {
  TZ, ACTIVE_STATUSES, toMin, toHHMM, isDate, isHHMM, ilToEpoch, ilNow, dowOf, addDays, isSummerIL, tzOffsetMin,
  mergeConfig, policyText, computePerson, computeGroup,
  dayContext, barberWindows, normAppt, buildContext, place, placeParallel, placeSequential, fits, canDo, leadOk, listSlots,
};
