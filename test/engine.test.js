'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine');
const { DEFAULT_BARBERS } = require('../lib/defaults');

// יום ראשון 2026-11-01 (פתוח, שעון חורף). "עכשיו" = יום לפני, כדי שאין מגבלת lead.
const DATE = '2026-11-01';
const NOW = E.ilToEpoch('2026-10-30', 9 * 60);
const allDay = [['08:00', '20:00']];

function cfgWith(barberTweaks = {}, settings = {}) {
  const base = E.mergeConfig({});
  const hours = { 0: allDay, 1: allDay, 2: allDay, 3: allDay, 4: allDay, 5: [['08:00', '14:00']] };
  const barbers = DEFAULT_BARBERS.map(b => ({ ...b, ...(b.id !== 'yair' ? { weeklyHours: hours } : {}), ...(barberTweaks[b.id] || {}) }));
  return { ...base, barbers, settings: { ...base.settings, ...settings } };
}
const person = (cfg, serviceId, extra = {}) => {
  const r = E.computePerson(cfg, { serviceId, ...extra });
  assert.ok(r.ok, r.error);
  return { durationMin: r.durationMin, skills: r.skills };
};
const ctxFor = (cfg, appts = [], extra = {}) => E.buildContext({ cfg, date: DATE, appts, blocked: [], dayStatus: {}, ...extra });
const times = slots => slots.map(s => s.time);

test('אזור זמן: המרה הלוך-חזור ושעון קיץ/חורף', () => {
  assert.equal(E.isSummerIL('2026-07-15'), true);
  assert.equal(E.isSummerIL('2026-12-15'), false);
  assert.equal(E.ilToEpoch('2026-07-15', 600), Date.UTC(2026, 6, 15, 7, 0));   // UTC+3
  assert.equal(E.ilToEpoch('2026-12-15', 600), Date.UTC(2026, 11, 15, 8, 0));  // UTC+2
  assert.deepEqual(E.ilNow(Date.UTC(2026, 11, 15, 22, 30)), { date: '2026-12-16', min: 30 });
});

test('תמחור: מחירים ידועים, מחיר לא מאושר לא נחשב', () => {
  const cfg = cfgWith();
  const hc = E.computePerson(cfg, { serviceId: 'haircut' });
  assert.equal(hc.price, 50); assert.equal(hc.priceComplete, true); assert.equal(hc.durationMin, 20);
  const combo = E.computePerson(cfg, { serviceId: 'haircut_beard' });
  assert.equal(combo.price, 70);
  const beard = E.computePerson(cfg, { serviceId: 'beard' });
  assert.equal(beard.price, 0); assert.equal(beard.priceComplete, false);
  const withAddon = E.computePerson(cfg, { serviceId: 'haircut', addonIds: ['wax', 'brows'] });
  assert.equal(withAddon.price, 50); assert.equal(withAddon.priceComplete, false); // מחיר תוספות לא אושר
  assert.equal(withAddon.durationMin, 40);
  const kids = E.computePerson(cfg, { serviceId: 'kids_haircut' });
  assert.equal(kids.price, 50);
});

test('תספורת מיוחדת מוסיפה זמן; רק לשירות שכולל תספורת', () => {
  const cfg = cfgWith();
  const sp = E.computePerson(cfg, { serviceId: 'haircut', haircutType: 'special' });
  assert.equal(sp.durationMin, 40); assert.equal(sp.haircutType, 'special'); assert.equal(sp.priceComplete, false);
  const beard = E.computePerson(cfg, { serviceId: 'beard', haircutType: 'special' });
  assert.equal(beard.haircutType, null); assert.equal(beard.durationMin, 15);
});

