// הרשאות: מנהל (ADMIN_KEY), ספר (קוד אישי, נשמר כ-hash), לקוח (ציבורי).
'use strict';
const crypto = require('crypto');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function hashKey(key) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(key), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyKey(key, stored) {
  if (!stored || !key) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(key), salt, 32).toString('hex');
  return safeEq(test, hash);
}

// cache קצר כדי לא להריץ scrypt על כל בקשה (הממשק מרענן כל 30 שניות)
function makeAuthenticator({ adminKey, loadBarbers, ttlMs = 60000 }) {
  const cache = new Map();
  const fp = k => crypto.createHash('sha256').update(String(k)).digest('hex');

  async function authenticate(key) {
    if (!key) return null;
    if (safeEq(key, adminKey)) return { role: 'admin' };
    const id = fp(key);
    const hit = cache.get(id);
    if (hit && hit.exp > Date.now()) return hit.principal;
    const barbers = await loadBarbers();
    for (const b of barbers) {
      if (b.active && b.keyHash && verifyKey(key, b.keyHash)) {
        const principal = { role: b.role === 'admin' ? 'admin' : 'barber', barberId: b.id, name: b.name };
        cache.set(id, { principal, exp: Date.now() + ttlMs });
        return principal;
      }
    }
    return null;
  }
  authenticate.invalidate = () => cache.clear();
  return authenticate;
}

module.exports = { hashKey, verifyKey, makeAuthenticator, safeEq };
