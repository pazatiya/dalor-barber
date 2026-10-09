// ממשק ניהול v2: יומן לפי ספר, שבוע, עריכת תור, הזמנה ידנית, לקוחות, הודעות והגדרות.
// נטען אחרי הסקריפט הפנימי של admin.html (משתמש ב-A, adminFetch, toISO, fmtShort וכו').
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_HE = { pending: 'ממתין לאישור', confirmed: 'מאושר', arrived: 'הגיע', in_progress: 'בטיפול', completed: 'הושלם', cancelled: 'בוטל', no_show: 'לא הגיע' };
const ACTIONS = {
  pending:     [['confirmed', 'אישור', 'done'], ['cancelled', 'ביטול', 'cancel']],
  confirmed:   [['arrived', 'הגיע', 'done'], ['no_show', 'לא הגיע', 'cancel'], ['cancelled', 'ביטול', 'cancel']],
  arrived:     [['in_progress', 'בטיפול', 'done'], ['completed', 'הושלם', 'done'], ['cancelled', 'ביטול', 'cancel']],
  in_progress: [['completed', 'הושלם', 'done']],
  completed:   [['confirmed', 'שחזור', 'undo']],
  cancelled:   [['confirmed', 'שחזור', 'undo']],
  no_show:     [['confirmed', 'שחזור', 'undo']],
};
const PALETTE = ['#c9a84c', '#60a5fa', '#a78bfa', '#34d399', '#fb923c', '#f472b6'];
const DAYS_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳'];
Object.assign(A, { role: 'admin', barberId: null, cfg: null, barberFilter: 'all', dayMode: 'list', weekStart: null, view: 'day', setTab: 'general' });

const isAdmin = () => A.role === 'admin';
const bName = id => (A.cfg?.barbers || []).find(b => b.id === id)?.name || id || '';
const bColor = id => PALETTE[Math.max(0, (A.cfg?.barbers || []).findIndex(b => b.id === id)) % PALETTE.length];
const waLink = (phone, text) => { const d = String(phone).replace(/\D/g, ''); return `https://wa.me/${d.startsWith('0') ? '972' + d.slice(1) : d}${text ? '?text=' + encodeURIComponent(text) : ''}`; };
const WA_ICON = '<svg style="width:13px;height:13px;fill:currentColor" viewBox="0 0 24 24"><path d="M12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 005.69 1.45c6.55 0 11.89-5.34 11.89-11.89A11.82 11.82 0 0012.05 0z"/></svg>';

async function api(method, url, body) {
  try {
    const r = await adminFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { message: 'בעיית תקשורת' } }; }
}
const errMsg = r => (r.data && (r.data.message || r.data.error)) || 'שגיאה';
const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return toISO(d); };
const sundayOf = ds => addDays(ds, -new Date(ds + 'T12:00:00').getDay());
const toMinA = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// ── התחברות ──────────────────────────────────────────────
async function tryLogin() {
  const k = document.getElementById('keyinput').value.trim();
  if (!k) { document.getElementById('loginerr').textContent = 'נא להזין מפתח כניסה'; return; }
  const r = await fetch('/api/staff/me', { headers: { 'x-admin-key': k } }).catch(() => null);
  if (!r || !r.ok) {
    document.getElementById('loginerr').textContent = 'מפתח שגוי — נסו שנית';
    document.getElementById('keyinput').value = ''; document.getElementById('keyinput').focus(); return;
  }
  const me = await r.json();
  A.key = k; A.role = me.role; A.barberId = me.barberId || null;
  localStorage.setItem(ADMIN_KEY_LS, k);
  showAdmin();
}
function logout() { localStorage.removeItem(ADMIN_KEY_LS); location.reload(); }

async function showAdmin() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('adminApp').classList.remove('hidden');
  const c = await api('GET', '/api/staff/config');
  A.cfg = c.ok ? c.data : { barbers: [], services: [], addons: [] };
  applyRole();
  startClock();
  A.weekStart = sundayOf(toISO(new Date()));
  setView('day');
  loadAllStats();
  if (isAdmin()) { checkReminders(); initPush(); }
  setInterval(() => { if (A.view === 'day') loadDay(); if (isAdmin()) checkReminders(); }, 30000);
}
function applyRole() {
  const admin = isAdmin();
  document.querySelectorAll('[data-admin]').forEach(e => e.classList.toggle('hidden', !admin));
  document.getElementById('fab').classList.toggle('hidden', !admin);
  document.getElementById('bellbtn').classList.toggle('hidden', !admin);
  document.getElementById('statusbtn').classList.toggle('hidden', !admin);
  document.querySelector('.ahsub').textContent = admin ? (A.barberId ? `מנהל: ${bName(A.barberId)}` : 'ממשק ניהול') : `ספר: ${bName(A.barberId) || ''}`;
}

