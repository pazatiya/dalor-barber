// שרת פיתוח מקומי עם מסד נתונים בזיכרון (בלי Firebase) ונתוני דמו.
// הרצה: npm run dev:memory   →  http://localhost:3021  |  admin: מפתח dev-admin
process.env.USE_MEMORY_DB = '1';
process.env.PORT = process.env.PORT || '3021';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin';
process.env.DISABLE_INTERNAL_CRON = 'true';
const { start, bookingSvc } = require('../server');

(async () => {
  const hours = { 0: [['08:00', '20:00']], 1: [['09:00', '19:00']], 2: [['08:00', '20:00']], 3: [['08:00', '20:00']], 4: [['10:00', '20:00']], 5: [['08:00', '14:00']] };
  const cfg = await bookingSvc.loadConfig();
  await bookingSvc.updateConfigSection('barbers', cfg.barbers.map(b => b.id === 'yair' ? b : {
    ...b, weeklyHours: hours, breaks: b.id === 'nehorai' ? [{ days: [0, 1, 2, 3, 4], start: '13:00', end: '14:00', label: 'ארוחת צהריים' }] : [],
    ...(b.id === 'nehorai' ? { newKey: 'dev-nehorai' } : {}),
  }));
  start();
  console.log('DEV: admin key = dev-admin | barber (נהוראי) key = dev-nehorai');
})();
