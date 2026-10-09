// ברירות מחדל להגדרות מערכת ההזמנות. הכול ניתן לעריכה בממשק הניהול ונשמר ב-Firestore.
// ערכים שסומנו durationConfirmed:false הם הערכת פיתוח בלבד — יאיר צריך לאשר.
'use strict';

const DEFAULT_SETTINGS = {
  slotStepMin: 10,          // קפיצות בין שעות התחלה שמוצגות ללקוח
  maxDaysAhead: 30,         // כמה ימים קדימה אפשר להזמין
  minLeadMin: 30,           // הזמנה לפחות X דקות מראש
  bufferMin: 5,             // מרווח בין טיפולים
  cancelBeforeHours: 3,     // ביטול עצמי עד X שעות לפני התור
  maxPeople: 4,
  autoConfirm: true,        // false => הזמנות חדשות נכנסות כ"ממתין לאישור"
  specialHaircutExtraMin: 20,
  specialHaircutExtraPrice: null, // null = מחיר יתואם (לא מוצג ללקוח)
  eveHolidayClose: '14:00',
  // שעות פעילות העסק לפי יום בשבוע (0=ראשון … 6=שבת). null = סגור.
  businessHours: {
    0: { open: '08:00', close: '20:00' },
    1: { open: '08:00', close: '20:00' },
    2: { open: '08:00', close: '20:00' },
    3: { open: '08:00', close: '20:00' },
    4: { open: '08:00', close: '20:00' },
    5: { open: '08:00', closeSummer: '15:30', closeWinter: '14:00' },
    6: null,
  },
  // הפסקות כלליות לכל הספרים: { days:[0..6], start:'HH:MM', end:'HH:MM', label }
  breaks: [],
  shopPhoneWa: '972507983306',
  policyText: '',           // ריק => נבנה אוטומטית מ-cancelBeforeHours
};

const DEFAULT_SERVICES = [
  { id: 'haircut',        name: 'תספורת',        price: 50,   durationMin: 20, durationConfirmed: true,  type: 'haircut', hasHaircut: true,  allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 1 },
  { id: 'kids_haircut',   name: 'תספורת ילדים',  price: 50,   durationMin: 20, durationConfirmed: true,  type: 'haircut', hasHaircut: true,  allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 2 },
  { id: 'beard',          name: 'סידור זקן',     price: null, durationMin: 15, durationConfirmed: false, type: 'beard',   hasHaircut: false, allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 3 },
  { id: 'haircut_beard',  name: 'תספורת + זקן',  price: 70,   durationMin: 35, durationConfirmed: false, type: 'combo',   hasHaircut: true,  allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 4 },
  { id: 'other',          name: 'שירות אחר',     price: null, durationMin: 30, durationConfirmed: false, type: 'other',   hasHaircut: false, allowsAddons: true, requiresExtraTime: false, extraTimeMin: 0, active: true, sortOrder: 5 },
];

const DEFAULT_ADDONS = [
  { id: 'wax',     name: 'שעווה לאף / אוזניים', price: null, durationMin: 10, durationConfirmed: false, active: true, sortOrder: 1 },
  { id: 'brows',   name: 'סידור גבות',          price: null, durationMin: 10, durationConfirmed: false, active: true, sortOrder: 2 },
  { id: 'lines',   name: 'עיצוב קווים',         price: null, durationMin: 10, durationConfirmed: false, active: true, sortOrder: 3 },
  { id: 'wash',    name: 'חפיפה',               price: null, durationMin: 10, durationConfirmed: false, active: true, sortOrder: 4 },
  { id: 'styling', name: 'עיצוב וסידור שיער',   price: null, durationMin: 10, durationConfirmed: false, active: true, sortOrder: 5 },
];

// ספרים. weeklyHours=null => עובד בכל שעות הפעילות של העסק.
// weeklyHours={} => עדיין לא הוגדרו שעות — לא ישובץ לאף תור עד שיוגדר.
// skills=null => מוסמך לכל השירותים והתוספות; אחרת רשימת מזהים.
const DEFAULT_BARBERS = [
  { id: 'yair',    name: 'יאיר',   role: 'admin',  active: true, sortOrder: 1, weeklyHours: null, breaks: [], vacations: [], blocks: [], skills: null, keyHash: null },
  { id: 'nehorai', name: 'נהוראי', role: 'barber', active: true, sortOrder: 2, weeklyHours: {},   breaks: [], vacations: [], blocks: [], skills: null, keyHash: null },
  { id: 'yosef',   name: 'יוסף',   role: 'barber', active: true, sortOrder: 3, weeklyHours: {},   breaks: [], vacations: [], blocks: [], skills: null, keyHash: null },
];

const LEGACY_SLOT_MIN = 20;       // משך תור ישן (לפני השדרוג)
const LEGACY_BARBER_ID = 'yair';  // תור ישן בלי ספר משויך

module.exports = { DEFAULT_SETTINGS, DEFAULT_SERVICES, DEFAULT_ADDONS, DEFAULT_BARBERS, LEGACY_SLOT_MIN, LEGACY_BARBER_ID };
