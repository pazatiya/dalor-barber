// שכבת זיכרון תואמת-Firestore (תת-קבוצה) — לבדיקות ולפיתוח מקומי בלבד.
// ב-production משתמשים ב-Firestore האמיתי. טרנזקציות כאן מסודרות בתור (סריאליות),
// כך שמדמות את ההתנהגות של Firestore: שתי כתיבות לאותו מסמך-נעילה לא רצות יחד.
'use strict';

const clone = v => (v === undefined ? undefined : structuredClone(v));

class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) {
    const res = this.tail.then(fn, fn);
    this.tail = res.then(() => {}, () => {});
    return res;
  }
}

class MemoryFirestore {
  constructor() {
    this.cols = new Map(); // name -> Map(id -> data)
    this.mutex = new Mutex();
  }
  _col(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }
  collection(name) { return new CollectionRef(this, name); }

  async runTransaction(fn, { maxAttempts = 1 } = {}) {
    return this.mutex.run(async () => {
      const tx = new Transaction(this);
      const out = await fn(tx);
      tx._commit();
      return out;
    });
  }
  // לבדיקות
  reset() { this.cols.clear(); }
}

class CollectionRef {
  constructor(db, name) { this.db = db; this.name = name; this.filters = []; }
  doc(id) { return new DocRef(this.db, this.name, id); }
  where(field, op, value) {
    const c = new CollectionRef(this.db, this.name);
    c.filters = [...this.filters, { field, op, value }];
    return c;
  }
  async get() { return this._snapshot(); }
  _snapshot() {
    const col = this.db._col(this.name);
    const docs = [];
    for (const [id, data] of col) {
      if (this.filters.every(f => match(data[f.field], f.op, f.value))) {
        docs.push(new DocSnap(new DocRef(this.db, this.name, id), clone(data)));
      }
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

function match(actual, op, expected) {
  switch (op) {
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '>=': return actual !== undefined && actual >= expected;
    case '<=': return actual !== undefined && actual <= expected;
    case '>':  return actual !== undefined && actual > expected;
    case '<':  return actual !== undefined && actual < expected;
    case 'in': return expected.includes(actual);
    default: throw new Error('memory-firestore: unsupported op ' + op);
  }
}

class DocSnap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return clone(this._d); }
}

class DocRef {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; this.path = `${col}/${id}`; }
  async get() {
    const d = this.db._col(this.col).get(this.id);
    return new DocSnap(this, clone(d));
  }
  set(data, opts) { return this.db.mutex.run(async () => this._set(data, opts)); }
  update(data) { return this.db.mutex.run(async () => this._update(data)); }
  delete() { return this.db.mutex.run(async () => { this.db._col(this.col).delete(this.id); }); }
  create(data) {
    return this.db.mutex.run(async () => {
      if (this.db._col(this.col).has(this.id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      this._set(data);
    });
  }
  _set(data, opts) {
    const col = this.db._col(this.col);
    col.set(this.id, opts && opts.merge ? { ...(col.get(this.id) || {}), ...clone(data) } : clone(data));
  }
  _update(data) {
    const col = this.db._col(this.col);
    if (!col.has(this.id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
    col.set(this.id, { ...col.get(this.id), ...clone(data) });
  }
}

class Transaction {
  constructor(db) { this.db = db; this.ops = []; this.wrote = false; }
  async get(refOrQuery) {
    if (this.wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
    return refOrQuery instanceof DocRef ? refOrQuery.get() : refOrQuery.get();
  }
  set(ref, data, opts) { this.wrote = true; this.ops.push(() => ref._set(data, opts)); return this; }
  update(ref, data) { this.wrote = true; this.ops.push(() => ref._update(data)); return this; }
  create(ref, data) {
    this.wrote = true;
    this.ops.push(() => {
      if (this.db._col(ref.col).has(ref.id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      ref._set(data);
    });
    return this;
  }
  delete(ref) { this.wrote = true; this.ops.push(() => { this.db._col(ref.col).delete(ref.id); }); return this; }
  _commit() {
    // החלה "אטומית": אם פעולה נכשלת — מחזירים את המצב הקודם
    const snapshot = new Map([...this.db.cols].map(([k, v]) => [k, new Map(v)]));
    try { for (const op of this.ops) op(); }
    catch (e) { this.db.cols = snapshot; throw e; }
  }
}

module.exports = { MemoryFirestore };
