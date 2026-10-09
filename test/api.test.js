'use strict';
process.env.USE_MEMORY_DB = '1';
process.env.NODE_ENV = 'test';
process.env.DISABLE_INTERNAL_CRON = 'true';
process.env.ADMIN_KEY = 'test-admin-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine');
const { processOutbox } = require('../lib/notify');
const { app, db } = require('../server');

let server, base;
test.before(async () => { server = app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
test.beforeEach(() => db.reset());

const ADMIN = 'test-admin-key';
async function api(method, path, body, key) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// תאריך פתוח לפחות 4 ימים קדימה (בתוך 30 יום), יום חול רגיל
function openDate(offset = 4, skip = 0) {
  const cfg = E.mergeConfig({});
  let d = E.addDays(E.ilNow().date, offset), found = 0;
  for (let i = 0; i < 40; i++, d = E.addDays(d, 1)) {
    const c = E.dayContext(d, cfg);
    if (c.open && E.dowOf(d) <= 4 && c.closeMin === 20 * 60) { if (found++ === skip) return d; }
  }
  throw new Error('no open date');
}
const DATE = openDate();

const hours = { 0: [['08:00', '20:00']], 1: [['08:00', '20:00']], 2: [['08:00', '20:00']], 3: [['08:00', '20:00']], 4: [['08:00', '20:00']], 5: [['08:00', '14:00']] };
async function setupBarbers(tweaks = {}) {
  const cfg = (await api('GET', '/api/staff/config', null, ADMIN)).body;
  const barbers = cfg.barbers.map(b => ({ ...b, ...(b.id !== 'yair' ? { weeklyHours: hours } : {}), ...(tweaks[b.id] || {}) }));
  const r = await api('PUT', '/api/staff/config/barbers', { value: barbers }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const customer = (o = {}) => ({ fullName: 'ישראל ישראלי', phone: '050-1234567', notes: '', firstVisit: false, whatsappConsent: false, policyAccepted: true, ...o });
const book = (o = {}) => api('POST', '/api/v2/bookings', { customer: customer(o.customer), people: o.people || [{ serviceId: 'haircut' }], mode: o.mode || 'any', date: o.date || DATE, time: o.time || '10:00' });
const countDocs = async col => (await db.collection(col).get()).size;

test('קטלוג ציבורי: בלי ספרים/קודים, מחיר לא מאושר = null', async () => {
  const r = await api('GET', '/api/v2/catalog');
  assert.equal(r.status, 200);
  const s = Object.fromEntries(r.body.services.map(x => [x.id, x]));
  assert.equal(s.haircut.price, 50); assert.equal(s.kids_haircut.price, 50); assert.equal(s.haircut_beard.price, 70);
  assert.equal(s.beard.price, null); assert.equal(s.other.price, null);
  assert.equal(r.body.addons.length, 5);
  assert.ok(!JSON.stringify(r.body).includes('keyHash'));
  assert.ok(!('barbers' in r.body));
});

test('הצעת מחיר מחושבת בשרת', async () => {
  const r = await api('POST', '/api/v2/quote', { people: [{ serviceId: 'haircut_beard', addonIds: ['wax'] }, { serviceId: 'kids_haircut' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 120); assert.equal(r.body.priceComplete, false); assert.equal(r.body.totalDurationMin, 45 + 20);
});

test('הזמנה ללקוח יחיד נשמרת עם מחיר ומשך מהשרת (התעלמות ממחיר שהלקוח שלח)', async () => {
  const r = await api('POST', '/api/v2/bookings', { customer: customer(), people: [{ serviceId: 'haircut', price: 1, durationMin: 1 }], mode: 'any', date: DATE, time: '10:00' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.manageToken);
  assert.ok(!('barberId' in r.body) && !JSON.stringify(r.body).includes('yair'));
  const a = (await db.collection('appointments').get()).docs[0].data();
  assert.equal(a.price, 50); assert.equal(a.durationMin, 20); assert.equal(a.barberId, 'yair'); assert.equal(a.status, 'confirmed');
  assert.equal(a.phoneNorm, '0501234567'); assert.equal(a.endTime, '10:20');
});

test('הזמנה כפולה לאותה שעה נדחית (ספר יחיד)', async () => {
  assert.equal((await book()).status, 201);
  const r = await book({ customer: { fullName: 'לקוח שני', phone: '0521111111' } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'slot_unavailable');
  assert.equal(await countDocs('appointments'), 1);
});

test('מרוץ: 10 הזמנות בו-זמנית לאותה שעה עם ספר יחיד — בדיוק אחת מצליחה', async () => {
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => book({ customer: { fullName: `לקוח ${i}`, phone: `05000000${String(i).padStart(2, '0')}` } })));
  assert.equal(res.filter(r => r.status === 201).length, 1);
  assert.equal(res.filter(r => r.status === 409).length, 9);
  assert.equal(await countDocs('appointments'), 1);
  assert.equal(await countDocs('bookings'), 1);
});

test('מרוץ: 3 ספרים פעילים — בדיוק 3 הזמנות לאותה שעה מצליחות, בשלושה ספרים שונים', async () => {
  await setupBarbers();
  const res = await Promise.all(Array.from({ length: 9 }, (_, i) => book({ customer: { fullName: `לקוח ${i}`, phone: `05100000${String(i).padStart(2, '0')}` } })));
  assert.equal(res.filter(r => r.status === 201).length, 3);
  const barbers = (await db.collection('appointments').get()).docs.map(d => d.data().barberId);
  assert.deepEqual([...new Set(barbers)].sort(), ['nehorai', 'yair', 'yosef']);
});

test('מרוץ בין הזמנות חופפות חלקית (10:00 ו-10:10 ספר יחיד) — אין חפיפה', async () => {
  const times = ['10:00', '10:10', '10:20', '09:50', '09:40'];
  const res = await Promise.all(times.map((t, i) => book({ time: t, customer: { fullName: `לקוח ${i}`, phone: `05200000${String(i).padStart(2, '0')}` } })));
  const docs = (await db.collection('appointments').get()).docs.map(d => d.data()).sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < docs.length; i++) assert.ok(docs[i].startMin - docs[i - 1].endMin >= 5, 'חייב מרווח 5 דקות');
  assert.equal(res.filter(r => r.status === 201).length, docs.length);
});

test('קבוצה במקביל: שני אנשים באותה שעה אצל שני ספרים', async () => {
  await setupBarbers();
  const r = await book({ people: [{ serviceId: 'haircut' }, { serviceId: 'beard' }], mode: 'parallel' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const docs = (await db.collection('appointments').get()).docs.map(d => d.data());
  assert.equal(docs.length, 2);
  assert.ok(docs.every(d => d.time === '10:00'));
  assert.notEqual(docs[0].barberId, docs[1].barberId);
  assert.equal(new Set(docs.map(d => d.bookingId)).size, 1);
  assert.deepEqual(docs.map(d => d.serviceId).sort(), ['beard', 'haircut']);
});

test('קבוצה ברצף: 3 אנשים אחד אחרי השני עם מרווח 5 דקות', async () => {
  const r = await book({ people: Array(3).fill({ serviceId: 'haircut' }), mode: 'sequential' }); // ספר יחיד
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const docs = (await db.collection('appointments').get()).docs.map(d => d.data()).sort((a, b) => a.personIndex - b.personIndex);
  assert.deepEqual(docs.map(d => d.time), ['10:00', '10:25', '10:50']);
  assert.equal(r.body.endTime, '11:10');
});

test('קבוצה: הכול-או-כלום — אם אי אפשר לשבץ את כולם, שום דבר לא נשמר', async () => {
  await setupBarbers({ yosef: { active: false } }); // רק 2 ספרים
  const r = await book({ people: Array(3).fill({ serviceId: 'haircut' }), mode: 'parallel' });
  assert.equal(r.status, 409);
  assert.equal(await countDocs('appointments'), 0);
  assert.equal(await countDocs('bookings'), 0);
  assert.equal(await countDocs('outbox'), 0);
  assert.equal(await countDocs('customers'), 0);
});

test('קבוצה: מרוץ בין שתי הזמנות קבוצתיות — אחת מצליחה, השנייה לא משאירה שאריות', async () => {
  await setupBarbers({ yosef: { active: false } });
  const mk = i => book({ people: [{ serviceId: 'haircut' }, { serviceId: 'haircut' }], mode: 'parallel', customer: { fullName: `קבוצה ${i}`, phone: `05300000${i}0` } });
  const res = await Promise.all([mk(1), mk(2), mk(3)]);
  assert.equal(res.filter(r => r.status === 201).length, 1);
  assert.equal(await countDocs('appointments'), 2);
  assert.equal(await countDocs('bookings'), 1);
});

test('ספר בהפסקה / חופשה לא מקבל תור; שעת ההפסקה לא מוצעת', async () => {
  await setupBarbers({ nehorai: { breaks: [{ days: [0, 1, 2, 3, 4], start: '12:00', end: '13:00' }] }, yosef: { vacations: [{ from: DATE, to: DATE }] } });
  const av = await api('POST', '/api/v2/availability', { date: DATE, people: [{ serviceId: 'haircut' }, { serviceId: 'haircut' }], mode: 'parallel' });
  const times = av.body.slots.map(s => s.time);
  assert.ok(times.includes('11:00') && !times.includes('12:10') && times.includes('13:00'));
  const r = await book({ people: [{ serviceId: 'haircut' }, { serviceId: 'haircut' }], mode: 'parallel', time: '12:10' });
  assert.equal(r.status, 409);
  const ok = await book({ people: [{ serviceId: 'haircut' }, { serviceId: 'haircut' }], mode: 'parallel', time: '11:00' });
  assert.equal(ok.status, 201);
});

test('אין ספר זמין בכלל', async () => {
  await setupBarbers({ yair: { vacations: [{ from: DATE, to: DATE }] }, nehorai: { active: false }, yosef: { active: false } });
  const av = await api('POST', '/api/v2/availability', { date: DATE, people: [{ serviceId: 'haircut' }] });
  assert.deepEqual(av.body.slots, []);
  assert.equal((await book()).status, 409);
});

test('תספורת מיוחדת מאריכה את התור; תוספות; "לא רוצה להוסיף כלום" = בלי תוספות', async () => {
  const none = await book({ people: [{ serviceId: 'haircut', addonIds: [] }], time: '09:00' });
  assert.equal(none.status, 201);
  const special = await book({ people: [{ serviceId: 'haircut', haircutType: 'special', addonIds: ['wax', 'lines'] }], time: '11:00', customer: { phone: '0522222222' } });
  assert.equal(special.status, 201);
  const docs = (await db.collection('appointments').get()).docs.map(d => d.data());
  const sp = docs.find(d => d.haircutType === 'special');
  assert.equal(sp.durationMin, 20 + 20 + 10 + 10); assert.equal(sp.priceComplete, false);
  assert.deepEqual(sp.addonIds.sort(), ['lines', 'wax']);
  assert.equal(docs.find(d => d.time === '09:00').addonIds.length, 0);
});

test('ולידציה: טלפון, שם, מדיניות, מצב, שירות, כמות אנשים, תאריך, גריד', async () => {
  assert.equal((await book({ customer: { phone: '123' } })).body.error, 'bad_phone');
  assert.equal((await book({ customer: { fullName: 'א' } })).body.error, 'bad_name');
  assert.equal((await book({ customer: { policyAccepted: false } })).body.error, 'policy_required');
  assert.equal((await book({ mode: 'weird' })).body.error, 'bad_mode');
  assert.equal((await book({ people: [{ serviceId: 'nope' }] })).body.error, 'bad_people');
  assert.equal((await book({ people: Array(5).fill({ serviceId: 'haircut' }) })).body.error, 'bad_people');
  assert.equal((await book({ date: 'garbage' })).body.error, 'bad_datetime');
  assert.equal((await book({ time: '10:03' })).body.error, 'bad_time');
  assert.equal((await book({ date: E.addDays(E.ilNow().date, 45) })).status, 409); // מעבר לטווח 30 יום
  assert.equal((await book({ date: E.addDays(E.ilNow().date, -1) })).status, 409);
  assert.equal(await countDocs('appointments'), 0);
});

test('לא ניתן להזמין בשבת / חג / יום חסום / סטטוס חופשה', async () => {
  let sat = E.ilNow().date; while (E.dowOf(sat) !== 6) sat = E.addDays(sat, 1);
  assert.equal((await book({ date: sat })).body.error, 'day_closed');
  const blocked = openDate(5);
  await api('PUT', '/api/admin/blocked', [blocked], ADMIN);
  assert.equal((await book({ date: blocked })).body.error, 'day_closed');
  const vac = openDate(6);
  await api('PUT', '/api/admin/day-status', { date: vac, type: 'vacation' }, ADMIN);
  assert.equal((await book({ date: vac })).body.error, 'day_closed');
  const early = openDate(7);
  await api('PUT', '/api/admin/day-status', { date: early, type: 'close_at', closeAt: '12:00' }, ADMIN);
  assert.equal((await book({ date: early, time: '12:00' })).status, 409);
  assert.equal((await book({ date: early, time: '11:40' })).status, 201);
});

test('תור ישן (בלי ספר/משך) חוסם את יאיר ל-20 דקות', async () => {
  await db.collection('appointments').doc('old1').set({ id: 'old1', fullName: 'ישן', phone: '0501111111', notes: '', date: DATE, time: '10:00', status: 'confirmed', createdAt: 'x', source: 'client' });
  assert.equal((await book({ time: '10:00' })).status, 409);
  assert.equal((await book({ time: '10:10' })).status, 409);
  assert.equal((await book({ time: '10:30' })).status, 201); // 10:20 + 5 מרווח
});

test('מסלול הזמנה ישן (/api/appointments) עדיין עובד ואטומי', async () => {
  const mk = i => api('POST', '/api/appointments', { fullName: `ישן ${i}`, phone: `05400000${i}0`, notes: '', date: DATE, time: '14:00' });
  const res = await Promise.all([mk(1), mk(2), mk(3)]);
  assert.equal(res.filter(r => r.status === 201).length, 1);
  assert.equal(res.find(r => r.status === 409).body.error, 'Time already booked');
  const adm = await api('GET', `/api/admin/appointments?date=${DATE}`, null, ADMIN);
  assert.equal(adm.body.length, 1);
});

test('הרשאות: ללא מפתח 401; ספר רואה רק את שלו; ספר לא יכול לשנות/להגדיר', async () => {
  await setupBarbers();
  assert.equal((await api('GET', '/api/staff/me')).status, 401);
  assert.equal((await api('GET', '/api/staff/me', null, 'wrong')).status, 401);
  // קוד לנהוראי
  const cfg = (await api('GET', '/api/staff/config', null, ADMIN)).body;
  const barbers = cfg.barbers.map(b => ({ ...b, ...(b.id === 'nehorai' ? { newKey: 'nehorai-secret' } : {}) }));
  const put = await api('PUT', '/api/staff/config/barbers', { value: barbers }, ADMIN);
  assert.equal(put.status, 200);
  assert.ok(!JSON.stringify(put.body).includes('keyHash') && !JSON.stringify(put.body).includes('nehorai-secret'));
  const me = await api('GET', '/api/staff/me', null, 'nehorai-secret');
  assert.deepEqual([me.body.role, me.body.barberId], ['barber', 'nehorai']);

  for (let i = 0; i < 3; i++) await book({ customer: { fullName: `ל${i}`, phone: `05500000${i}0` } }); // 3 ספרים, אותה שעה
  const all = (await api('GET', `/api/staff/appointments?from=${DATE}&to=${DATE}`, null, ADMIN)).body;
  assert.equal(all.length, 3);
  const mine = (await api('GET', `/api/staff/appointments?from=${DATE}&to=${DATE}`, null, 'nehorai-secret')).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].barberId, 'nehorai');
  const other = all.find(a => a.barberId === 'yair');
  assert.equal((await api('PATCH', `/api/staff/appointments/${other.id}`, { status: 'arrived' }, 'nehorai-secret')).status, 403);
  assert.equal((await api('PATCH', `/api/staff/appointments/${mine[0].id}`, { status: 'arrived' }, 'nehorai-secret')).status, 200);
  assert.equal((await api('POST', `/api/staff/appointments/${mine[0].id}/modify`, { time: '11:00' }, 'nehorai-secret')).status, 403);
  assert.equal((await api('PUT', '/api/staff/config/settings', { value: {} }, 'nehorai-secret')).status, 403);
  assert.equal((await api('GET', '/api/staff/customers?q=ישראל', null, 'nehorai-secret')).status, 403);
  assert.equal((await api('GET', '/api/staff/config', null, 'nehorai-secret')).body.settings, undefined);
  // ספר שהושבת — הקוד שלו לא תקף
  barbers.find(b => b.id === 'nehorai').active = false;
  await api('PUT', '/api/staff/config/barbers', { value: barbers }, ADMIN);
  assert.equal((await api('GET', '/api/staff/me', null, 'nehorai-secret')).status, 401);
});

test('סטטוסים: מחזור חיים מלא, וסטטוס לא חוקי נדחה', async () => {
  const r = await book();
  const id = (await db.collection('appointments').get()).docs[0].id;
  for (const st of ['arrived', 'in_progress', 'completed']) assert.equal((await api('PATCH', `/api/staff/appointments/${id}`, { status: st }, ADMIN)).body.status, st);
  assert.equal((await api('PATCH', `/api/staff/appointments/${id}`, { status: 'nonsense' }, ADMIN)).status, 400);
  assert.equal((await api('PATCH', `/api/staff/appointments/nope`, { status: 'arrived' }, ADMIN)).status, 404);
  const book2 = await book({ time: '12:00', customer: { phone: '0533333333' } });
  const id2 = (await db.collection('appointments').get()).docs.map(d => d.data()).find(a => a.time === '12:00').id;
  assert.equal((await api('PATCH', `/api/staff/appointments/${id2}`, { status: 'no_show' }, ADMIN)).body.status, 'no_show');
  assert.equal(r.status, 201); assert.equal(book2.status, 201);
});

test('שינוי תאריך/שעה, שינוי ספר, שינוי שירות — בלי התנגשות', async () => {
  await setupBarbers();
  await book({ time: '10:00' });
  await book({ time: '10:00', customer: { phone: '0544444441' } });
  const docs = (await db.collection('appointments').get()).docs.map(d => d.data());
  const a = docs.find(d => d.barberId === 'yair'), b = docs.find(d => d.barberId !== 'yair');
  // העברת b לספר של a באותה שעה => התנגשות
  const clash = await api('POST', `/api/staff/appointments/${b.id}/modify`, { barberId: 'yair' }, ADMIN);
  assert.equal(clash.status, 409);
  // העברה לשעה פנויה
  const moved = await api('POST', `/api/staff/appointments/${b.id}/modify`, { time: '12:00' }, ADMIN);
  assert.equal(moved.status, 200); assert.equal(moved.body.appointment.time, '12:00');
  // החלפת ספר לספר פנוי
  const sw = await api('POST', `/api/staff/appointments/${a.id}/modify`, { barberId: 'yosef' }, ADMIN);
  assert.equal(sw.body.appointment.barberId, 'yosef');
  // שינוי שירות מאריך את התור; אם יוצר חפיפה — נדחה
  await book({ time: '10:30', customer: { phone: '0544444442' }, people: [{ serviceId: 'haircut' }] });
  const svc1 = await api('POST', `/api/staff/appointments/${a.id}/modify`, { serviceId: 'haircut_beard' }, ADMIN);
  assert.ok([200, 409].includes(svc1.status));
  const bad = await api('POST', `/api/staff/appointments/${a.id}/modify`, { serviceId: 'nope' }, ADMIN);
  assert.equal(bad.status, 400);
  // שני תורים בשום מצב לא חופפים אצל אותו ספר
  const final = (await db.collection('appointments').get()).docs.map(d => d.data());
  for (const x of final) for (const y of final) if (x !== y && x.barberId === y.barberId && x.date === y.date) {
    assert.ok(x.endMin <= y.startMin || y.endMin <= x.startMin, `חפיפה ${x.id}/${y.id}`);
  }
});

test('ביטול עצמי לפי קישור: token שגוי נדחה; מוקדם מדי נדחה; ביטול משחרר את השעה', async () => {
  const r = await book();
  const { bookingId, manageToken } = r.body;
  assert.equal((await api('GET', `/api/v2/bookings/${bookingId}`)).status, 404);
  assert.equal((await api('GET', `/api/v2/bookings/${bookingId}?token=bad`)).status, 404);
  const view = await api('GET', `/api/v2/bookings/${bookingId}?token=${manageToken}`);
  assert.equal(view.status, 200); assert.equal(view.body.canCancel, true);
  assert.ok(!JSON.stringify(view.body).includes('0501234567') && !JSON.stringify(view.body).includes('yair'));
  assert.equal((await api('POST', `/api/v2/bookings/${bookingId}/cancel`, { token: 'bad' })).status, 404);
  assert.equal((await api('POST', `/api/v2/bookings/${bookingId}/cancel`, { token: manageToken })).status, 200);
  assert.equal((await api('POST', `/api/v2/bookings/${bookingId}/cancel`, { token: manageToken })).body.error, 'already_cancelled');
  assert.equal((await book({ customer: { phone: '0566666666' } })).status, 201); // השעה התפנתה

  // סמוך מדי לתור (מדיניות ביטול)
  const cfg = (await api('GET', '/api/staff/config', null, ADMIN)).body;
  await api('PUT', '/api/staff/config/settings', { value: { ...cfg.settings, cancelBeforeHours: 72 } }, ADMIN);
  const near = await book({ date: openDate(1), time: '10:00', customer: { phone: '0577777777' } });
  const tooLate = await api('POST', `/api/v2/bookings/${near.body.bookingId}/cancel`, { token: near.body.manageToken });
  assert.equal(tooLate.status, 403); assert.equal(tooLate.body.error, 'too_late');
});

test('ביטול הזמנה קבוצתית מבטל את כל האנשים', async () => {
  await setupBarbers();
  const r = await book({ people: [{ serviceId: 'haircut' }, { serviceId: 'haircut' }, { serviceId: 'beard' }], mode: 'parallel' });
  assert.equal(r.status, 201);
  const c = await api('POST', `/api/v2/bookings/${r.body.bookingId}/cancel`, { token: r.body.manageToken });
  assert.equal(c.body.cancelled, 3);
  assert.ok((await db.collection('appointments').get()).docs.every(d => d.data().status === 'cancelled'));
});

test('הסכמה לוואטסאפ: בלי הסכמה לא נוצרות הודעות; עם הסכמה נשמרת + אישור ותזכורות', async () => {
  await book();
  assert.equal(await countDocs('outbox'), 0);
  const noConsent = (await db.collection('bookings').get()).docs[0].data();
  assert.equal(noConsent.consent.whatsappReminders, false); assert.equal(noConsent.consent.grantedAt, null);

  const r = await book({ time: '11:00', customer: { phone: '0588888888', whatsappConsent: true } });
  const b = (await db.collection('bookings').doc(r.body.bookingId).get()).data();
  assert.equal(b.consent.whatsappReminders, true); assert.ok(b.consent.grantedAt); assert.equal(b.consent.marketing, false);
  const out = (await db.collection('outbox').get()).docs.map(d => d.data());
  assert.deepEqual(out.map(o => o.kind).sort(), ['confirm', 'rem24', 'rem2h']);
  assert.ok(out.every(o => o.category === 'service' && o.to === '972588888888'));
  assert.ok(out.find(o => o.kind === 'confirm').text.includes(`t=${r.body.manageToken}`));
  assert.ok(!out.find(o => o.kind === 'rem2h').text.includes('t='));
  const start = E.ilToEpoch(DATE, 11 * 60);
  assert.equal(Date.parse(out.find(o => o.kind === 'rem24').scheduledFor), start - 24 * 3600000);
  assert.equal(Date.parse(out.find(o => o.kind === 'rem2h').scheduledFor), start - 2 * 3600000);
  const cust = (await db.collection('customers').doc('0588888888').get()).data();
  assert.equal(cust.whatsappReminders, true);
});

test('תור-הודעות: שליחה בלי כפילות, שינוי שעה מחליף תזכורות, ביטול שולח הודעת ביטול', async () => {
  const r = await book({ customer: { whatsappConsent: true } });
  const sentTo = [];
  const sender = { configured: true, send: async item => { sentTo.push(item.id); } };
  const t0 = Date.now() + 10 * 60000; // הודעת אישור "הגיע זמנה"
  const a = await processOutbox({ db, sender, nowMs: t0, log: {} });
  const b = await processOutbox({ db, sender, nowMs: t0, log: {} });
  assert.equal(a.sent, 1); assert.equal(b.sent, 0);
  assert.equal(sentTo.length, 1);
  assert.ok(sentTo[0].includes(':confirm:'));

  const appt = (await db.collection('appointments').get()).docs[0].data();
  const mv = await api('POST', `/api/staff/appointments/${appt.id}/modify`, { time: '12:00' }, ADMIN);
  assert.equal(mv.status, 200);
  const out = (await db.collection('outbox').get()).docs.map(d => d.data());
  const oldRem = out.filter(o => o.version === 1 && (o.kind === 'rem24' || o.kind === 'rem2h'));
  assert.ok(oldRem.length === 2 && oldRem.every(o => o.status === 'superseded'));
  const newRem = out.filter(o => o.version === 2);
  assert.deepEqual(newRem.map(o => o.kind).sort(), ['change', 'rem24', 'rem2h']);
  assert.ok(newRem.find(o => o.kind === 'change').text.includes('12:00'));

  await api('POST', `/api/v2/bookings/${r.body.bookingId}/cancel`, { token: r.body.manageToken });
  const after = (await db.collection('outbox').get()).docs.map(d => d.data());
  assert.ok(after.some(o => o.kind === 'cancel' && o.status === 'pending'));
  assert.ok(after.filter(o => o.kind.startsWith('rem')).every(o => o.status === 'superseded'));

  // כשל שליחה: ניסיונות חוזרים ואז failed
  db.reset();
  await book({ customer: { whatsappConsent: true } });
  const failing = { configured: true, send: async () => { throw new Error('boom'); } };
  for (let i = 0; i < 3; i++) await processOutbox({ db, sender: failing, nowMs: Date.now() + 60000, log: {} });
  const confirm = (await db.collection('outbox').get()).docs.map(d => d.data()).find(o => o.kind === 'confirm');
  assert.equal(confirm.status, 'failed'); assert.equal(confirm.attempts, 3);
});

test('ללא ספק וואטסאפ מוגדר: ההודעות נשארות להמתנה ואפשר לסמן "נשלח ידנית" פעם אחת', async () => {
  await book({ customer: { whatsappConsent: true } });
  const list = await api('GET', '/api/staff/outbox', null, ADMIN);
  assert.equal(list.body.providerConfigured, false);
  assert.equal(list.body.items.length, 1); // רק אישור; התזכורות עדיין בעתיד
  const id = list.body.items[0].id;
  assert.equal((await api('POST', `/api/staff/outbox/${encodeURIComponent(id)}/mark-sent`, {}, ADMIN)).status, 200);
  assert.equal((await api('POST', `/api/staff/outbox/${encodeURIComponent(id)}/mark-sent`, {}, ADMIN)).status, 409);
});

test('לקוח חוזר מזוהה בצד שרת בלבד, בלי חשיפת היסטוריה בנתיבים ציבוריים', async () => {
  await book({ customer: { phone: '0599999999' } });
  const second = await book({ time: '12:00', customer: { phone: '0599999999' } });
  assert.ok(!('knownCustomer' in second.body) && !JSON.stringify(second.body).includes('bookingsCount'));
  const bk = (await db.collection('bookings').doc(second.body.bookingId).get()).data();
  assert.equal(bk.knownCustomer, true);
  assert.equal((await db.collection('customers').doc('0599999999').get()).data().bookingsCount, 2);
  // אין נתיב ציבורי שמחזיר נתוני לקוח לפי טלפון
  for (const p of ['/api/v2/customers/0599999999', '/api/v2/history?phone=0599999999', '/api/staff/customers?q=0599999999', '/api/staff/customers/0599999999/history']) {
    const r = await api('GET', p);
    assert.ok([401, 404].includes(r.status), p + ' -> ' + r.status);
  }
  const hist = await api('GET', '/api/staff/customers/0599999999/history', null, ADMIN);
  assert.equal(hist.body.appointments.length, 2);
  const search = await api('GET', `/api/staff/customers?q=${encodeURIComponent('ישראל')}`, null, ADMIN);
  assert.equal(search.body[0].phone, '0599999999');
});

test('הגדרות: ולידציה, אי-חשיפת קודים, עריכת מחיר ומשך משפיעה על חישוב', async () => {
  const cfg = (await api('GET', '/api/staff/config', null, ADMIN)).body;
  const bad = cfg.services.map(s => s.id === 'beard' ? { ...s, durationMin: 0 } : s);
  assert.equal((await api('PUT', '/api/staff/config/services', { value: bad }, ADMIN)).status, 400);
  assert.equal((await api('PUT', '/api/staff/config/services', { value: cfg.services.map(s => ({ ...s, id: 'dup' })) }, ADMIN)).status, 400);
  assert.equal((await api('PUT', '/api/staff/config/nonsense', { value: [] }, ADMIN)).status, 400);
  const upd = cfg.services.map(s => s.id === 'beard' ? { ...s, price: 30, durationMin: 25 } : s);
  assert.equal((await api('PUT', '/api/staff/config/services', { value: upd }, ADMIN)).status, 200);
  const q = await api('POST', '/api/v2/quote', { people: [{ serviceId: 'beard' }] });
  assert.equal(q.body.price, 30); assert.equal(q.body.priceComplete, true); assert.equal(q.body.totalDurationMin, 25);
  const s2 = { ...cfg.settings, bufferMin: 0, slotStepMin: 20 };
  assert.equal((await api('PUT', '/api/staff/config/settings', { value: s2 }, ADMIN)).status, 200);
  assert.equal((await book({ time: '10:10' })).body.error, 'bad_time');
  assert.equal((await book({ time: '10:00' })).status, 201);
  assert.equal((await book({ time: '10:20', customer: { phone: '0511111112' } })).status, 201); // בלי מרווח
});

test('הזמנה ידנית של מנהל: כפיית ספר; מונעת חפיפה גם בעקיפת שעות', async () => {
  await setupBarbers();
  const mk = (o = {}) => api('POST', '/api/staff/bookings', { customer: { fullName: 'ידני', phone: '0501212121' }, people: [{ serviceId: 'haircut' }], date: DATE, time: '10:00', barberId: 'yosef', ...o }, ADMIN);
  const a = await mk(); assert.equal(a.status, 201); assert.equal(a.body.appointments[0].barberId, 'yosef');
  assert.equal((await mk()).status, 409);
  assert.equal((await mk({ override: true })).status, 409);                 // עקיפה לא מתירה חפיפה
  assert.equal((await mk({ time: '06:00', override: true })).status, 201);   // מחוץ לשעות — מותר למנהל
  assert.equal((await mk({ time: '06:00' })).status, 409);
});

test('אזור אישי: מזוהה רק לפי token של המכשיר, לא לפי טלפון', async () => {
  const r = await book({ customer: { fullName: 'דנה לוי', phone: '0541231234' } });
  const tok = r.body.customerToken;
  assert.ok(tok && tok.startsWith('0541231234.'));
  assert.equal((await api('GET', '/api/v2/me')).status, 401);
  assert.equal((await fetch(base + '/api/v2/me', { headers: { 'x-customer-token': '0541231234.guess' } })).status, 401);
  assert.equal((await fetch(base + '/api/v2/me', { headers: { 'x-customer-token': '0541231234' } })).status, 401);
  const me = await (await fetch(base + '/api/v2/me', { headers: { 'x-customer-token': tok } })).json();
  assert.equal(me.fullName, 'דנה לוי'); assert.equal(me.upcoming.length, 1); assert.equal(me.upcoming[0].bookingId, r.body.bookingId);
  // הזמנה נוספת מאותו מכשיר לא מנפיקה token חדש; מכשיר אחר כן, ושניהם תקפים
  const same = await fetch(base + '/api/v2/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-customer-token': tok },
    body: JSON.stringify({ customer: customer({ fullName: 'דנה לוי', phone: '0541231234' }), people: [{ serviceId: 'haircut' }], mode: 'any', date: DATE, time: '12:00' }) });
  assert.equal((await same.json()).customerToken, null);
  const other = await book({ time: '13:00', customer: { fullName: 'דנה לוי', phone: '0541231234' } });
  assert.ok(other.body.customerToken && other.body.customerToken !== tok);
  // לקוח אחר לא רואה את התורים של דנה
  const rr = await book({ time: '15:00', customer: { fullName: 'אחר', phone: '0549999000' } });
  const me2 = await (await fetch(base + '/api/v2/me', { headers: { 'x-customer-token': rr.body.customerToken } })).json();
  assert.equal(me2.upcoming.length, 1); assert.equal(me2.fullName, 'אחר');
});

test('כניסה אישית לכולם: יאיר מנהל (קוד אישי), ספר מוגבל; חייב להישאר מנהל פעיל', async () => {
  const cfg = (await api('GET', '/api/staff/config', null, ADMIN)).body;
  assert.equal(cfg.barbers.find(b => b.id === 'yair').role, 'admin');
  assert.equal(cfg.barbers.find(b => b.id === 'yosef').role, 'barber');
  const keyed = cfg.barbers.map(b => ({ ...b, newKey: { yair: 'yair-code-1', yosef: 'yosef-code-1' }[b.id] }));
  assert.equal((await api('PUT', '/api/staff/config/barbers', { value: keyed }, ADMIN)).status, 200);
  const y = await api('GET', '/api/staff/me', null, 'yair-code-1');
  assert.deepEqual([y.body.role, y.body.barberId], ['admin', 'yair']);
  assert.equal((await api('GET', '/api/staff/customers?q=ישראל', null, 'yair-code-1')).status, 200);
  assert.equal((await api('PUT', '/api/staff/config/settings', { value: cfg.settings }, 'yair-code-1')).status, 200);
  const s = await api('GET', '/api/staff/me', null, 'yosef-code-1');
  assert.deepEqual([s.body.role, s.body.barberId], ['barber', 'yosef']);
  assert.equal((await api('GET', '/api/staff/customers?q=ישראל', null, 'yosef-code-1')).status, 403);
  // אי אפשר להשאיר בלי מנהל פעיל
  const noAdmin = cfg.barbers.map(b => ({ ...b, role: 'barber' }));
  assert.equal((await api('PUT', '/api/staff/config/barbers', { value: noAdmin }, ADMIN)).status, 400);
});