test('שירות/תוספת לא קיימים או לא פעילים נדחים', () => {
  const cfg = cfgWith();
  assert.equal(E.computePerson(cfg, { serviceId: 'nope' }).ok, false);
  assert.equal(E.computePerson(cfg, { serviceId: 'haircut', addonIds: ['nope'] }).ok, false);
  cfg.services = cfg.services.map(s => s.id === 'haircut' ? { ...s, active: false } : s);
  assert.equal(E.computePerson(cfg, { serviceId: 'haircut' }).ok, false);
  const noAdd = cfgWith(); noAdd.services = noAdd.services.map(s => s.id === 'beard' ? { ...s, allowsAddons: false } : s);
  assert.equal(E.computePerson(noAdd, { serviceId: 'beard', addonIds: ['wax'] }).ok, false);
});

test('מגבלת מספר אנשים', () => {
  const cfg = cfgWith();
  assert.equal(E.computeGroup(cfg, Array(5).fill({ serviceId: 'haircut' })).ok, false);
  assert.equal(E.computeGroup(cfg, Array(4).fill({ serviceId: 'haircut' })).ok, true);
  assert.equal(E.computeGroup(cfg, []).ok, false);
});

test('הקשר יום: שבת, חג, חסום, סטטוס, ערב חג, שישי קיץ/חורף', () => {
  const cfg = cfgWith();
  assert.equal(E.dayContext('2026-10-31', cfg).reason, 'shabbat');
  assert.equal(E.dayContext('2026-09-29', cfg).reason, 'holiday');
  assert.equal(E.dayContext(DATE, cfg, { blocked: [DATE] }).reason, 'blocked');
  assert.equal(E.dayContext(DATE, cfg, { dayStatus: { [DATE]: { type: 'vacation' } } }).reason, 'status:vacation');
  assert.equal(E.dayContext(DATE, cfg, { dayStatus: { [DATE]: { type: 'close_at', closeAt: '16:00' } } }).closeMin, 16 * 60);
  assert.equal(E.dayContext('2026-09-24', cfg).closeMin, 14 * 60);   // ערב חג
  assert.equal(E.dayContext('2026-07-17', cfg).closeMin, 15 * 60 + 30); // שישי קיץ
  assert.equal(E.dayContext('2026-12-18', cfg).closeMin, 14 * 60);      // שישי חורף
});

test('לקוח יחיד: מצב ברירת מחדל = רק יאיר, צעדים של 10 דקות', () => {
  const cfg = E.mergeConfig({}); // נהוראי/יוסף בלי שעות
  const ctx = ctxFor(cfg);
  const slots = E.listSlots(ctx, [person(cfg, 'haircut')], 'any', NOW);
  assert.equal(slots[0].time, '08:00');
  assert.equal(slots.at(-1).time, '19:40'); // תספורת 20 דק' נגמרת ב-20:00
  assert.equal(slots[1].time, '08:10');
});

test('תור קיים חוסם, כולל מרווח 5 דקות לפני ואחרי', () => {
  const cfg = E.mergeConfig({});
  const appt = { id: 'a', date: DATE, time: '10:00', status: 'confirmed' }; // ישן: 20 דק', יאיר
  const slots = times(E.listSlots(ctxFor(cfg, [appt]), [person(cfg, 'haircut')], 'any', NOW));
  assert.ok(slots.includes('09:30'));    // נגמר 09:50 + 5 מרווח <= 10:00
  assert.ok(!slots.includes('09:40'));   // נגמר 10:00, אין מרווח
  assert.ok(!slots.includes('10:00'));
  assert.ok(!slots.includes('10:10'));
  assert.ok(slots.includes('10:30'));    // 10:20 + 5 = 10:25 -> 10:30 תקין
  assert.ok(!slots.includes('10:20'));
});

test('תור מבוטל או לא-הגיע לא חוסם', () => {
  const cfg = E.mergeConfig({});
  for (const status of ['cancelled', 'no_show']) {
    const slots = times(E.listSlots(ctxFor(cfg, [{ id: 'a', date: DATE, time: '10:00', status }]), [person(cfg, 'haircut')], 'any', NOW));
    assert.ok(slots.includes('10:00'), status);
  }
});

