'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSender, planNotifications, buildParams, DEFAULT_TEMPLATES } = require('../lib/notify');

const booking = (consent) => ({ id: 'b1', fullName: 'דנה', phoneNorm: '0501234567', manageToken: 't', version: 1, consent });
const appts = [{ date: '2030-01-07', time: '10:00' }];
const plan = (consent) => planNotifications({ booking: booking(consent), activeAppts: appts, kind: 'confirm', existing: [], cfg: {}, nowMs: Date.parse('2030-01-01T00:00:00Z'), baseUrl: 'https://x' });

test('בלי הסכמה — לא נוצרות הודעות בכלל', () => {
  assert.equal(plan({ whatsappReminders: false }).create.length, 0);
  assert.equal(plan(undefined).create.length, 0);
  assert.ok(plan({ whatsappReminders: true }).create.length > 0);
});

test('פרמטרים לתבנית: נפרדים, ובלי שורות חדשות', async () => {
  const calls = [];
  const s = makeSender({ META_WA_TOKEN: 'T', META_WA_PHONE_NUMBER_ID: 'P', WA_TEMPLATE_REM24: 'rem24_he' }, async (u, o) => { calls.push({ u, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({}) }; });
  assert.ok(s.configured);
  await s.send({ kind: 'rem24', to: '972501234567', text: 'x', params: ['דנה', 'יום ראשון\nבשעה 10:00', 'https://x/?b=1'] });
  const ps = calls[0].body.template.components[0].parameters.map(p => p.text);
  assert.deepEqual(ps, ['דנה', 'יום ראשון בשעה 10:00', 'https://x/?b=1']);
  assert.match(calls[0].u, /\/P\/messages$/);
});

test('allowlist ושליחה חיה: בלי allowlist ובלי WA_LIVE לא נשלח לאף אחד', () => {
  const base = { WHATSAPP_TOKEN: 'T', WHATSAPP_PHONE_ID: 'P' };
  const s = makeSender({ ...base, WA_ALLOWLIST: '972501111111' });
  assert.ok(s.allowed('972501111111'));
  assert.ok(!s.allowed('972502222222'));
  assert.ok(!makeSender(base).allowed('972502222222'), 'ברירת מחדל בטוחה: לא חי');
  assert.ok(makeSender({ ...base, WA_LIVE: 'true' }).allowed('972502222222'));
  assert.ok(!makeSender({ ...base, WA_LIVE: 'true', WA_ALLOWLIST: '972501111111' }).allowed('972502222222'), 'allowlist מגביל גם כשחי');
});

test('שליחה: ברירת המחדל היא התבניות המאושרות ב-Meta, והפרמטרים לפי הסדר', async () => {
  const calls = [];
  const s = makeSender({ META_WA_TOKEN: 'T', META_WA_PHONE_NUMBER_ID: 'P' }, async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; });
  await s.send({ kind: 'confirm', to: '972501234567', text: 'x', params: ['דנה', '12/10/2026', '17:30', 'תספורת + זקן'] });
  assert.equal(calls[0].type, 'template');
  assert.equal(calls[0].template.name, 'dalor_booking_confirm');
  assert.equal(calls[0].template.language.code, 'he');
  assert.deepEqual(calls[0].template.components[0].parameters.map(p => p.text), ['דנה', '12/10/2026', '17:30', 'תספורת + זקן']);
  assert.deepEqual(Object.keys(DEFAULT_TEMPLATES).sort(), ['approved', 'cancel', 'cancel_confirm', 'change', 'confirm', 'group', 'pending', 'rem24', 'rem2h', 'unavailable']);
  // דריסה ריקה = טקסט רגיל
  const s2 = makeSender({ META_WA_TOKEN: 'T', META_WA_PHONE_NUMBER_ID: 'P', WA_TEMPLATE_CONFIRM: '' }, async (u, o) => { calls.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; });
  await s2.send({ kind: 'confirm', to: '972501234567', text: 'שלום', params: ['דנה'] });
  assert.equal(calls[1].type, 'text');
});

test('buildParams: מספר הפרמטרים תואם לתבניות המאושרות', () => {
  const bk = { fullName: 'דנה כהן' };
  const ap = [{ date: '2026-10-12', time: '17:30', serviceName: 'תספורת', addonNames: ['זקן'] }];
  assert.deepEqual(buildParams('confirm', { booking: bk, appts: ap }), ['דנה', '12/10/2026', '17:30', 'תספורת + זקן']);
  assert.deepEqual(buildParams('rem24', { booking: bk, appts: ap }), ['דנה', '17:30']);
  assert.deepEqual(buildParams('rem2h', { booking: bk, appts: ap }), ['דנה', '17:30']);
  for (const k of ['pending', 'approved', 'unavailable', 'change']) assert.deepEqual(buildParams(k, { booking: bk, appts: ap }), ['דנה', '12/10/2026', '17:30']);
  assert.deepEqual(buildParams('group', { booking: bk, appts: [...ap, ap[0]] }), ['דנה', '2', '12/10/2026', '17:30']);
});

test('buildParams: ביטול/דחייה מדווחים על התור שבוטל (אין תורים פעילים)', () => {
  const bk = { fullName: 'דנה' };
  const gone = [{ date: '2026-10-13', time: '18:00' }];
  assert.deepEqual(buildParams('cancel', { booking: bk, appts: [], refAppts: gone }), ['דנה', '13/10/2026', '18:00']);
  assert.deepEqual(buildParams('cancel_confirm', { booking: bk, appts: [], refAppts: gone }), ['דנה', '13/10/2026', '18:00']);
});
