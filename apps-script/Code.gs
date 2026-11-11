/**
 * Community Creche sign-ups — Google Apps Script backend.
 *
 * Lives inside the Google Sheet (Extensions > Apps Script). See SETUP.md.
 *
 * Privacy model:
 *   - Phone numbers are written to the Sheet and never returned by doGet().
 *   - The Sheet itself is never shared; only this script (running as the owner) touches it.
 *   - doGet() returns only what the public page displays: slot, name, performance, creche total.
 */

const PERFORMANCES = 'Performances';
const CRECHES = 'Creches';
const DECORATIONS = 'Decorations';
const USHERS = 'Ushers';

// Time grid: 10-minute slots, noon up to (not including) 9:00 PM. Keep in sync with app.js.
const FIRST_MIN = 12 * 60;
const LAST_MIN = 21 * 60;
const STEP_MIN = 10;
// Usher blocks: one per hour over the same window, labelled like 'Noon – 1 PM' and '8 – 9 PM'. Keep in sync with app.js.

const MAX_CRECHES_PER_SIGNUP = 50;
const CACHE_KEY = 'public-v2';
const CACHE_SECONDS = 15;

// Column layout of each tab. '@' = plain text (so nothing is ever treated as a formula).
const SHEETS = {
  [PERFORMANCES]: {
    headers: ['Time', 'Name', 'Performance', 'Phone (private)', 'Signed up at'],
    formats: ['@', '@', '@', '@', '@'],
  },
  [CRECHES]: {
    headers: ['Signed up at', 'Name (private)', 'Creches', 'Phone (private)'],
    formats: ['@', '@', '0', '@'],
  },
  [USHERS]: {
    headers: ['Hour', 'Name', 'Phone (private)', 'Signed up at'],
    formats: ['@', '@', '@', '@'],
  },
  [DECORATIONS]: {
    headers: ['Signed up at', 'Name (private)', 'Bringing (private)', 'Phone (private)'],
    formats: ['@', '@', '@', '@'],
  },
};

// ---------- Web app entry points ----------

function doGet() {
  try {
    return respond_(publicData_());
  } catch (err) {
    console.error(err);
    return respond_({ ok: false, error: 'server' });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond_(fail_('invalid'));
  }

  // Honeypot: real people never fill this hidden field. Pretend success, save nothing.
  if (body && body.website) return respond_({ ok: true });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return respond_(fail_('busy'));

  try {
    if (body.type === 'performance') return respond_(addSlots_(body, PERFORMANCE_KIND));
    if (body.type === 'usher') return respond_(addSlots_(body, USHER_KIND));
    if (body.type === 'creche') return respond_(addCreche_(body));
    if (body.type === 'decorations') return respond_(addDecorations_(body));
    return respond_(fail_('invalid'));
  } catch (err) {
    console.error(err);
    return respond_(fail_('server'));
  } finally {
    lock.releaseLock();
  }
}

// ---------- Reads ----------

function publicData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const validTimes = slotLabels_();
  const performances = rows_(PERFORMANCES)
    .filter(function (r) { return validTimes.indexOf(String(r[0]).trim()) >= 0; })
    .map(function (r) {
      // r[3] is the phone number: deliberately not included.
      return { slot: String(r[0]).trim(), name: String(r[1]), piece: String(r[2]) };
    });
  const validHours = hourLabels_();
  const ushers = rows_(USHERS)
    .filter(function (r) { return validHours.indexOf(String(r[0]).trim()) >= 0; })
    .map(function (r) {
      // r[2] is the phone number: deliberately not included.
      return { slot: String(r[0]).trim(), name: String(r[1]) };
    });
  const creches = rows_(CRECHES).reduce(function (sum, r) {
    return sum + (Number(r[2]) || 0);
  }, 0);

  const data = { ok: true, performances: performances, ushers: ushers, creches: creches };
  cache.put(CACHE_KEY, JSON.stringify(data), CACHE_SECONDS);
  return data;
}

// ---------- Writes (always called while holding the script lock) ----------