test('הפסקה כללית ושל ספר, חופשה וחסימת שעות', () => {
  let cfg = E.mergeConfig({});
  cfg.settings.breaks = [{ days: [0], start: '13:00', end: '13:30' }];
  let slots = times(E.listSlots(ctxFor(cfg), [person(cfg, 'haircut')], 'any', NOW));
  assert.ok(!slots.includes('13:00') && !slots.includes('13:20') && !slots.includes('12:50'));
  assert.ok(slots.includes('12:40') && slots.includes('13:30'));

  cfg = E.mergeConfig({});
  cfg.barbers = cfg.barbers.map(b => b.id === 'yair' ? { ...b, blocks: [{ date: DATE, start: '09:00', end: '10:00' }] } : b);
  slots = times(E.listSlots(ctxFor(cfg), [person(cfg, 'haircut')], 'any', NOW));
  assert.ok(!slots.includes('09:30') && slots.includes('10:00') && slots.includes('08:40'));

  cfg = E.mergeConfig({});
  cfg.barbers = cfg.barbers.map(b => b.id === 'yair' ? { ...b, vacations: [{ from: '2026-10-30', to: '2026-11-02' }] } : b);
  assert.deepEqual(E.listSlots(ctxFor(cfg), [person(cfg, 'haircut')], 'any', NOW), []);
});

test('לא מציע שעה שאין בה מספיק זמן לכל הטיפולים', () => {
  const cfg = E.mergeConfig({});
  const long = { durationMin: 60, skills: ['haircut'] };
  const slots = times(E.listSlots(ctxFor(cfg), [long], 'any', NOW));
  assert.equal(slots.at(-1), '19:00');
  assert.ok(!slots.includes('19:10'));
});

test('ספר בלי הסמכה לשירות לא משובץ', () => {
  const cfg = cfgWith({ yair: { skills: ['haircut'] }, nehorai: { skills: ['beard'] }, yosef: { active: false } });
  const ctx = ctxFor(cfg);
  const r = E.place(ctx, [person(cfg, 'beard')], 'any', 9 * 60);
  assert.equal(r.assignments[0].barberId, 'nehorai');
  const r2 = E.place(ctx, [person(cfg, 'haircut')], 'any', 9 * 60);
  assert.equal(r2.assignments[0].barberId, 'yair');
  assert.equal(E.place(ctx, [person(cfg, 'haircut_beard')], 'any', 9 * 60), null); // אף ספר לא מוסמך לשניהם
});

test('מקביל: שני אנשים באותה שעה אצל ספרים שונים', () => {
  const cfg = cfgWith();
  const ctx = ctxFor(cfg);
  const r = E.place(ctx, [person(cfg, 'haircut'), person(cfg, 'haircut')], 'parallel', 10 * 60);
  assert.equal(r.mode, 'parallel');
  assert.equal(new Set(r.assignments.map(a => a.barberId)).size, 2);
  assert.ok(r.assignments.every(a => a.startMin === 600));
});

test('מקביל: אין מספיק ספרים פנויים => לא זמין; ברצף עדיין אפשרי', () => {
  const cfg = E.mergeConfig({}); // רק יאיר עם שעות
  const ctx = ctxFor(cfg);
  const two = [person(cfg, 'haircut'), person(cfg, 'haircut')];
  assert.equal(E.place(ctx, two, 'parallel', 600), null);
  const seq = E.place(ctx, two, 'sequential', 600);
  assert.equal(seq.mode, 'sequential');
  assert.deepEqual(seq.assignments.map(a => [a.startMin, a.endMin]), [[600, 620], [625, 645]]);
  const any = E.place(ctx, two, 'any', 600);
  assert.equal(any.mode, 'sequential');
});

test('ארבעה אנשים במקביל עם שלושה ספרים: אי אפשר; ברצף: אפשר', () => {
  const cfg = cfgWith();
  const ctx = ctxFor(cfg);
  const four = Array(4).fill(0).map(() => person(cfg, 'haircut'));
  assert.equal(E.place(ctx, four, 'parallel', 600), null);
  assert.ok(E.place(ctx, four, 'sequential', 600));
  assert.equal(E.place(ctx, four, 'any', 600).mode, 'sequential');
});

