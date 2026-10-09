// Presentation and keyboard support only; admin-v2.js owns data and business actions.
(() => {
  const viewCopy = {
    day: ['יומן המספרה', 'כל התורים במקום אחד'],
    week: ['יומן שבועי', 'כל התורים לפי ימים'],
    customers: ['לקוחות', 'חיפוש והיסטוריית ביקורים'],
    outbox: ['הודעות ותזכורות', 'אישורים ותזכורות לתורים'],
    settings: ['הגדרות המספרה', 'שירותים, שעות פעילות וצוות'],
  };
  const dialogClosers = { modal: () => closeModal(), editModal: () => closeEdit(), statusModal: () => closeStatusModal(), weekModal: () => closeWeekModal() };
  let activeDialog = null, returnFocus = null, generatedId = 0;
  const setText = (id, text) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
  const focusables = root => [...root.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(e => !e.disabled && !e.closest('.hidden') && e.getClientRects().length);
  function sync() {
    const current = document.querySelector('#tabs button.on');
    const copy = viewCopy[current?.dataset.view];
    if (copy) { setText('adminViewTitle', copy[0]); setText('adminViewDescription', copy[1]); }
    document.querySelectorAll('#tabs button').forEach(b => {
      if (b.classList.contains('on')) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.chip, .seg button, .sm-opt').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on') || b.classList.contains('sel') || b.classList.contains('selected') || b.classList.contains('sm-sel') || b.classList.contains('sm-open-sel'))));
    document.querySelectorAll('.field').forEach(field => {
      const label = field.querySelector('label'), input = field.querySelector('input,select,textarea');
      if (label && input) { if (!input.id) input.id = 'admin-ui-field-' + (++generatedId); label.htmlFor = input.id; }
    });
    const labels = {cq:'חיפוש לקוח לפי שם או טלפון',smNote:'הודעה ללקוחות',smCloseAt:'שעת סגירה',wkPrev:'שבוע קודם',wkNext:'שבוע הבא'};
    for (const [id,label] of Object.entries(labels)) document.getElementById(id)?.setAttribute('aria-label',label);
    document.querySelectorAll('#manualBody select[data-k]').forEach(e => e.setAttribute('aria-label', (e.dataset.k === 'serviceId' ? 'שירות' : 'סוג תספורת') + ' ללקוח ' + (Number(e.dataset.pi) + 1)));
    document.querySelectorAll('.merr').forEach(e => e.setAttribute('role','alert'));
    document.querySelectorAll('.empty-day .em-ico').forEach(e => {
      if (e.dataset.dalorIcon) return;
      e.dataset.dalorIcon = 'true'; e.setAttribute('aria-hidden','true');
      e.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M9 16h6"/></svg>';
    });
    document.querySelectorAll('.stat.clickable,.tl-a,.tl-hd[data-date]').forEach(e => {
      e.setAttribute('role','button'); e.tabIndex = 0;
      if (e.classList.contains('tl-a')) e.setAttribute('aria-label','פרטי תור: ' + e.textContent.trim());
    });
    const dialogs = Object.keys(dialogClosers).map(id => document.getElementById(id)).filter(e => !e.classList.contains('hidden'));
    const top = dialogs.at(-1) || null;
    document.getElementById('adminApp').inert = !!top;
    for (const id of Object.keys(dialogClosers)) {
      const el = document.getElementById(id);
      el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
      const heading = el.querySelector('h3,.sm-title,.wm-title');
      if (heading) { if (!heading.id) heading.id = id + '-title'; el.setAttribute('aria-labelledby',heading.id); }
      el.inert = !!top && el !== top;
    }
    if (top !== activeDialog) {
      if (top) {
        if (!activeDialog) returnFocus = document.activeElement;
        activeDialog = top; document.body.style.overflow = 'hidden';
        (focusables(top)[0] || top).focus({preventScroll:true});
      } else {
        activeDialog = null; document.body.style.overflow = '';
        if (returnFocus?.isConnected && !returnFocus.closest('.hidden')) returnFocus.focus({preventScroll:true});
        returnFocus = null;
      }
    }
  }
  document.addEventListener('keydown', e => {
    if (activeDialog) {
      if (e.key === 'Escape') { e.preventDefault(); dialogClosers[activeDialog.id](); return; }
      if (e.key === 'Tab') {
        const items = focusables(activeDialog), first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || !activeDialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !activeDialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.stat.clickable,.tl-a,.tl-hd[data-date]')) { e.preventDefault(); e.target.click(); }
  });
  new MutationObserver(sync).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  sync();
})();
