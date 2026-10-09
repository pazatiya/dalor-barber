// הודעות ללקוחות: תור-הודעות (outbox) עם מניעת כפילויות ותיעוד, והפרדה בין הודעות שירות לשיווק.
// ההודעות נשלחות רק ללקוח שנתן הסכמה מפורשת (booking.consent.whatsappReminders === true).
// כרגע לא נשלחות הודעות שיווק בכלל.
'use strict';
const { ilToEpoch, toMin } = require('./engine');

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const fmtDateHe = date => {
  const d = new Date(date + 'T12:00:00Z');
  return `יום ${HE_DAYS[d.getUTCDay()]}, ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};

function toE164(phoneNorm) { return phoneNorm.startsWith('0') ? '972' + phoneNorm.slice(1) : phoneNorm; }

// פרמטרים נפרדים לתבנית Meta: {{1}} שם · {{2}} מתי · {{3}} קישור (רק בסוגים שיש בהם קישור)
function buildParams(kind, { booking, appts, manageUrl }) {
  const first = [...appts].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  const when = (first ? `${fmtDateHe(first.date)} בשעה ${first.time}` : '') + (appts.length > 1 ? ` (${appts.length} אנשים)` : '');
  const link = kind === 'cancel' ? (manageUrl ? manageUrl.split('?')[0] : '') : manageUrl || '';
  if (kind === 'cancel') return [booking.fullName, link];
  if (kind === 'rem2h') return [booking.fullName, when];
  return [booking.fullName, when, link];
}

function buildText(kind, { booking, appts, manageUrl }) {
  const first = [...appts].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  const when = first ? `${fmtDateHe(first.date)} בשעה ${first.time}` : '';
  const who = booking.fullName;
  const people = appts.length > 1 ? ` (${appts.length} אנשים)` : '';
  const link = manageUrl ? `\nלביטול התור: ${manageUrl}` : '';
  switch (kind) {
    case 'confirm': return `שלום ${who}, התור שלך במספרת DALOR נקבע ל${when}${people}.${link}`;
    case 'rem24':   return `שלום ${who}, תזכורת: התור שלך במספרת DALOR מחר, ${when}${people}.${link}`;
    case 'rem2h':   return `שלום ${who}, תזכורת: התור שלך במספרת DALOR בעוד כשעתיים, ${when}${people}.`;
    case 'change':  return `שלום ${who}, התור שלך במספרת DALOR עודכן ל${when}${people}.${link}`;
    case 'cancel':  return `שלום ${who}, התור שלך במספרת DALOR בוטל. לקביעת תור חדש: ${manageUrl ? manageUrl.split('?')[0] : ''}`.trim();
    default: return '';
  }
}

// מחשב אילו הודעות ליצור/לבטל. פונקציה טהורה — הקריאה/כתיבה נעשית בטרנזקציה בשכבת השירות.
// existing: מסמכי outbox קיימים של ההזמנה. מחזיר { supersede:[ids], create:[docs] }
function planNotifications({ booking, activeAppts, kind, existing, cfg, nowMs, baseUrl }) {
  const supersede = existing.filter(o => o.status === 'pending' && (o.kind === 'rem24' || o.kind === 'rem2h')).map(o => o.id);
  const create = [];
  if (!booking.consent || booking.consent.whatsappReminders !== true) return { supersede, create };

  const version = booking.version || 1;
  const manageUrl = kind === 'cancel' ? `${baseUrl}/` : `${baseUrl}/?b=${booking.id}&t=${booking.manageToken}`;
  const base = { bookingId: booking.id, phone: booking.phoneNorm, to: toE164(booking.phoneNorm), category: 'service', status: 'pending', attempts: 0, version, createdAt: new Date(nowMs).toISOString() };
  const mk = (k, scheduledMs) => {
    const id = `${booking.id}:${k}:v${version}`;
    if (existing.some(o => o.id === id)) return; // כבר קיים — לא כפילות
    create.push({ ...base, id, kind: k, scheduledFor: new Date(scheduledMs).toISOString(), text: buildText(k, { booking, appts: activeAppts, manageUrl }), params: buildParams(k, { booking, appts: activeAppts, manageUrl }) });
  };

  if (kind === 'cancel') { mk('cancel', nowMs); return { supersede, create }; }
  mk(kind === 'change' ? 'change' : 'confirm', nowMs);
  if (activeAppts.length) {
    const first = [...activeAppts].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    const startMs = ilToEpoch(first.date, toMin(first.time));
    if (startMs - 24 * 3600000 > nowMs) mk('rem24', startMs - 24 * 3600000);
    if (startMs - 2 * 3600000 > nowMs) mk('rem2h', startMs - 2 * 3600000);
  }
  return { supersede, create };
}

// ── שליחה ─────────────────────────────────────────────────────────
// WhatsApp Cloud API. הודעות מחוץ לחלון 24 שעות דורשות תבנית (template) מאושרת ב-Meta:
// הגדירו WA_TEMPLATE_CONFIRM / _REM24 / _REM2H / _CHANGE / _CANCEL (פרמטרים: שם, מתי).
// Meta דוחה פרמטרים עם שורות חדשות/טאבים/4+ רווחים (שגיאה 132018) או ריקים.
const cleanParam = t => String(t ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';

// אותו מספר ושירות כמו המזכירה: WHATSAPP_* או (כברירת מחדל חלופית) META_WA_*.
// WA_ALLOWLIST (מספרים מופרדים בפסיק, 9725...) — שלב בדיקה: נשלח רק אליהם.
function makeSender(env = process.env, fetchImpl = globalThis.fetch) {
  const token = env.WHATSAPP_TOKEN || env.META_WA_TOKEN, phoneId = env.WHATSAPP_PHONE_ID || env.META_WA_PHONE_NUMBER_ID;
  const graph = env.META_GRAPH_VERSION || 'v21.0';
  const lang = env.META_WA_TEMPLATE_LANG || 'he';
  const configured = !!(token && phoneId);
  const allow = (env.WA_ALLOWLIST || '').split(',').map(x => x.trim()).filter(Boolean);
  const allowed = to => !allow.length || allow.includes(to);
  async function send(item) {
    if (!configured) throw new Error('whatsapp_not_configured');
    const tpl = env['WA_TEMPLATE_' + item.kind.toUpperCase()];
    const params = Array.isArray(item.params) && item.params.length ? item.params : [item.text];
    const payload = tpl
      ? { messaging_product: 'whatsapp', to: item.to, type: 'template', template: { name: tpl, language: { code: lang }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: cleanParam(t) })) }] } }
      : { messaging_product: 'whatsapp', to: item.to, type: 'text', text: { body: item.text } };
    const r = await fetchImpl(`https://graph.facebook.com/${graph}/${phoneId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`whatsapp_http_${r.status}`);
    return r.json().catch(() => ({}));
  }
  return { configured, send, allowed };
}