// ── ניווט בין תצוגות ─────────────────────────────────────
function setView(v) {
  A.view = v;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  ['day', 'week', 'customers', 'outbox', 'settings'].forEach(x => document.getElementById('view-' + x).classList.toggle('hidden', x !== v));
  document.getElementById('fab').classList.toggle('hidden', !isAdmin() || v === 'settings');
  if (v === 'day') loadDay();
  if (v === 'week') loadWeek();
  if (v === 'customers') renderCustomers();
  if (v === 'outbox') loadOutbox();
  if (v === 'settings') loadSettings();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

function chipsHtml() {
  if (!isAdmin()) return '';
  const bs = (A.cfg.barbers || []).filter(b => b.active);
  return `<button class="chip ${A.barberFilter === 'all' ? 'on' : ''}" data-bf="all">כל הספרים</button>` +
    bs.map(b => `<button class="chip ${A.barberFilter === b.id ? 'on' : ''}" data-bf="${esc(b.id)}"><i style="background:${bColor(b.id)}"></i>${esc(b.name)}</button>`).join('');
}
function bindChips(el, after) {
  el.querySelectorAll('[data-bf]').forEach(b => b.addEventListener('click', () => { A.barberFilter = b.dataset.bf; after(); }));
}
const visible = list => (isAdmin() && A.barberFilter !== 'all') ? list.filter(a => a.barberId === A.barberFilter) : list;

// ── טעינה ────────────────────────────────────────────────
async function loadDay() {
  document.getElementById('navdate').textContent = fmtShort(A.curDate);
  const [ar, br, sr] = await Promise.all([
    api('GET', `/api/staff/appointments?from=${A.curDate}&to=${A.curDate}`),
    fetch('/api/blocked').then(r => r.ok ? r.json() : []).catch(() => []),
    fetch('/api/day-status').then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  A.appts = ar.ok ? ar.data : []; A.blocked = br; A.dayStatus = sr;
  document.getElementById('statusbtn')?.classList.toggle('has-status', !!A.dayStatus[A.curDate]);
  renderAppts();
}
async function loadAllStats() {
  const today = toISO(new Date()), weekEnd = addDays(today, 7);
  const r = await api('GET', `/api/staff/appointments?from=${today}&to=${weekEnd}`);
  const act = r.ok ? r.data.filter(a => !['cancelled', 'no_show'].includes(a.status)) : [];
  const t = act.filter(a => a.date === today).length;
  document.getElementById('statsbar').innerHTML = `
    <div class="stat today-stat"><span class="stat-n">${t}</span><span class="stat-l">תורים היום</span></div>
    <div class="stat clickable" onclick="setView('week')"><span class="stat-n">${act.length}</span><span class="stat-l">תורים שבוע ›</span></div>
    <div class="stat" id="nextStatCard"><span class="stat-n" style="font-size:.9rem;color:var(--mt)">—</span><span class="stat-l">התור הבא</span></div>`;
}

// ── יומן יומי ────────────────────────────────────────────
function renderAppts() {
  const list = document.getElementById('apptlist');
  const tools = document.getElementById('dayTools');
  tools.innerHTML = `<div class="chips">${chipsHtml()}</div>
    <div class="seg"><button data-dm="list" class="${A.dayMode === 'list' ? 'on' : ''}">רשימה</button><button data-dm="cols" class="${A.dayMode === 'cols' ? 'on' : ''}">יומן לפי ספר</button></div>`;
  bindChips(tools, renderAppts);
  tools.querySelectorAll('[data-dm]').forEach(b => b.addEventListener('click', () => { A.dayMode = b.dataset.dm; renderAppts(); }));

  document.getElementById('dayStatusBanner')?.remove();
  const st = A.dayStatus[A.curDate];
  if (st) {
    const cfg = STATUS_CFG[st.type] || {};
    const banner = document.createElement('div');
    banner.id = 'dayStatusBanner'; banner.className = `dsb dsb-${esc(st.type)}`;
    banner.innerHTML = `<span class="dsb-icon">${cfg.icon || '📋'}</span><span class="dsb-text">${esc(st.type === 'close_at' ? `עובדים עד ${st.closeAt}` : (st.note || cfg.label))}</span><span class="dsb-change">שנה ›</span>`;
    banner.onclick = () => openStatusModal(A.curDate);
    list.before(banner);
  }

  const all = visible(A.appts);
  const now = new Date(), cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (A.curDate === toISO(now)) {
    const next = all.find(a => a.time > cur && ['confirmed', 'pending'].includes(a.status));
    const card = document.getElementById('nextStatCard');
    if (card && next) { const n = card.querySelector('.stat-n'); n.textContent = next.time; n.style.fontSize = '1.5rem'; n.style.color = 'var(--gold2)'; card.querySelector('.stat-l').textContent = next.fullName; }
  }

  if (!all.length) {
    const d = new Date(A.curDate + 'T12:00:00');
    const msg = d.getDay() === 6 ? 'שבת שלום 🕍' : CLOSED.has(A.curDate) ? 'יום חג — מספרה סגורה 🕎' : A.blocked.includes(A.curDate) ? 'יום חסום — מספרה סגורה' : st ? (STATUS_CFG[st.type]?.msg || st.note || 'סטטוס מיוחד') : 'אין תורים ביום זה';
    list.innerHTML = `<div class="empty-day"><div class="em-ico">📅</div><p>${esc(msg)}</p></div>`;
    return;
  }
  if (A.dayMode === 'cols') {
    const bs = isAdmin() ? (A.cfg.barbers || []).filter(b => b.active && (A.barberFilter === 'all' || A.barberFilter === b.id)) : [{ id: A.barberId, name: bName(A.barberId) }];
    list.innerHTML = timeline(bs.map(b => ({ label: b.name, appts: all.filter(a => a.barberId === b.id) })));
    bindTimeline(list);
    return;
  }
  list.innerHTML = '';
  all.forEach(a => list.appendChild(apptCard(a)));
}

function servicesLine(a) {
  if (!a.serviceName) return '';
  const hc = a.haircutType === 'special' ? ' · תספורת מיוחדת' : '';
  const add = (a.addonNames || []).length ? ' + ' + a.addonNames.map(esc).join(', ') : '';
  return `${esc(a.serviceName)}${hc}${add}`;
}
function priceLine(a) {
  if (a.price == null) return '';
  return a.priceComplete === false ? (a.price > 0 ? `${a.price} ₪ + יתואם` : 'מחיר יתואם') : `${a.price} ₪`;
}
function apptCard(a) {
  const status = a.status || 'confirmed';
  const card = document.createElement('div');
  card.className = `acard ${status}`; card.id = `card-${a.id}`;
  const acts = (ACTIONS[status] || []).map(([s, label, cls]) => `<button class="aact ${cls}" data-st="${s}">${label}</button>`).join('') +
    `<button class="aact edit" data-edit="1">${isAdmin() ? '✎ עריכה' : 'פרטים'}</button>`;
  const meta = [servicesLine(a), a.durationMin ? `${a.durationMin} דק׳` : '', priceLine(a)].filter(Boolean).join(' · ');
  card.innerHTML = `
    <div class="acard-top">
      <div class="time-badge">${esc(a.time)}<small>${esc(a.endTime || '')}</small></div>
      <div class="ainfo">
        <div class="aname">${esc(a.fullName)} ${a.groupSize > 1 ? `<span class="grp">קבוצה ${a.groupSize}</span>` : ''}</div>
        <div class="aphone">${esc(a.phone)} <a class="wa-call" href="${waLink(a.phone, 'שלום, זה יאיר. מספרת DALOR.')}" target="_blank" rel="noreferrer" title="וואטסאפ">${WA_ICON}</a></div>
        ${meta ? `<div class="ameta">${meta}</div>` : ''}
        ${a.notes ? `<div class="anotes">${esc(a.notes)}</div>` : ''}
        <span class="astatus s-${status}">${STATUS_HE[status] || status}</span>
        <span class="bbadge"><i style="background:${bColor(a.barberId)}"></i>${esc(bName(a.barberId))}</span>
        ${a.source === 'admin' ? '<span class="src-badge">✏️ נקבע ידנית</span>' : ''}
      </div>
    </div>
    <div class="acard-actions">${acts}</div>`;
  card.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => setStatus(a.id, b.dataset.st)));
  card.querySelector('[data-edit]').addEventListener('click', () => openEdit(a.id));
  return card;
}
async function setStatus(id, status) {
  if (status === 'cancelled' && !confirm('לבטל את התור?')) return;
  const r = await api('PATCH', `/api/staff/appointments/${encodeURIComponent(id)}`, { status });
  if (!r.ok) { alert(errMsg(r)); return; }
  A.appts = A.appts.map(a => a.id === id ? { ...a, ...r.data } : a);
  if (A.view === 'day') renderAppts(); else loadWeek();
  loadAllStats();
}

// ── ציר זמן (יומי לפי ספר / שבועי) ───────────────────────
const HOUR_H = 52;
function timeline(cols) {
  const all = cols.flatMap(c => c.appts);
  let s = 8 * 60, e = 20 * 60;
  all.forEach(a => { s = Math.min(s, Math.floor(a.startMin / 60) * 60); e = Math.max(e, Math.ceil(a.endMin / 60) * 60); });
  const px = m => (m - s) / 60 * HOUR_H;
  const hours = []; for (let m = s; m < e; m += 60) hours.push(`<div class="tl-h" style="height:${HOUR_H}px">${String(m / 60).padStart(2, '0')}:00</div>`);
  const colsHtml = cols.map(c => {
    const list = c.appts.filter(a => !['cancelled', 'no_show'].includes(a.status)).sort((a, b) => a.startMin - b.startMin);
    const lanes = []; // לכל תור: נתיב, כדי שחפיפות (תצוגה "כל הספרים" בשבוע) לא יסתירו
    list.forEach(a => { let l = 0; while (lanes[l] && lanes[l] > a.startMin) l++; lanes[l] = a.endMin; a._lane = l; });
    const n = Math.max(1, lanes.length);
    const blocks = list.map(a => `<div class="tl-a s-${esc(a.status)}" data-id="${esc(a.id)}" style="top:${px(a.startMin)}px;height:${Math.max(22, px(a.endMin) - px(a.startMin) - 1)}px;width:${100 / n}%;right:${a._lane * 100 / n}%;--c:${bColor(a.barberId)}">
      <b>${esc(a.time)}</b> ${esc(a.fullName)}<br><span>${esc(a.serviceName || '')}</span></div>`).join('');
    return `<div class="tl-col"><div class="tl-hd" ${c.date ? `data-date="${c.date}"` : ''}>${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div><div class="tl-body" style="height:${px(e)}px">${blocks}</div></div>`;
  }).join('');
  return `<div class="tl"><div class="tl-hours"><div class="tl-hd">&nbsp;</div>${hours.join('')}</div><div class="tl-cols">${colsHtml}</div></div>`;
}
function bindTimeline(root) {
  root.querySelectorAll('.tl-a').forEach(b => b.addEventListener('click', () => openEdit(b.dataset.id)));
  root.querySelectorAll('.tl-hd[data-date]').forEach(h => h.addEventListener('click', () => { A.curDate = h.dataset.date; setView('day'); }));
}

// ── שבוע ─────────────────────────────────────────────────
async function loadWeek() {
  const el = document.getElementById('view-week');
  const from = A.weekStart, to = addDays(from, 5);
  el.innerHTML = '<div class="empty-day"><p>טוען…</p></div>';
  const r = await api('GET', `/api/staff/appointments?from=${from}&to=${to}`);
  A.weekAppts = r.ok ? r.data : [];
  const list = visible(A.weekAppts);
  const cols = DAYS_HE.map((d, i) => { const ds = addDays(from, i); const dd = new Date(ds + 'T12:00:00'); return { label: d, sub: `${dd.getDate()}/${dd.getMonth() + 1}`, date: ds, appts: list.filter(a => a.date === ds) }; });
  el.innerHTML = `<div class="wk-nav"><button class="dnav-btn" id="wkPrev">›</button><div class="wk-t">${fmtShort(from).replace(/^יום \S+, /, '')} – ${fmtShort(to).replace(/^יום \S+, /, '')}<br><button class="link" id="wkToday">השבוע הנוכחי</button></div><button class="dnav-btn" id="wkNext">‹</button></div>
    <div class="chips" id="wkChips">${chipsHtml()}</div>${timeline(cols)}`;
  document.getElementById('wkPrev').onclick = () => { A.weekStart = addDays(A.weekStart, -7); loadWeek(); };
  document.getElementById('wkNext').onclick = () => { A.weekStart = addDays(A.weekStart, 7); loadWeek(); };
  document.getElementById('wkToday').onclick = () => { A.weekStart = sundayOf(toISO(new Date())); loadWeek(); };
  bindChips(document.getElementById('wkChips'), loadWeek);
  bindTimeline(el);
}

// ── עריכת תור ────────────────────────────────────────────
function findAppt(id) { return [...(A.appts || []), ...(A.weekAppts || [])].find(a => a.id === id); }
function openEdit(id) {
  const a = findAppt(id); if (!a) return;
  const admin = isAdmin();
  const svc = (A.cfg.services || []).filter(s => s.active || s.id === a.serviceId);
  const adds = (A.cfg.addons || []).filter(s => s.active || (a.addonIds || []).includes(s.id));
  const hasHc = (A.cfg.services || []).find(s => s.id === a.serviceId)?.hasHaircut;
  const body = document.getElementById('editBody');
  body.innerHTML = `
    <div class="ed-top"><b>${esc(a.fullName)}</b> <a class="wa-call" href="${waLink(a.phone)}" target="_blank" rel="noreferrer">${WA_ICON}</a>
      <div class="ameta">${esc(a.phone)} · ${STATUS_HE[a.status] || a.status}${a.groupSize > 1 ? ` · הזמנה קבוצתית (${a.groupSize})` : ''}</div>
      ${a.notes ? `<div class="anotes">${esc(a.notes)}</div>` : ''}</div>
    ${admin ? `
    <div class="field"><label>תאריך</label><input type="date" id="edDate" value="${esc(a.date)}"/></div>
    <div class="field"><label>שעה</label><input type="time" id="edTime" step="300" value="${esc(a.time)}"/></div>
    <div class="field"><label>ספר</label><select id="edBarber">${(A.cfg.barbers || []).map(b => `<option value="${esc(b.id)}" ${b.id === a.barberId ? 'selected' : ''}>${esc(b.name)}${b.active ? '' : ' (לא פעיל)'}</option>`).join('')}</select></div>
    <div class="field"><label>שירות</label><select id="edSvc">${svc.map(s => `<option value="${esc(s.id)}" ${s.id === a.serviceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label>תוספות</label><div class="checks">${adds.map(x => `<label><input type="checkbox" class="edAdd" value="${esc(x.id)}" ${(a.addonIds || []).includes(x.id) ? 'checked' : ''}/> ${esc(x.name)}</label>`).join('')}</div></div>
    ${hasHc ? `<div class="field"><label>סוג תספורת</label><select id="edHc"><option value="regular" ${a.haircutType !== 'special' ? 'selected' : ''}>רגילה</option><option value="special" ${a.haircutType === 'special' ? 'selected' : ''}>מיוחדת / עיצוב מורכב</option></select></div>` : ''}
    <label class="ck"><input type="checkbox" id="edOverride"/> עקוף שעות פעילות/הפסקות (לא מאפשר חפיפה בין תורים)</label>
    <button class="mcta" id="edSave">שמירת שינויים</button>` : `
    <div class="ameta">${esc(a.date)} · ${esc(a.time)}–${esc(a.endTime || '')} · ${servicesLine(a)}</div>`}
    <div class="merr" id="edErr"></div>
    <div class="ed-actions">
      ${(ACTIONS[a.status] || []).map(([s, l, c]) => `<button class="aact ${c}" data-st="${s}">${l}</button>`).join('')}
      ${admin && a.bookingId && a.groupSize > 1 ? '<button class="aact cancel" id="edCancelAll">ביטול כל ההזמנה</button>' : ''}
      ${admin ? '<button class="aact" id="edHist">היסטוריית לקוח</button><button class="aact del" id="edDel">מחיקה</button>' : ''}
    </div>`;
  document.getElementById('editModal').classList.remove('hidden');
  body.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', async () => { await setStatus(a.id, b.dataset.st); closeEdit(); }));
  if (!admin) return;
  document.getElementById('edSave').addEventListener('click', async () => {
    const patch = { override: document.getElementById('edOverride').checked };
    const v = (id) => document.getElementById(id)?.value;
    if (v('edDate') !== a.date) patch.date = v('edDate');
    if (v('edTime') !== a.time) patch.time = v('edTime');
    if (v('edBarber') !== a.barberId) patch.barberId = v('edBarber');
    const addons = [...document.querySelectorAll('.edAdd:checked')].map(x => x.value);
    const hc = v('edHc');
    if (v('edSvc') !== a.serviceId || addons.join() !== [...(a.addonIds || [])].join() || (hc && hc !== (a.haircutType || 'regular'))) {
      patch.serviceId = v('edSvc'); patch.addonIds = addons; if (hc) patch.haircutType = hc;
    }
    if (Object.keys(patch).length === 1) { closeEdit(); return; }
    const r = await api('POST', `/api/staff/appointments/${encodeURIComponent(a.id)}/modify`, patch);
    if (!r.ok) { document.getElementById('edErr').textContent = errMsg(r); return; }
    closeEdit(); A.view === 'week' ? loadWeek() : loadDay(); loadAllStats();
  });
  document.getElementById('edCancelAll')?.addEventListener('click', async () => {
    if (!confirm('לבטל את כל האנשים בהזמנה?')) return;
    const r = await api('POST', `/api/staff/bookings/${encodeURIComponent(a.bookingId)}/cancel`);
    if (!r.ok) { document.getElementById('edErr').textContent = errMsg(r); return; }
    closeEdit(); A.view === 'week' ? loadWeek() : loadDay();
  });
  document.getElementById('edHist').addEventListener('click', () => { closeEdit(); A.custQuery = a.phone; setView('customers'); });
  document.getElementById('edDel').addEventListener('click', async () => {
    if (!confirm('למחוק את התור לצמיתות?')) return;
    const r = await adminFetch(`/api/admin/appointments/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
    if (!r.ok) { document.getElementById('edErr').textContent = 'שגיאה במחיקה'; return; }
    closeEdit(); A.view === 'week' ? loadWeek() : loadDay(); loadAllStats();
  });
}
function closeEdit() { document.getElementById('editModal').classList.add('hidden'); }

