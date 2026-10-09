// חשבון לקוח אופציונלי: כניסה עם מייל (קוד חד-פעמי, בלי סיסמה). המכשיר נשאר מחובר.
// חשבון מקשר רק טלפונים שהלקוח עצמו הזמין איתם בזמן שהיה מחובר — אין חשיפת היסטוריה לפי טלפון.
'use strict';
const crypto = require('crypto');
const { safeEq } = require('./auth');

class AccountError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const normEmail = e => { const s = String(e || '').trim().toLowerCase(); return s.length <= 120 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(s) ? s : null; };

const CODE_TTL_MS = 10 * 60000, MAX_ATTEMPTS = 5, MAX_SENDS = 3, SEND_WINDOW_MS = 30 * 60000;

function createAccountService({ db, sendMail, now = () => Date.now() }) {
  const codes = id => db.collection('authCodes').doc(id);
  const accts = id => db.collection('accounts').doc(id);
  const acctId = email => sha('acct:' + email).slice(0, 24);

  async function startEmail(rawEmail) {
    const email = normEmail(rawEmail);
    if (!email) throw new AccountError(400, 'bad_email', 'כתובת מייל לא תקינה');
    const ref = codes(sha(email));
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const sends = (s.exists ? s.data().sends || [] : []).filter(t => now() - t < SEND_WINDOW_MS);
      if (sends.length >= MAX_SENDS) throw new AccountError(429, 'too_many', 'נשלחו יותר מדי קודים. נסו שוב בעוד חצי שעה');
      tx.set(ref, { codeHash: sha(code + ':' + email), exp: now() + CODE_TTL_MS, attempts: 0, sends: [...sends, now()] });
    });
    try {
      await sendMail({
        to: email, subject: 'קוד הכניסה שלך ל-DALOR',
        text: `קוד הכניסה שלך: ${code}\nהקוד תקף ל-10 דקות. אם לא ביקשת להיכנס, אפשר להתעלם מההודעה.`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif"><p>קוד הכניסה שלך ל-DALOR:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>הקוד תקף ל-10 דקות. אם לא ביקשת להיכנס, אפשר להתעלם מההודעה.</p></div>`,
      });
    } catch (e) {
      console.error('[accounts] mail failed:', e.message);
      throw new AccountError(503, 'email_unavailable', 'לא הצלחנו לשלוח מייל כרגע. נסו שוב מאוחר יותר');
    }
    return { ok: true };
  }

  // phoneToken (אופציונלי): token של מכשיר קיים — מקשר את הטלפון של אותו מכשיר לחשבון
  async function verifyEmail(rawEmail, rawCode, phone) {
    const email = normEmail(rawEmail), code = String(rawCode || '').trim();
    if (!email || !/^\d{6}$/.test(code)) throw new AccountError(400, 'bad_code', 'קוד לא תקין');
    const ref = codes(sha(email)), id = acctId(email);
    const token = `acct.${id}.${crypto.randomBytes(24).toString('base64url')}`;
    // טרנזקציה "נכשלת" לא מעדכנת, אז ספירת ניסיונות כושלים נעשית אחריה
    const res = await db.runTransaction(async tx => {
      const s = await tx.get(ref), a = await tx.get(accts(id));
      if (!s.exists) return { fail: 'expired' };
      const c = s.data();
      if (c.exp < now()) { tx.delete(ref); return { fail: 'expired' }; }
      if (c.attempts >= MAX_ATTEMPTS) { tx.delete(ref); return { fail: 'locked' }; }
      if (!safeEq(sha(code + ':' + email), c.codeHash)) { tx.update(ref, { attempts: c.attempts + 1 }); return { fail: 'wrong' }; }
      tx.delete(ref);
      const cur = a.exists ? a.data() : { email, createdAt: new Date(now()).toISOString(), phones: [], sessions: [] };
      const phones = phone && !cur.phones.includes(phone) ? [...cur.phones, phone] : cur.phones;
      tx.set(accts(id), { ...cur, phones, sessions: [...cur.sessions, sha(token)].slice(-8) });
      return { ok: true };
    });
    if (res.fail === 'locked') throw new AccountError(429, 'locked', 'יותר מדי ניסיונות. בקשו קוד חדש');
    if (res.fail) throw new AccountError(400, res.fail === 'expired' ? 'expired' : 'wrong_code', res.fail === 'expired' ? 'הקוד פג תוקף. בקשו קוד חדש' : 'הקוד שגוי');
    return { token, email };
  }

  async function resolve(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'acct') return null;
    const s = await accts(parts[1]).get();
    if (!s.exists || !s.data().sessions.some(h => safeEq(h, sha(token)))) return null;
    return { id: parts[1], ...s.data() };
  }
  async function linkPhone(token, phone) {
    const a = await resolve(token);
    if (!a || a.phones.includes(phone)) return;
    await accts(a.id).update({ phones: [...a.phones, phone] });
  }
  async function logout(token) {
    const a = await resolve(token);
    if (a) await accts(a.id).update({ sessions: a.sessions.filter(h => !safeEq(h, sha(token))) });
  }
  return { startEmail, verifyEmail, resolve, linkPhone, logout };
}

module.exports = { createAccountService, AccountError, normEmail };