// What differs between the two slot-based signups: which tab, which labels are valid, and the row layout.
const PERFORMANCE_KIND = {
  sheet: PERFORMANCES,
  labels: function () { return slotLabels_(); },
  row: function (slot, f) { return [slot, f.name, f.piece, f.phone, f.stamp]; },
};
const USHER_KIND = {
  sheet: USHERS,
  labels: function () { return hourLabels_(); },
  row: function (slot, f) { return [slot, f.name, f.phone, f.stamp]; },
};

// One signup can reserve several slots. Each slot becomes its own row, so the public read stays one-row-per-slot.
// All-or-nothing: if any chosen slot is already taken, nothing is saved and the taken slots are returned.
function addSlots_(b, kind) {
  const requested = Array.isArray(b.slots) ? b.slots : [b.slot];
  const valid = kind.labels();
  const slots = [];
  requested.forEach(function (s) {
    const slot = String(s || '').trim();
    if (slots.indexOf(slot) < 0) slots.push(slot);
  });
  if (!slots.length || slots.some(function (s) { return valid.indexOf(s) < 0; })) return fail_('invalid');

  const fields = { name: clean_(b.name, 80), piece: clean_(b.piece, 120), phone: phone_(b.phone), stamp: now_() };
  if (!fields.name || !fields.phone) return fail_('invalid');

  const booked = rows_(kind.sheet).map(function (r) { return String(r[0]).trim(); });
  const taken = slots.filter(function (s) { return booked.indexOf(s) >= 0; });
  if (taken.length) return { ok: false, error: 'taken', taken: taken };

  saveRows_(kind.sheet, slots.map(function (slot) { return kind.row(slot, fields); }));
  return { ok: true };
}

function addCreche_(b) {
  const name = clean_(b.name, 80);
  const phone = phone_(b.phone);
  const count = Math.floor(Number(b.count));
  if (!name || !phone) return fail_('invalid');
  if (!(count >= 1 && count <= MAX_CRECHES_PER_SIGNUP)) return fail_('invalid');

  saveRows_(CRECHES, [[now_(), name, count, phone]]);
  return { ok: true };
}

function addDecorations_(b) {
  const name = clean_(b.name, 80);
  const items = clean_(b.items, 120);
  const phone = phone_(b.phone);
  if (!name || !phone) return fail_('invalid');

  saveRows_(DECORATIONS, [[now_(), name, items, phone]]);
  return { ok: true };
}

// ---------- Helpers ----------

function saveRows_(sheetName, rows) {
  const sh = sheet_(sheetName);
  rows.forEach(function (row) { sh.appendRow(row); });
  SpreadsheetApp.flush();
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function slotLabels_() {
  const labels = [];
  for (let m = FIRST_MIN; m < LAST_MIN; m += STEP_MIN) labels.push(label_(m));
  return labels;
}

function hourLabels_() {
  const labels = [];
  for (let h = FIRST_MIN / 60; h < LAST_MIN / 60; h++) {
    labels.push((h === 12 ? 'Noon' : String(h % 12)) + ' \u2013 ' + ((h + 1) % 12 || 12) + ' PM');
  }
  return labels;
}

function label_(minutes) {
  const h = Math.floor(minutes / 60);
  const mm = ('0' + (minutes % 60)).slice(-2);
  return (h % 12 || 12) + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
}

// Collapse whitespace, drop control characters, and strip leading = + - @ (spreadsheet formula starters).
function clean_(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[=+\-@]+/, '')
    .trim()
    .slice(0, max);
}

// Returns a tidy phone string, or '' if it doesn't look like a phone number.
function phone_(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^[\d\s().+\-]{7,25}$/.test(raw)) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return '';
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  return raw;
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

// Returns the tab, creating it (with headers and text formatting) the first time it's needed.
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (sh) return sh;

  const spec = SHEETS[name];
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const dataRows = Math.max(sh.getMaxRows() - 1, 1);
  spec.formats.forEach(function (format, i) {
    sh.getRange(2, i + 1, dataRows, 1).setNumberFormat(format);
  });
  sh.autoResizeColumns(1, spec.headers.length);
  return sh;
}

// All data rows of a tab that have something in the first column.
function rows_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh
    .getRange(2, 1, last - 1, sh.getLastColumn())
    .getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; });
}

function fail_(error) {
  return { ok: false, error: error };
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