// ── הזמנה ידנית ──────────────────────────────────────────
const M = { count: 1, people: [{ serviceId: 'haircut', addonIds: [], haircutType: 'regular' }], slots: [] };
function openModal() { openManual(); }
function openManual() {
  M.count = 1; M.people = [{ serviceId: (A.cfg.services.find(s => s.active) || {}).id, addonIds: [], haircutType: 'regular' }]; M.slots = [];
  document.getElementById('modal').classList.remove('hidden');
  renderManual();
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
function renderManual() {
  const svcs = A.cfg.services.filter(s => s.active), adds = A.cfg.addons.filter(s => s.active);
  const keep = id => document.getElementById(id)?.value ?? '';
  const prev = { date: keep('mDate') || A.curDate, name: keep('mName'), phone: keep('mPhone'), notes: keep('mNotes'), barber: keep('mBarber'), mode: keep('mMode') || 'any' };
  document.getElementById('manualBody').innerHTML = `
    <div class="field"><label>מספר אנשים</label><select id="mCount">${[1, 2, 3, 4].map(n => `<option ${n === M.count ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    ${M.people.map((p, i) => `<div class="pbox"><div class="pbox-h">${M.count > 1 ? `אדם ${i + 1}` : 'שירות'}</div>
      <select data-pi="${i}" data-k="serviceId">${svcs.map(s => `<option value="${esc(s.id)}" ${s.id === p.serviceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <div class="checks">${adds.map(x => `<label><input type="checkbox" data-pi="${i}" data-add="${esc(x.id)}" ${p.addonIds.includes(x.id) ? 'checked' : ''}/> ${esc(x.name)}</label>`).join('')}</div>
      ${svcs.find(s => s.id === p.serviceId)?.hasHaircut ? `<select data-pi="${i}" data-k="haircutType"><option value="regular" ${p.haircutType !== 'special' ? 'selected' : ''}>תספורת רגילה</option><option value="special" ${p.haircutType === 'special' ? 'selected' : ''}>תספורת מיוחדת / עיצוב מורכב</option></select>` : ''}
    </div>`).join('')}
    ${M.count > 1 ? `<div class="field"><label>סוג שיבוץ</label><select id="mMode"><option value="any">לא משנה — הכי קרוב</option><option value="sequential">ברצף</option><option value="parallel">במקביל</option></select></div>` : ''}
    ${M.count === 1 ? `<div class="field"><label>ספר</label><select id="mBarber"><option value="">אוטומטי</option>${A.cfg.barbers.filter(b => b.active).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>תאריך</label><input type="date" id="mDate" value="${esc(prev.date)}"/></div>
    <label class="ck"><input type="checkbox" id="mOverride"/> שעה חופשית (עקיפת שעות פעילות)</label>
    <div class="field" id="mTimeWrap"><label>שעה</label><select id="mTime"><option value="">טוען…</option></select></div>
    <div class="field"><label>שם מלא *</label><input id="mName" value="${esc(prev.name)}" autocomplete="off"/></div>
    <div class="field"><label>טלפון *</label><input id="mPhone" inputmode="tel" value="${esc(prev.phone)}"/></div>
    <div class="field"><label>הערות</label><textarea id="mNotes">${esc(prev.notes)}</textarea></div>
    <label class="ck"><input type="checkbox" id="mConsent"/> הלקוח אישר לקבל תזכורות בוואטסאפ</label>
    <div class="merr" id="mErr"></div>
    <button class="mcta" id="mSave">שמירת התור</button>`;
  if (document.getElementById('mMode')) document.getElementById('mMode').value = prev.mode;
  if (document.getElementById('mBarber')) document.getElementById('mBarber').value = prev.barber;
  document.getElementById('mCount').onchange = e => {
    M.count = +e.target.value;
    M.people = Array.from({ length: M.count }, (_, i) => M.people[i] || { serviceId: M.people[0].serviceId, addonIds: [], haircutType: 'regular' });
    renderManual();
  };
  document.querySelectorAll('#manualBody [data-k]').forEach(el => el.addEventListener('change', () => { M.people[+el.dataset.pi][el.dataset.k] = el.value; renderManual(); }));
  document.querySelectorAll('#manualBody [data-add]').forEach(el => el.addEventListener('change', () => {
    const p = M.people[+el.dataset.pi]; p.addonIds = el.checked ? [...p.addonIds, el.dataset.add] : p.addonIds.filter(x => x !== el.dataset.add); loadManualSlots();
  }));
  ['mDate', 'mMode', 'mBarber'].forEach(id => document.getElementById(id)?.addEventListener('change', loadManualSlots));
  document.getElementById('mOverride').addEventListener('change', () => {
    const o = document.getElementById('mOverride').checked;
    document.getElementById('mTimeWrap').innerHTML = o ? '<label>שעה</label><input type="time" id="mTime" step="300"/>' : '<label>שעה</label><select id="mTime"></select>';
    if (!o) loadManualSlots();
  });
  document.getElementById('mSave').addEventListener('click', saveManual);
  loadManualSlots();
}
const manualPeople = () => M.people.map(p => ({ serviceId: p.serviceId, addonIds: p.addonIds, haircutType: p.haircutType }));
async function loadManualSlots() {
  const sel = document.getElementById('mTime');
  if (!sel || sel.tagName !== 'SELECT') return;
  const date = document.getElementById('mDate').value;
  if (!date) { sel.innerHTML = '<option value="">בחרו תאריך</option>'; return; }
  const r = await api('POST', '/api/staff/availability', { date, people: manualPeople(), mode: document.getElementById('mMode')?.value || 'any', barberId: document.getElementById('mBarber')?.value || undefined });
  if (!r.ok) { sel.innerHTML = `<option value="">${esc(errMsg(r))}</option>`; return; }
  if (!r.data.open) { sel.innerHTML = '<option value="">המספרה סגורה — סמנו "שעה חופשית" כדי לעקוף</option>'; return; }
  sel.innerHTML = r.data.slots.length ? '<option value="">בחרו שעה…</option>' + r.data.slots.map(s => `<option value="${s.time}">${s.time} – ${s.endTime}${s.mode === 'parallel' ? ' (במקביל)' : s.mode === 'sequential' ? ' (ברצף)' : ''}</option>`).join('') : '<option value="">אין שעות פנויות</option>';
}
async function saveManual() {
  const err = document.getElementById('mErr'); err.textContent = '';
  const v = id => document.getElementById(id)?.value?.trim() ?? '';
  const body = {
    customer: { fullName: v('mName'), phone: v('mPhone'), notes: v('mNotes'), whatsappConsent: document.getElementById('mConsent').checked },
    people: manualPeople(), mode: v('mMode') || 'any', date: v('mDate'), time: v('mTime'), barberId: v('mBarber') || undefined, override: document.getElementById('mOverride').checked,
  };
  if (!body.date || !body.time) { err.textContent = 'נא לבחור תאריך ושעה'; return; }
  if (!body.customer.fullName || !body.customer.phone) { err.textContent = 'נא להזין שם וטלפון'; return; }
  const btn = document.getElementById('mSave'); btn.disabled = true;
  const r = await api('POST', '/api/staff/bookings', body);
  btn.disabled = false;
  if (!r.ok) { err.textContent = errMsg(r); if (r.status === 409) loadManualSlots(); return; }
  closeModal(); A.curDate = body.date; setView('day'); loadAllStats();
}

// ── לקוחות ───────────────────────────────────────────────
function renderCustomers() {
  const el = document.getElementById('view-customers');
  el.innerHTML = `<div class="field"><input id="cq" placeholder="חיפוש לפי שם או טלפון…" value="${esc(A.custQuery || '')}"/></div><div id="cres"></div>`;
  let t; const run = () => { clearTimeout(t); t = setTimeout(searchCustomers, 250); };
  document.getElementById('cq').addEventListener('input', e => { A.custQuery = e.target.value; run(); });
  if (A.custQuery) searchCustomers();
}
async function searchCustomers() {
  const q = (A.custQuery || '').trim(), out = document.getElementById('cres');
  if (q.length < 2) { out.innerHTML = '<div class="empty-day"><p>הקלידו לפחות 2 תווים</p></div>'; return; }
  const r = await api('GET', `/api/staff/customers?q=${encodeURIComponent(q)}`);
  if (!r.ok) { out.innerHTML = `<div class="merr">${esc(errMsg(r))}</div>`; return; }
  out.innerHTML = r.data.length ? r.data.map(c => `<button class="crow" data-ph="${esc(c.phone)}"><b>${esc(c.fullName)}</b><span>${esc(c.phone)}</span><small>${c.visits} ביקורים · אחרון ${esc(c.lastDate || '—')}${c.noShows ? ` · ${c.noShows} אי-הגעה` : ''}</small></button>`).join('') : '<div class="empty-day"><p>לא נמצאו לקוחות</p></div>';
  out.querySelectorAll('[data-ph]').forEach(b => b.addEventListener('click', () => showHistory(b.dataset.ph)));
  if (/^[\d\-\s+]{7,}$/.test(q) && r.data.length === 1) showHistory(r.data[0].phone);
}
async function showHistory(phone) {
  const r = await api('GET', `/api/staff/customers/${encodeURIComponent(phone)}/history`);
  if (!r.ok) { alert(errMsg(r)); return; }
  const c = r.data.customer;
  document.getElementById('editBody').innerHTML = `<div class="ed-top"><b>${esc(phone)}</b> <a class="wa-call" href="${waLink(phone)}" target="_blank" rel="noreferrer">${WA_ICON}</a>
    ${c ? `<div class="ameta">${esc(c.fullName)} · הסכמה לתזכורות וואטסאפ: ${c.whatsappReminders ? 'כן (' + esc((c.whatsappConsentAt || '').slice(0, 10)) + ')' : 'לא'}</div>` : ''}</div>
    ${r.data.appointments.map(a => `<div class="hrow"><span>${esc(a.date)} ${esc(a.time)}</span><span>${servicesLine(a) || '—'}</span><span class="astatus s-${esc(a.status)}">${STATUS_HE[a.status] || esc(a.status)}</span><small>${esc(bName(a.barberId))}${priceLine(a) ? ' · ' + priceLine(a) : ''}</small></div>`).join('') || '<div class="empty-day"><p>אין היסטוריה</p></div>'}`;
  document.getElementById('editModal').classList.remove('hidden');
}

// ── הודעות ללקוחות ───────────────────────────────────────
async function loadOutbox() {
  const el = document.getElementById('view-outbox');
  el.innerHTML = '<div class="empty-day"><p>טוען…</p></div>';
  const r = await api('GET', '/api/staff/outbox');
  if (!r.ok) { el.innerHTML = `<div class="merr">${esc(errMsg(r))}</div>`; return; }
  const { providerConfigured, items } = r.data;
  el.innerHTML = `<div class="note-box">${providerConfigured ? 'ספק וואטסאפ מחובר — הודעות נשלחות אוטומטית. כאן רואים הודעות שממתינות או נכשלו.' : 'ספק וואטסאפ עדיין לא מחובר. ההודעות שהגיע זמנן מופיעות כאן — לחצו "שלח" ואז "סמן כנשלח". נשלחות רק ללקוחות שאישרו.'}</div>` +
    (items.length ? items.map(o => `<div class="orow"><div><b>${esc(o.kind === 'confirm' ? 'אישור' : o.kind === 'rem24' ? 'תזכורת 24ש׳' : o.kind === 'rem2h' ? 'תזכורת שעתיים' : o.kind === 'change' ? 'שינוי' : 'ביטול')}</b> · ${esc(o.phone)}<div class="ameta">${esc(o.text)}</div></div>
      <div class="oa"><a class="rwa-btn" href="https://wa.me/${esc(o.to)}?text=${encodeURIComponent(o.text)}" target="_blank" rel="noreferrer">שלח</a><button class="aact" data-sent="${esc(o.id)}">סמן כנשלח</button></div></div>`).join('') : '<div class="empty-day"><p>אין הודעות ממתינות</p></div>');
  el.querySelectorAll('[data-sent]').forEach(b => b.addEventListener('click', async () => { await api('POST', `/api/staff/outbox/${encodeURIComponent(b.dataset.sent)}/mark-sent`, {}); loadOutbox(); }));
}

// ── הגדרות ───────────────────────────────────────────────
async function loadSettings() {
  const r = await api('GET', '/api/staff/config');
  if (!r.ok) { document.getElementById('view-settings').innerHTML = `<div class="merr">${esc(errMsg(r))}</div>`; return; }
  A.edit = JSON.parse(JSON.stringify(r.data)); A.cfg = r.data;
  renderSettings();
}
const input = (label, path, type, val, extra = '') => `<div class="field"><label>${label}</label><input data-p="${path}" data-t="${type}" value="${esc(val ?? '')}" ${type === 'time' || type === 'date' ? `type="${type}"` : type.startsWith('num') ? 'inputmode="decimal"' : ''} ${extra}/></div>`;
const check = (label, path, val) => `<label class="ck"><input type="checkbox" data-p="${path}" data-t="bool" ${val ? 'checked' : ''}/> ${label}</label>`;
function renderSettings() {
  const el = document.getElementById('view-settings'), E = A.edit;
  const tabs = [['general', 'כללי'], ['services', 'שירותים'], ['addons', 'תוספות'], ['barbers', 'ספרים']];
  let body = '';
  if (A.setTab === 'general') {
    const s = E.settings;
    body = `<div class="grid2">${input('קפיצת שעות (דק׳)', 'settings.slotStepMin', 'num', s.slotStepMin)}${input('ימים קדימה', 'settings.maxDaysAhead', 'num', s.maxDaysAhead)}
      ${input('הזמנה מראש (דק׳ לפחות)', 'settings.minLeadMin', 'num', s.minLeadMin)}${input('מרווח בין טיפולים (דק׳)', 'settings.bufferMin', 'num', s.bufferMin)}
      ${input('ביטול עצמי (שעות לפני)', 'settings.cancelBeforeHours', 'num', s.cancelBeforeHours)}${input('מקסימום אנשים להזמנה', 'settings.maxPeople', 'num', s.maxPeople)}
      ${input('זמן נוסף לתספורת מיוחדת (דק׳)', 'settings.specialHaircutExtraMin', 'num', s.specialHaircutExtraMin)}${input('מחיר תספורת מיוחדת (ריק = יתואם)', 'settings.specialHaircutExtraPrice', 'numnull', s.specialHaircutExtraPrice)}
      ${input('סגירה בערב חג', 'settings.eveHolidayClose', 'time', s.eveHolidayClose)}</div>
      ${check('אישור אוטומטי להזמנות (אם כבוי — נכנסות כ"ממתין לאישור")', 'settings.autoConfirm', s.autoConfirm)}
      <div class="field"><label>מדיניות שינוי וביטול (ריק = טקסט אוטומטי)</label><textarea data-p="settings.policyText" data-t="str" placeholder="${esc(E.policyText || '')}">${esc(s.policyText || '')}</textarea></div>
      <h4>שעות פעילות</h4>${DAYS_HE.map((d, i) => `<div class="hrs"><b>${d}</b>${input('פתיחה', `settings.businessHours.${i}.open`, 'time', s.businessHours[i]?.open)}${i === 5 ? input('סגירה (קיץ)', 'settings.businessHours.5.closeSummer', 'time', s.businessHours[5]?.closeSummer) + input('סגירה (חורף)', 'settings.businessHours.5.closeWinter', 'time', s.businessHours[5]?.closeWinter) : input('סגירה', `settings.businessHours.${i}.close`, 'time', s.businessHours[i]?.close)}</div>`).join('')}
      <h4>הפסקות כלליות (לכל הספרים)</h4>${(s.breaks || []).map((b, i) => `<div class="hrs">${input('מ-', `settings.breaks.${i}.start`, 'time', b.start)}${input('עד', `settings.breaks.${i}.end`, 'time', b.end)}${input('שם', `settings.breaks.${i}.label`, 'str', b.label)}<button class="aact del" data-rm="settings.breaks.${i}">הסר</button></div>`).join('')}
      <button class="aact" data-add="settings.breaks">+ הוספת הפסקה</button>`;
  } else if (A.setTab === 'services' || A.setTab === 'addons') {
    const key = A.setTab, isSvc = key === 'services';
    body = E[key].map((x, i) => `<div class="scard ${x.active ? '' : 'off'}"><div class="scard-h"><b>${esc(x.name)}</b>${x.durationConfirmed === false ? '<span class="warn">⚠ משך לא אושר</span>' : ''}${x.price == null ? '<span class="warn">מחיר לא מאושר — לא מוצג ללקוח</span>' : ''}</div>
      <div class="grid2">${input('שם', `${key}.${i}.name`, 'str', x.name)}${input('מחיר ₪ (ריק = יתואם)', `${key}.${i}.price`, 'numnull', x.price)}${input('משך (דק׳)', `${key}.${i}.durationMin`, 'numdur', x.durationMin)}${input('סדר', `${key}.${i}.sortOrder`, 'num', x.sortOrder)}</div>
      ${check('פעיל', `${key}.${i}.active`, x.active)}
      ${isSvc ? `${check('כולל תספורת (שואל סוג תספורת)', `${key}.${i}.hasHaircut`, x.hasHaircut)}${check('מאפשר תוספות', `${key}.${i}.allowsAddons`, x.allowsAddons)}${check('מחייב זמן נוסף', `${key}.${i}.requiresExtraTime`, x.requiresExtraTime)}${x.requiresExtraTime ? input('זמן נוסף (דק׳)', `${key}.${i}.extraTimeMin`, 'num', x.extraTimeMin) : ''}
      <div class="field"><label>סוג</label><select data-p="${key}.${i}.type" data-t="str">${[['haircut', 'תספורת'], ['beard', 'זקן'], ['combo', 'משולב'], ['other', 'אחר']].map(([v, l]) => `<option value="${v}" ${x.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      <div class="ameta">מזהה: ${esc(x.id)}</div></div>`).join('') + `<button class="aact" data-add="${key}">+ ${isSvc ? 'שירות חדש' : 'תוספת חדשה'}</button>`;
  } else {
    body = E.barbers.map((b, i) => {
      const custom = b.weeklyHours !== null;
      const unset = custom && !Object.values(b.weeklyHours || {}).some(r => r && r.length && r[0][0]);
      return `<div class="scard ${b.active ? '' : 'off'}"><div class="scard-h"><b>${esc(b.name)}</b>${unset ? '<span class="warn">⚠ לא הוגדרו שעות עבודה — לא יקבל תורים</span>' : ''}${b.hasKey ? '<span class="ok">יש קוד כניסה</span>' : ''}</div>
      ${input('שם', `barbers.${i}.name`, 'str', b.name)}${check('פעיל', `barbers.${i}.active`, b.active)}
      <div class="field"><label>הרשאה</label><select data-p="barbers.${i}.role" data-t="str"><option value="barber" ${b.role !== 'admin' ? 'selected' : ''}>ספר — רואה ומטפל רק בתורים שלו</option><option value="admin" ${b.role === 'admin' ? 'selected' : ''}>מנהל — גישה מלאה</option></select></div>
      <label class="ck"><input type="checkbox" data-mode="${i}" ${custom ? '' : 'checked'}/> עובד בכל שעות הפעילות של העסק</label>
      ${custom ? DAYS_HE.map((d, di) => { const rg = (b.weeklyHours[di] || [])[0] || ['', '']; return `<div class="hrs"><b>${d}</b>${input('מ-', `barbers.${i}.weeklyHours.${di}.0.0`, 'time', rg[0])}${input('עד', `barbers.${i}.weeklyHours.${di}.0.1`, 'time', rg[1])}</div>`; }).join('') : ''}
      <h4>הפסקות קבועות</h4>${(b.breaks || []).map((x, bi) => `<div class="hrs">${input('מ-', `barbers.${i}.breaks.${bi}.start`, 'time', x.start)}${input('עד', `barbers.${i}.breaks.${bi}.end`, 'time', x.end)}${input('שם', `barbers.${i}.breaks.${bi}.label`, 'str', x.label)}<button class="aact del" data-rm="barbers.${i}.breaks.${bi}">הסר</button></div>`).join('')}<button class="aact" data-add="barbers.${i}.breaks">+ הפסקה</button>
      <h4>חופשות</h4>${(b.vacations || []).map((x, vi) => `<div class="hrs">${input('מתאריך', `barbers.${i}.vacations.${vi}.from`, 'date', x.from)}${input('עד', `barbers.${i}.vacations.${vi}.to`, 'date', x.to)}${input('הערה', `barbers.${i}.vacations.${vi}.note`, 'str', x.note)}<button class="aact del" data-rm="barbers.${i}.vacations.${vi}">הסר</button></div>`).join('')}<button class="aact" data-add="barbers.${i}.vacations">+ חופשה</button>
      <h4>חסימת שעות</h4>${(b.blocks || []).map((x, bi) => `<div class="hrs">${input('תאריך', `barbers.${i}.blocks.${bi}.date`, 'date', x.date)}${input('מ-', `barbers.${i}.blocks.${bi}.start`, 'time', x.start)}${input('עד', `barbers.${i}.blocks.${bi}.end`, 'time', x.end)}<button class="aact del" data-rm="barbers.${i}.blocks.${bi}">הסר</button></div>`).join('')}<button class="aact" data-add="barbers.${i}.blocks">+ חסימה</button>
      <h4>שירותים שהספר מוסמך לבצע</h4>
      <label class="ck"><input type="checkbox" data-skills-all="${i}" ${b.skills === null ? 'checked' : ''}/> כל השירותים והתוספות</label>
      ${b.skills !== null ? `<div class="checks">${[...E.services, ...E.addons].map(s => `<label><input type="checkbox" data-skill="${i}" value="${esc(s.id)}" ${b.skills.includes(s.id) ? 'checked' : ''}/> ${esc(s.name)}</label>`).join('')}</div>` : ''}
      <h4>קוד כניסה אישי לספר</h4>${input('קוד חדש (לפחות 6 תווים; ריק = ללא שינוי)', `barbers.${i}.newKey`, 'str', '', 'autocomplete="off"')}${b.hasKey ? check('מחיקת הקוד הקיים', `barbers.${i}.clearKey`, false) : ''}
      </div>`;
    }).join('');
  }
  el.innerHTML = `<div class="seg">${tabs.map(([k, l]) => `<button data-stab="${k}" class="${A.setTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body}
    <div class="merr" id="setErr"></div><button class="mcta" id="setSave">שמירה</button>`;
  el.querySelectorAll('[data-stab]').forEach(b => b.addEventListener('click', () => { A.setTab = b.dataset.stab; renderSettings(); }));
  el.querySelector('#setSave').addEventListener('click', saveSettings);
}
// עדכון state מתוך שדות (האצלה): נתיב כמו services.2.price
function setPath(obj, path, val) { const p = path.split('.'); let o = obj; for (let i = 0; i < p.length - 1; i++) { if (o[p[i]] == null) o[p[i]] = /^\d+$/.test(p[i + 1]) ? [] : {}; o = o[p[i]]; } o[p[p.length - 1]] = val; }
function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
const settingsEl = document.getElementById('view-settings');
settingsEl.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.p) {
    const ty = t.dataset.t; let v = t.type === 'checkbox' ? t.checked : t.value;
    if (ty === 'num') v = v === '' ? 0 : Number(v);
    if (ty === 'numnull') v = v === '' ? null : Number(v);
    if (ty === 'numdur') { v = Number(v); setPath(A.edit, t.dataset.p.replace(/durationMin$/, 'durationConfirmed'), true); }
    setPath(A.edit, t.dataset.p, v);
    if (/requiresExtraTime$|\.active$/.test(t.dataset.p)) renderSettings();
  }
  if (t.dataset.mode !== undefined) { const b = A.edit.barbers[+t.dataset.mode]; b.weeklyHours = t.checked ? null : (b.weeklyHours || {}); renderSettings(); }
  if (t.dataset.skillsAll !== undefined) { const b = A.edit.barbers[+t.dataset.skillsAll]; b.skills = t.checked ? null : [...A.edit.services, ...A.edit.addons].map(s => s.id); renderSettings(); }
  if (t.dataset.skill !== undefined) { const b = A.edit.barbers[+t.dataset.skill]; b.skills = t.checked ? [...new Set([...b.skills, t.value])] : b.skills.filter(x => x !== t.value); }
});
settingsEl.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.rm) { const m = t.dataset.rm.match(/^(.*)\.(\d+)$/); getPath(A.edit, m[1]).splice(+m[2], 1); renderSettings(); }
  if (t.dataset.add) {
    const p = t.dataset.add, tmpl = { 'settings.breaks': { days: [0, 1, 2, 3, 4, 5], start: '13:00', end: '13:30', label: '' }, services: { id: 's_' + Math.random().toString(36).slice(2, 7), name: 'שירות חדש', price: null, durationMin: 20, durationConfirmed: true, type: 'other', hasHaircut: false, allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 99 }, addons: { id: 'a_' + Math.random().toString(36).slice(2, 7), name: 'תוספת חדשה', price: null, durationMin: 10, durationConfirmed: true, active: true, sortOrder: 99 } };
    let item = tmpl[p];
    if (!item) item = p.endsWith('.breaks') ? { days: [0, 1, 2, 3, 4, 5], start: '13:00', end: '13:30', label: '' } : p.endsWith('.vacations') ? { from: toISO(new Date()), to: toISO(new Date()), note: '' } : { date: toISO(new Date()), start: '09:00', end: '10:00', note: '' };
    getPath(A.edit, p).push(item); renderSettings();
  }
});
async function saveSettings() {
  const err = document.getElementById('setErr'); err.textContent = '';
  const section = A.setTab === 'general' ? 'settings' : A.setTab;
  let value = JSON.parse(JSON.stringify(A.edit[section]));
  if (section === 'barbers') value = value.map(b => {
    if (b.weeklyHours) for (let d = 0; d <= 5; d++) { const r = (b.weeklyHours[d] || [])[0]; b.weeklyHours[d] = r && r[0] && r[1] ? [[r[0], r[1]]] : []; }
    delete b.hasKey; if (!b.newKey) delete b.newKey; return b;
  });
  if (section === 'settings') { const bh = value.businessHours; for (let d = 0; d <= 5; d++) if (!bh[d]?.open) bh[d] = null; }
  const r = await api('PUT', `/api/staff/config/${section}`, { value });
  if (!r.ok) { err.textContent = errMsg(r); return; }
  err.style.color = 'var(--green)'; err.textContent = 'נשמר ✓';
  await loadSettings();
  document.getElementById('setErr').style.color = 'var(--green)'; document.getElementById('setErr').textContent = 'נשמר ✓';
}

// ── אתחול ────────────────────────────────────────────────
document.getElementById('closeedit').addEventListener('click', closeEdit);
document.getElementById('editModal').addEventListener('click', e => { if (e.target.id === 'editModal') closeEdit(); });
document.getElementById('closemodal').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

const _saved = localStorage.getItem(ADMIN_KEY_LS);
if (_saved) {
  fetch('/api/staff/me', { headers: { 'x-admin-key': _saved } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(me => { A.key = _saved; A.role = me.role; A.barberId = me.barberId || null; showAdmin(); })
    .catch(() => localStorage.removeItem(ADMIN_KEY_LS));
}
