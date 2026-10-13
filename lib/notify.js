// הודעות ללקוחות: תור-הודעות (outbox) עם מניעת כפילויות ותיעוד, והפרדה בין הודעות שירות לשיווק.
// ההודעות נשלחות רק ללקוח שנתן הסכמה מפורשת (booking.consent.whatsappReminders === true).
// כרגע לא נשלחות הודעות שיווק בכלל.
'use strict';
const { ilToEpoch, toMin, ilNow, addDays } = require('./engine');

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const fmtDateHe = date => {
  const d = new Date(date + 'T12:00:00Z');
  return `יום ${HE_DAYS[d.getUTCDay()]}, ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};
// פורמט ישראלי לתבניות Meta: 12/10/2026
const fmtDateNum = date => { const [y, m, d] = date.split('-'); return `${d}/${m}/${y}`; };

function toE164(phoneNorm) { return phoneNorm.startsWith('0') ? '972' + phoneNorm.slice(1) : phoneNorm; }

// שמות התבניות המאושרות ב-Meta (חשבון המזכירה). אפשר לדרוס ב-WA_TEMPLATE_<KIND>; ערך ריק = שליחת טקסט רגיל.
// kind -> תבנית. כל תבנית מקבלת פרמטרים בדיוק לפי docs/whatsapp-templates.md.
const DEFAULT_TEMPLATES = {
  confirm: 'dalor_booking_confirm', group: 'dalor_booking_group', pending: 'dalor_booking_pending',
  approved: 'dalor_booking_approved', unavailable: 'dalor_booking_unavailable', change: 'dalor_booking_change',
  cancel: 'dalor_booking_cancel', cancel_confirm: 'dalor_booking_cancel_confirm',
  rem24: 'dalor_booking_rem24', rem2h: 'dalor_booking_rem2h',
};

const earliest = list => [...list].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
const firstName = booking => String(booking.fullName || '').trim().split(/\s+/)[0] || 'לקוח';
const serviceLabel = a => [...new Set([a && a.serviceName, ...((a && a.addonNames) || [])].filter(Boolean))].join(' + ') || 'תספורת';

// פרמטרים נפרדים לכל תבנית Meta (מיקום משמעותי!):
//  confirm {{1}} שם · {{2}} תאריך · {{3}} שעה · {{4}} שירות          group {{1}} שם · {{2}} מס' אנשים · {{3}} תאריך · {{4}} שעת התחלה
//  pending/approved/unavailable/change/cancel/cancel_confirm {{1}} שם · {{2}} תאריך · {{3}} שעה       rem24/rem2h {{1}} שם · {{2}} שעה
// appts = תורים פעילים; refAppts = התורים שעליהם מדווחים בביטול/דחייה (אין תורים פעילים).
function buildParams(kind, { booking, appts, refAppts }) {
  const list = (appts && appts.length) ? appts : (refAppts || []);
  const f = earliest(list);
  const name = firstName(booking);
  const date = f ? fmtDateNum(f.date) : '';
  const time = f ? f.time : '';
  switch (kind) {
    case 'confirm': return [name, date, time, serviceLabel(f)];
    case 'group': return [name, String(list.length), date, time];
    case 'rem24': case 'rem2h': return [name, time];
    default: return [name, date, time]; // pending/approved/unavailable/change/cancel/cancel_confirm
  }
}

// טקסט רגיל — לשליחה ידנית בממשק ולמצב ללא תבנית (WA_TEMPLATE_<KIND>=).
function buildText(kind, { booking, appts, refAppts, manageUrl }) {
  const list = (appts && appts.length) ? appts : (refAppts || []);
  const f = earliest(list);
  const when = f ? `${fmtDateHe(f.date)} בשעה ${f.time}` : '';
  const who = firstName(booking);
  const people = list.length > 1 ? ` (${list.length} אנשים)` : '';
  const link = manageUrl ? `\nלביטול התור: ${manageUrl}` : '';
  switch (kind) {
    case 'confirm': return `שלום ${who}, התור שלך במספרת DALOR נקבע ל${when}${people}.${link}`;
    case 'group': return `שלום ${who}, התורים שהזמנת במספרת DALOR נקבעו ל${when}${people}.${link}`;
    case 'pending': return `שלום ${who}, קיבלנו את הבקשה שלך לתור ב${when}. התור ממתין לאישור המספרה ונעדכן אותך.`;
    case 'approved': return `שלום ${who}, התור שביקשת במספרת DALOR אושר ל${when}${people}.${link}`;
    case 'unavailable': return `שלום ${who}, לצערנו לא הצלחנו לאשר את התור שביקשת ל${when}. אפשר לבחור מועד אחר.`;
    case 'rem24': return `שלום ${who}, תזכורת: התור שלך במספרת DALOR מחר, ${when}${people}.${link}`;
    case 'rem2h': return `שלום ${who}, תזכורת: התור שלך במספרת DALOR בעוד כשעתיים, ${when}${people}.`;
    case 'change': return `שלום ${who}, התור שלך במספרת DALOR עודכן ל${when}${people}.${link}`;
    case 'cancel': return `שלום ${who}, התור שלך במספרת DALOR ל${when} בוטל. לקביעת תור חדש: ${manageUrl ? manageUrl.split('?')[0] : ''}`.trim();
    case 'cancel_confirm': return `שלום ${who}, כמו שביקשת, ביטלנו את התור שלך במספרת DALOR ל${when}.`;
    default: return '';
  }
}

// מחשב אילו הודעות ליצור/לבטל. פונקציה טהורה — הקריאה/כתיבה נעשית בטרנזקציה בשכבת השירות.
// kind = האירוע: created | approved | change | cancel | cancel_confirm | unavailable  (confirm = כינוי ל-created)
// existing: מסמכי outbox קיימים של ההזמנה. מחזיר { supersede:[ids], create:[docs] }
//
// כללים: תור שממתין לאישור מקבל רק "pending" — בלי תזכורות עד שאושר. הזמנה קבוצתית (2+) מקבלת "group" במקום
// confirm. ביטול/דחייה מבטלים כל הודעה שעוד לא נשלחה. מאותו אירוע יוצאת הודעה אחת בלבד (מזהה ייחודי לפי גרסה).
function planNotifications({ booking, activeAppts, refAppts, kind, existing, cfg, nowMs, baseUrl }) {
  if (kind === 'confirm') kind = 'created';
  const unsent = existing.filter(o => o.status === 'pending');
  const reminderIds = unsent.filter(o => o.kind === 'rem24' || o.kind === 'rem2h').map(o => o.id);
  const closing = kind === 'cancel' || kind === 'cancel_confirm' || kind === 'unavailable';
  const staleIds = closing ? unsent.map(o => o.id) : kind === 'approved' ? unsent.filter(o => o.kind === 'pending').map(o => o.id) : reminderIds;
  const supersede = [...new Set([...staleIds, ...reminderIds])];
  const create = [];
  if (!booking.consent || booking.consent.whatsappReminders !== true) return { supersede, create };

  const version = booking.version || 1;
  const manageUrl = closing ? `${baseUrl}/` : `${baseUrl}/?b=${booking.id}&t=${booking.manageToken}`;
  const base = { bookingId: booking.id, phone: booking.phoneNorm, to: toE164(booking.phoneNorm), category: 'service', status: 'pending', attempts: 0, version, createdAt: new Date(nowMs).toISOString() };
  const mk = (k, scheduledMs) => {
    const id = `${booking.id}:${k}:v${version}`;
    if (existing.some(o => o.id === id)) return; // כבר קיים — לא כפילות
    const ctx = { booking, appts: activeAppts, refAppts, manageUrl };
    create.push({ ...base, id, kind: k, scheduledFor: new Date(scheduledMs).toISOString(), text: buildText(k, ctx), params: buildParams(k, ctx) });
  };

  if (closing) { mk(kind, nowMs); return { supersede, create }; }
  const waiting = booking.status === 'pending';
  const people = (activeAppts || []).length;
  if (kind === 'created') mk(waiting ? 'pending' : people > 1 ? 'group' : 'confirm', nowMs);
  else if (kind === 'approved') mk('approved', nowMs);
  else mk('change', nowMs);

  if (!waiting && people) {
    const first = earliest(activeAppts);
    const startMs = ilToEpoch(first.date, toMin(first.time));
    // "מחר" חייב להיות באמת מחר לפי התאריך המקומי (מעבר שעון קיץ)
    const tomorrow = addDays(ilNow(startMs - 24 * 3600000).date, 1) === first.date;
    if (tomorrow && startMs - 24 * 3600000 > nowMs) mk('rem24', startMs - 24 * 3600000);
    if (startMs - 2 * 3600000 > nowMs) mk('rem2h', startMs - 2 * 3600000);
  }
  return { supersede, create };
}

// ── שליחה ─────────────────────────────────────────────────────────
// WhatsApp Cloud API. הודעות מחוץ לחלון 24 שעות דורשות תבנית (template) מאושרת ב-Meta:
// ברירת המחדל: התבניות המאושרות ב-DALOR_BOOKING (DEFAULT_TEMPLATES). לדרוס: WA_TEMPLATE_<KIND>=שם; ריק = טקסט רגיל.
// Meta דוחה פרמטרים עם שורות חדשות/טאבים/4+ רווחים (שגיאה 132018) או ריקים.
const cleanParam = t => String(t ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';

// אותו מספר ושירות כמו המזכירה: WHATSAPP_* או (כברירת מחדל חלופית) META_WA_*.
// WA_ALLOWLIST (מספרים מופרדים בפסיק, 9725...) — שלב בדיקה: נשלח רק אליהם.
// WA_LIVE=true — שליחה ללקוחות אמיתיים. בלי זה (וגם בלי allowlist) לא נשלח כלום: ברירת המחדל בטוחה.
function makeSender(env = process.env, fetchImpl = globalThis.fetch) {
  const token = env.WHATSAPP_TOKEN || env.META_WA_TOKEN, phoneId = env.WHATSAPP_PHONE_ID || env.META_WA_PHONE_NUMBER_ID;
  const graph = env.META_GRAPH_VERSION || 'v21.0';
  const lang = env.META_WA_TEMPLATE_LANG || 'he';
  const configured = !!(token && phoneId);
  const allow = (env.WA_ALLOWLIST || '').split(',').map(x => x.trim()).filter(Boolean);
  const live = String(env.WA_LIVE || '').toLowerCase() === 'true';
  const allowed = to => allow.length ? allow.includes(to) : live;
  async function send(item) {
    if (!configured) throw new Error('whatsapp_not_configured');
    const override = env['WA_TEMPLATE_' + item.kind.toUpperCase()];
    const tpl = override !== undefined ? override : DEFAULT_TEMPLATES[item.kind];
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

module.exports = { buildParams, buildText, planNotifications, makeSender, processOutbox, toE164, fmtDateHe, fmtDateNum, DEFAULT_TEMPLATES };
