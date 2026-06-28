self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(d.title || 'DALOR מספרה', {
      body: d.body || '',
      icon: '/logo.jpg',
      badge: '/logo.jpg',
      tag: d.tag || 'dalor',
      data: { url: d.url || '/admin.html' },
      requireInteraction: true,
      dir: 'rtl',
      lang: 'he',
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('/admin') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/admin.html');
    })
  );
});