const STALE_MS = 60 * 60 * 1000;

// שולח הודעות שהגיע זמנן. אם אין ספק מוגדר — ההודעות נשארות pending ונראות בממשק (שליחה ידנית).
async function processOutbox({ db, sender, nowMs = Date.now(), log = console }) {
  if (!sender.configured) return { sent: 0, failed: 0, skipped: 'not_configured' };
  const snap = await db.collection('outbox').where('status', '==', 'pending').get();
  let sent = 0, failed = 0;
  for (const d of snap.docs) {
    const item = d.data();
    if (Date.parse(item.scheduledFor) > nowMs) continue;
    // הודעה שהזמן שלה עבר מזמן (למשל אחרי השבתה/הפעלה מאוחרת) לא נשלחת — תזכורת מאוחרת מטעה
    if (nowMs - Date.parse(item.scheduledFor) > STALE_MS) {
      await d.ref.update({ status: 'expired', error: 'stale' });
      continue;
    }
    // שלב בדיקה: מספרים שאינם ברשימה לא מקבלים כלום ולא ייצברו להמשך
    if (sender.allowed && !sender.allowed(item.to)) {
      await d.ref.update({ status: 'skipped', error: 'not_in_allowlist' });
      continue;
    }
    // "claim" אטומי כדי שמופע שרת שני לא ישלח אותה הודעה
    const claimed = await db.runTransaction(async tx => {
      const cur = await tx.get(d.ref);
      if (!cur.exists || cur.data().status !== 'pending') return false;
      tx.update(d.ref, { status: 'sending', attempts: (cur.data().attempts || 0) + 1 });
      return true;
    });
    if (!claimed) continue;
    try {
      await sender.send(item);
      await d.ref.update({ status: 'sent', sentAt: new Date().toISOString(), channel: 'whatsapp' });
      sent++;
    } catch (e) {
      const attempts = (item.attempts || 0) + 1;
      await d.ref.update({ status: attempts >= 3 ? 'failed' : 'pending', error: String(e.message).slice(0, 200), attempts });
      failed++;
      log.error?.('[outbox]', item.id, e.message);
    }
  }
  return { sent, failed };
}

module.exports = { buildParams, buildText, planNotifications, makeSender, processOutbox, toE164, fmtDateHe };
