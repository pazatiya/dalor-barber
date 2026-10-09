'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSender, planNotifications, buildParams } = require('../lib/notify');

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

test('allowlist: רק מספרים ברשימה', () => {
  const s = makeSender({ WHATSAPP_TOKEN: 'T', WHATSAPP_PHONE_ID: 'P', WA_ALLOWLIST: '972501111111' });
  assert.ok(s.allowed('972501111111'));
  assert.ok(!s.allowed('972502222222'));
  assert.ok(makeSender({ WHATSAPP_TOKEN: 'T', WHATSAPP_PHONE_ID: 'P' }).allowed('972502222222'));
});

test('buildParams: cancel בלי טוקן ב-URL', () => {
  const p = buildParams('cancel', { booking: booking({}), appts, manageUrl: 'https://x/' });
  assert.deepEqual(p, ['דנה', 'https://x/']);
});
