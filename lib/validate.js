// אימות והנרמול של הגדרות שמנהל שומר (שירותים, תוספות, ספרים, הגדרות כלליות).
'use strict';
const { isHHMM, isDate, toMin } = require('./engine');
const { hashKey } = require('./auth');

class ValidationError extends Error { constructor(msg) { super(msg); this.status = 400; this.code = 'invalid_config'; } }
const fail = m => { throw new ValidationError(m); };

const str = (v, max, name) => { const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' '); if (!s) fail(`${name}: חובה`); return s.slice(0, max); };
const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) fail(`${name}: חייב להיות בין ${lo} ל-${hi}`); return n; };
const optPrice = (v, name) => (v === null || v === '' || v === undefined ? null : num(v, 0, 5000, name));
const id = (v, name) => { const s = String(v || '').trim(); if (!/^[a-z0-9_]{2,30}$/.test(s)) fail(`${name}: מזהה באנגלית קטנה/ספרות/_ (2-30 תווים)`); return s; };
const hhmm = (v, name) => { if (!isHHMM(v)) fail(`${name}: שעה לא תקינה`); return v; };
const bool = v => v === true;

function ranges(list, name) {
  if (!Array.isArray(list)) fail(`${name}: חייב להיות רשימה`);
  const out = list.map(r => {
    if (!Array.isArray(r) || r.length !== 2) fail(`${name}: טווח לא תקין`);
    hhmm(r[0], name); hhmm(r[1], name);
    if (toMin(r[1]) <= toMin(r[0])) fail(`${name}: שעת הסיום חייבת להיות אחרי ההתחלה`);
    return [r[0], r[1]];
  }).sort((a, b) => toMin(a[0]) - toMin(b[0]));
  for (let i = 1; i < out.length; i++) if (toMin(out[i][0]) < toMin(out[i - 1][1])) fail(`${name}: טווחים חופפים`);
  return out;
}
function breaks(list, name) {
  if (!Array.isArray(list)) fail(`${name}: חייב להיות רשימה`);
  return list.slice(0, 20).map(b => {
    hhmm(b.start, name); hhmm(b.end, name);
    if (toMin(b.end) <= toMin(b.start)) fail(`${name}: שעת הסיום חייבת להיות אחרי ההתחלה`);
    const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number))].filter(d => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5];
    return { days, start: b.start, end: b.end, label: String(b.label || '').slice(0, 40) };
  });
}

function catalogItem(x, kind) {
  const base = {
    id: id(x.id, 'מזהה'), name: str(x.name, 60, 'שם'), price: optPrice(x.price, 'מחיר'),
    durationMin: num(x.durationMin, 5, 240, 'משך'), durationConfirmed: x.durationConfirmed !== false,
    active: bool(x.active), sortOrder: num(x.sortOrder ?? 99, 0, 999, 'סדר'),
  };
  if (kind === 'addon') return base;
  const type = ['haircut', 'beard', 'combo', 'other'].includes(x.type) ? x.type : 'other';
  return {
    ...base, type, hasHaircut: bool(x.hasHaircut), allowsAddons: bool(x.allowsAddons),
    requiresExtraTime: bool(x.requiresExtraTime), extraTimeMin: bool(x.requiresExtraTime) ? num(x.extraTimeMin, 0, 240, 'זמן נוסף') : 0,
  };
}
function catalog(list, kind) {
  if (!Array.isArray(list) || !list.length || list.length > 40) fail('רשימה חייבת להכיל 1-40 פריטים');
  const items = list.map(x => catalogItem(x || {}, kind));
  if (new Set(items.map(i => i.id)).size !== items.length) fail('מזהים כפולים');
  return items;
}