test('ברצף: אם ספר אחד תפוס באמצע, השני עובר לספר אחר', () => {
  const cfg = cfgWith();
  // יאיר תפוס 10:20-10:40 → אדם 2 (אחרי אדם 1 בן 20 דק') יתחיל 10:25 וחייב ספר אחר
  const appt = { id: 'x', date: DATE, time: '10:20', status: 'confirmed', barberId: 'yair', startMin: 620, endMin: 640 };
  const ctx = ctxFor(cfg, [appt]);
  const r = E.place(ctx, [person(cfg, 'haircut'), person(cfg, 'haircut')], 'sequential', 600);
  assert.ok(r);
  assert.ok(r.assignments[1].barberId !== 'yair' || r.assignments[1].startMin >= 645);
  // שיבוץ כללי: אף ספר לא חופף
  const byBarber = {};
  for (const a of [...r.assignments, { barberId: 'yair', startMin: 620, endMin: 640 }]) (byBarber[a.barberId] = byBarber[a.barberId] || []).push(a);
  for (const list of Object.values(byBarber)) for (const a of list) for (const b of list) if (a !== b) assert.ok(a.endMin <= b.startMin || b.endMin <= a.startMin);
});

test('ספר שיצא להפסקה לא מקבל תור באותה שעה (מקביל עובר ל-יחיד)', () => {
  const cfg = cfgWith({ nehorai: { breaks: [{ days: [0], start: '12:00', end: '13:00' }] }, yosef: { vacations: [{ from: DATE, to: DATE }] } });
  const ctx = ctxFor(cfg);
  const two = [person(cfg, 'haircut'), person(cfg, 'haircut')];
  assert.equal(E.place(ctx, two, 'parallel', 12 * 60 + 10), null);   // נהוראי בהפסקה, יוסף בחופשה
  assert.ok(E.place(ctx, two, 'parallel', 11 * 60 + 30));            // לפני ההפסקה
  assert.ok(E.place(ctx, two, 'parallel', 13 * 60));
});

test('אין ספר זמין בכלל => אין שעות', () => {
  const cfg = cfgWith({ yair: { active: false }, nehorai: { active: false }, yosef: { active: false } });
  assert.deepEqual(E.listSlots(ctxFor(cfg), [person(cfg, 'haircut')], 'any', NOW), []);
});

test('הזמנה מראש: מינימום 30 דקות וטווח 30 יום', () => {
  const cfg = cfgWith();
  const now = E.ilToEpoch(DATE, 10 * 60);
  const ctx = ctxFor(cfg);
  const slots = times(E.listSlots(ctx, [person(cfg, 'haircut')], 'any', now));
  assert.equal(slots[0], '10:30');
  assert.equal(E.leadOk(cfg, DATE, 10 * 60 + 29, now), false);
  assert.equal(E.leadOk(cfg, DATE, 10 * 60 + 30, now), true);
  assert.equal(E.leadOk(cfg, '2026-12-01', 600, now), true);   // בדיוק 30 יום
  assert.equal(E.leadOk(cfg, '2026-12-02', 600, now), false);
  assert.equal(E.leadOk(cfg, '2026-10-31', 600, now), false);  // עבר
});

test('איזון עומסים: מעדיף את הספר עם פחות עבודה היום', () => {
  const cfg = cfgWith();
  const appts = [{ id: 'a', date: DATE, time: '08:00', status: 'confirmed', barberId: 'yair', startMin: 480, endMin: 540 }];
  const r = E.place(ctxFor(cfg, appts), [person(cfg, 'haircut')], 'any', 12 * 60);
  assert.notEqual(r.assignments[0].barberId, 'yair');
});

test('התעלמות מתור מסוים (להזזת תור קיים)', () => {
  const cfg = E.mergeConfig({});
  const appt = { id: 'a', date: DATE, time: '10:00', status: 'confirmed' };
  const slots = times(E.listSlots(ctxFor(cfg, [appt], { ignoreIds: ['a'] }), [person(cfg, 'haircut')], 'any', NOW));
  assert.ok(slots.includes('10:00'));
});