function settings(x, cur) {
  const s = { ...cur.settings };
  s.slotStepMin = num(x.slotStepMin, 5, 60, 'קפיצת שעות');
  s.maxDaysAhead = num(x.maxDaysAhead, 1, 365, 'ימים קדימה');
  s.minLeadMin = num(x.minLeadMin, 0, 24 * 60, 'הזמנה מראש');
  s.bufferMin = num(x.bufferMin, 0, 60, 'מרווח');
  s.cancelBeforeHours = num(x.cancelBeforeHours, 0, 72, 'ביטול עצמי');
  s.maxPeople = num(x.maxPeople, 1, 10, 'מקסימום אנשים');
  s.autoConfirm = bool(x.autoConfirm);
  s.specialHaircutExtraMin = num(x.specialHaircutExtraMin, 0, 120, 'זמן לתספורת מיוחדת');
  s.specialHaircutExtraPrice = optPrice(x.specialHaircutExtraPrice, 'מחיר תספורת מיוחדת');
  s.eveHolidayClose = hhmm(x.eveHolidayClose, 'סגירה בערב חג');
  s.policyText = String(x.policyText || '').trim().slice(0, 600);
  s.breaks = breaks(x.breaks || [], 'הפסקה כללית');
  const bh = {};
  for (let d = 0; d <= 6; d++) {
    const h = (x.businessHours || {})[d];
    if (!h || d === 6) { bh[d] = null; continue; }
    hhmm(h.open, 'פתיחה');
    const o = { open: h.open };
    if (d === 5) { o.closeSummer = hhmm(h.closeSummer, 'סגירה שישי קיץ'); o.closeWinter = hhmm(h.closeWinter, 'סגירה שישי חורף'); }
    else o.close = hhmm(h.close, 'סגירה');
    for (const k of ['close', 'closeSummer', 'closeWinter']) if (o[k] && toMin(o[k]) <= toMin(o.open)) fail('שעת סגירה חייבת להיות אחרי הפתיחה');
    bh[d] = o;
  }
  s.businessHours = bh;
  return s;
}

function barbers(list, cur, allIds) {
  if (!Array.isArray(list) || !list.length || list.length > 12) fail('רשימת ספרים לא תקינה');
  const out = list.map(x => {
    const prev = cur.barbers.find(b => b.id === x.id) || {};
    const b = {
      id: id(x.id, 'מזהה ספר'), name: str(x.name, 40, 'שם ספר'), role: x.role === 'admin' ? 'admin' : 'barber', active: bool(x.active), sortOrder: num(x.sortOrder ?? 99, 0, 999, 'סדר'),
      weeklyHours: null, breaks: breaks(x.breaks || [], 'הפסקת ספר'),
      vacations: (Array.isArray(x.vacations) ? x.vacations : []).slice(0, 50).map(v => {
        if (!isDate(v.from) || (v.to && !isDate(v.to))) fail('חופשה: תאריך לא תקין');
        if (v.to && v.to < v.from) fail('חופשה: תאריך סיום לפני התחלה');
        return { from: v.from, to: v.to || v.from, note: String(v.note || '').slice(0, 80) };
      }),
      blocks: (Array.isArray(x.blocks) ? x.blocks : []).slice(0, 200).map(v => {
        if (!isDate(v.date)) fail('חסימה: תאריך לא תקין');
        hhmm(v.start, 'חסימה'); hhmm(v.end, 'חסימה');
        if (toMin(v.end) <= toMin(v.start)) fail('חסימה: שעת הסיום חייבת להיות אחרי ההתחלה');
        return { date: v.date, start: v.start, end: v.end, note: String(v.note || '').slice(0, 80) };
      }),
      skills: null, keyHash: prev.keyHash || null,
    };
    if (x.weeklyHours !== null && x.weeklyHours !== undefined) {
      b.weeklyHours = {};
      for (let d = 0; d <= 5; d++) b.weeklyHours[d] = ranges((x.weeklyHours || {})[d] || [], `שעות עבודה (${d})`);
    }
    if (Array.isArray(x.skills)) {
      b.skills = x.skills.map(String);
      const bad = b.skills.find(sk => !allIds.has(sk));
      if (bad) fail(`הסמכה לשירות לא קיים: ${bad}`);
    }
    if (x.clearKey === true) b.keyHash = null;
    if (x.newKey) {
      if (String(x.newKey).length < 6) fail('קוד כניסה לספר: לפחות 6 תווים');
      b.keyHash = hashKey(x.newKey);
    }
    return b;
  });
  if (new Set(out.map(b => b.id)).size !== out.length) fail('מזהי ספרים כפולים');
  if (!out.some(b => b.role === 'admin' && b.active)) fail('חייב להישאר לפחות מנהל פעיל אחד');
  return out;
}

function validateSection(section, value, cfg) {
  switch (section) {
    case 'services': return catalog(value, 'service');
    case 'addons': return catalog(value, 'addon');
    case 'settings': return settings(value || {}, cfg);
    case 'barbers': {
      const ids = new Set([...cfg.services.map(s => s.id), ...cfg.addons.map(a => a.id)]);
      return barbers(value, cfg, ids);
    }
    default: throw new ValidationError('סעיף לא מוכר');
  }
}

// מה שחוזר לממשק הניהול — בלי hash של קודים
const redactBarbers = list => list.map(({ keyHash, ...b }) => ({ ...b, hasKey: !!keyHash }));

module.exports = { validateSection, ValidationError, redactBarbers };
