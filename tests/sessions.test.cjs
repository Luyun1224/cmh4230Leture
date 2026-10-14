const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const shared = { window: {} }; vm.createContext(shared);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/course-sessions.js'), 'utf8'), shared);
const C = shared.window.CourseSessions;
const row = (id, extra = {}) => ({ '場次ID': id, '課程': '心臟超音波', '上課日期': '2026-10-14', '開始時間': '13:00', '學員人數': 6, '狀態': '已開課', '開放填答': '是', ...extra });

test('registry counts held attendance separately from planned and cancelled classes', () => {
  const parsed = C.read([row('one'), row('two', { '學員人數': 0 }), row('three', { '學員人數': '' }), row('four', { '狀態': '預定', '學員人數': 10 }), row('five', { '狀態': '取消', '學員人數': 20 })]);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(C.stats(parsed.sessions))), { held: 3, planned: 1, students: 6, missing: 1 });
});
test('invalid and duplicate sessions do not inflate totals; invalid attendance stays incomplete', () => {
  const p = C.read([row('duplicate'), row('duplicate'), row('bad-date', { '上課日期': '2026-02-30' }), row('bad-course', { '課程': '其他' }), row('bad-count', { '學員人數': -1 }), row('decimal', { '學員人數': 1.5 })]);
  assert.equal(p.sessions.length, 2); assert.equal(C.stats(p.sessions).missing, 2);
  assert.equal(p.issues.length, 5);
});
test('only explicit class dates or IDs resolve a session, never the answer timestamp', () => {
  const sessions = C.read([row('morning'), row('afternoon')]).sessions;
  assert.equal(C.resolve({ '時間戳記': '2026/10/14 13:00:00' }, sessions), null);
  assert.equal(C.resolve({ '上課日期': '2026-10-14' }, sessions), null);
  assert.equal(C.resolve({ '場次ID': 'missing', '上課日期': '2026-10-14' }, sessions), null);
  assert.equal(C.resolve({ '場次ID': 'morning', '時間戳記': '2026/10/10 13:00:00' }, sessions).id, 'morning');
  assert.equal(C.resolve({ '上課日期': '2026/10/14' }, sessions.filter(s => s.id === 'morning')).id, 'morning');
});

class Sheet {
  constructor(name, values = []) { this.name = name; this.values = values; this.formulas = new Map(); }
  getName() { return this.name; }
  getLastColumn() { return Math.max(0, ...this.values.map(r => r.length)); }
  getLastRow() { return this.values.length; }
  getDataRange() { return { getValues: () => this.values.map(r => [...r]) }; }
  getRange(row, column, rows, columns) {
    const target = this;
    const range = {
      getValues: () => Array.from({ length: rows }, (_, n) => Array.from({ length: columns }, (_, m) => target.values[row - 1 + n]?.[column - 1 + m] ?? '')),
      getFormulas: () => Array.from({ length: rows }, (_, n) => Array.from({ length: columns }, (_, m) => target.formulas.get(`${row + n}:${column + m}`) || '')),
      setValues: values => { values.forEach((r, n) => { target.values[row - 1 + n] ||= []; r.forEach((v, m) => { target.values[row - 1 + n][column - 1 + m] = v; }); }); return range; }
    };
    for (const method of ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat', 'setDataValidation', 'setNote', 'setValue']) range[method] = () => range;
    return range;
  }
  setFrozenRows() {} setColumnWidths() {}
  appendRow(row) { this.values.push(row); }
}
function backend() {
  const headers = ['場次ID', '課程', '上課日期', '開始時間', '學員人數', '狀態', '開放填答'];
  const entries = [row('early', { '狀態': '預定' }), row('closed', { '開放填答': '否' }), row('cancelled', { '狀態': '取消' }), row('duplicate'), row('duplicate'), row('broken', { '上課日期': '2026-02-30' })];
  const sheets = new Map([['課程清單', new Sheet('課程清單', [headers, ...entries.map(r => headers.map(h => r[h]))])], ['密碼管理', new Sheet('密碼管理', [['密碼', '使用者／備註', '啟用（是／否）', '最後登入時間', '登入次數'], ['test-only', 'fixture', '是', '', 0]])]]);
  const cache = new Map(); let locks = 0;
  const context = {
    Date, SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: name => sheets.get(name), getSheets: () => [...sheets.values()], insertSheet: name => { const sh = new Sheet(name); sheets.set(name, sh); return sh; } }),
      newDataValidation: () => { const v = {}; for (const k of ['requireValueInList', 'requireFormulaSatisfied', 'setAllowInvalid', 'build']) v[k] = () => v; return v; }
    },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => { locks++; }, releaseLock: () => { locks--; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(), computeDigest: (algorithm, value, charset) => [...crypto.createHash(algorithm).update(value, charset).digest()], base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      formatDate: (d, tz, fmt) => {
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
      return fmt === 'yyyy-MM-dd' ? date : fmt === 'HH:mm' ? time.slice(0, 5) : date.replaceAll('-', '/') + ' ' + time;
    } }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), context);
  return { context, sheets, cache, locks: () => locks };
}
const token = '12345678-1234-4234-8234-123456789abc';
function submit(ctx, session = 'early', sheet = '心臟超音波_前測') {
  return ctx.doPost({ postData: { contents: JSON.stringify({ sheet, receiptToken: token, row: { '場次ID': session, '姓名': '=untrusted text', '上課日期': '2026-10-10', '時間戳記': 'wrong-date', '信心': 4 } }) } });
}
test('public catalog excludes personal data, duplicate/closed/cancelled sessions; admin reads remain password protected', () => {
  const { context: ctx, sheets } = backend();
  const result = ctx.doGet({ parameter: { action: 'sessions', sheet: '密碼管理' } });
  assert.equal(result.ok, true); assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]['場次ID'], 'early');
  for (const key of ['學員人數', '姓名', '密碼']) assert.equal(Object.hasOwn(result.sessions[0], key), false);
  assert.equal(ctx.doGet({ parameter: {} }).error, 'auth');
  assert.equal(ctx.doGet({ parameter: { pw: 'wrong' } }).error, 'auth');
  const admin = ctx.doGet({ parameter: { pw: 'test-only' } });
  assert.equal(admin.ok, true); assert.equal(Object.hasOwn(admin.data, '密碼管理'), false);
  assert.equal(admin.data['課程清單'].length, 6);
  const date = new Date('2026-10-13T16:00:00Z');
  assert.equal(ctx.sheetRows(new Sheet('test', [['上課日期', '開始時間'], [date, date]]))[0]['上課日期'], '2026-10-14');
  assert.equal(ctx.sheetRows(new Sheet('test', [['上課日期', '開始時間'], [date, date]]))[0]['開始時間'], '00:00');
});
test('early responses use registry date; duplicate receipt retries do not write twice even after cache eviction', () => {
  const { context: ctx, sheets, cache, locks } = backend();
  assert.equal(submit(ctx).ok, true);
  const sh = sheets.get('心臟超音波_前測'); const record = Object.fromEntries(sh.values[0].map((h, i) => [h, sh.values[1][i]]));
  assert.equal(record['上課日期'], '2026-10-14'); assert.notEqual(record['時間戳記'], 'wrong-date');
  assert.equal(record['姓名'], "'=untrusted text"); assert.equal(record['信心'], 4);
  assert.equal(ctx.doGet({ parameter: { action: 'receipt', token } }).received, true);
  assert.equal(submit(ctx).ok, true); assert.equal(sh.values.length, 2);
  cache.clear(); assert.equal(submit(ctx).ok, true); assert.equal(sh.values.length, 2); assert.equal(locks(), 0);
});
test('wrong-course, missing, closed, cancelled and management-sheet writes are rejected without creating sheets', () => {
  for (const [session, sheet] of [['early', '內視鏡_前測'], ['missing', '心臟超音波_前測'], ['closed', '心臟超音波_前測'], ['cancelled', '心臟超音波_後測'], ['duplicate', '心臟超音波_前測'], ['early', '課程清單'], ['early', '密碼管理']]) {
    const { context: ctx, sheets, locks } = backend();
    assert.equal(submit(ctx, session, sheet).ok, false);
    assert.equal(sheets.size, 2); assert.equal(locks(), 0);
    assert.equal(ctx.doGet({ parameter: { action: 'receipt', token } }).ok, false);
  }
});
test('course sheet setup preserves existing data and creates only headers when absent', () => {
  const { context: ctx, sheets } = backend();
  const before = JSON.stringify(sheets.get('課程清單').values);
  ctx.setupCourseSheet(); assert.equal(JSON.stringify(sheets.get('課程清單').values), before);
  sheets.delete('課程清單'); ctx.setupCourseSheet(); assert.equal(sheets.get('課程清單').values.length, 1);
  assert.equal(sheets.get('課程清單').values[0][0], '場次ID'); ctx.setupCourseSheet(); assert.equal(sheets.get('課程清單').values.length, 1);
});

function adminEnvironment() {
  const fixture = backend(), { context: ctx, sheets } = fixture;
  ctx.setupCourseAdmin();
  const sh = sheets.get('密碼管理'), column = sh.values[0].indexOf('管理課程（是／否）');
  sh.values[1][column] = '是';
  const id = crypto.randomUUID();
  const post = payload => ctx.doPost({ postData: { contents: JSON.stringify(payload) } });
  assert.equal(post({ action: 'admin-login', password: 'test-only', requestId: id }).ok, true);
  const login = ctx.doGet({ parameter: { action: 'admin-login-result', requestId: id } });
  assert.equal(login.ok, true); assert.equal(login.received, true);
  const get = action => ctx.doGet({ parameter: { action, adminToken: login.adminToken } });
  const save = (payload, requestId = crypto.randomUUID()) => {
    const result = post({ action: 'admin-save', adminToken: login.adminToken, requestId, ...payload });
    return { result, requestId, receipt: ctx.doGet({ parameter: { action: 'admin-receipt', adminToken: login.adminToken, requestId } }) };
  };
  return { ...fixture, post, save, get, adminToken: login.adminToken, roleColumn: column, login };
}
test('management permission upgrade preserves passwords and login history without granting access by default', () => {
  const { context: ctx, sheets } = backend(), passwordSheet = sheets.get('密碼管理');
  const before = [...passwordSheet.values[1]];
  ctx.setupCourseAdmin();
  const column = passwordSheet.values[0].indexOf('管理課程（是／否）');
  assert.equal(column, 5); assert.deepEqual(passwordSheet.values[1].slice(0, 5), before);
  assert.equal(passwordSheet.values[1][column], '否');
  passwordSheet.values[1][column] = '是'; ctx.setupCourseAdmin();
  assert.equal(passwordSheet.values[1][column], '是'); assert.equal(passwordSheet.getLastColumn(), 6);
  const req = crypto.randomUUID(); passwordSheet.values[1][column] = '否';
  const result = ctx.doPost({ postData: { contents: JSON.stringify({ action: 'admin-login', password: 'test-only', requestId: req }) } });
  assert.equal(result.ok, false); assert.equal(result.error, 'admin-auth');
  assert.equal(ctx.doGet({ parameter: { action: 'admin-login-result', requestId: req } }).error, 'admin-auth');
  assert.equal(ctx.checkPassword('test-only'), true);
});
test('administrator login uses a POST password; session cache contains only password hash and metadata', () => {
  const { get, login, cache, context: ctx } = adminEnvironment();
  assert.equal(typeof login.expiresAt, 'number'); assert.ok(login.expiresAt > Date.now());
  const catalog = get('admin-catalog'); assert.equal(catalog.ok, true); assert.equal(catalog.records.length, 6);
  assert.equal(Object.hasOwn(catalog.data, '密碼管理'), false);
  assert.equal([...cache.values()].some(value => value.includes('test-only')), false);
  assert.equal(ctx.doGet({ parameter: { action: 'admin-catalog', pw: 'test-only' } }).error, 'admin-auth');
  assert.equal(ctx.doGet({ parameter: { action: 'admin-receipt', adminToken: crypto.randomUUID(), requestId: crypto.randomUUID() } }).error, 'admin-auth');
  assert.equal(ctx.doGet({ parameter: { action: 'admin-login-result', requestId: crypto.randomUUID() } }).received, false);
});
test('authenticated course creation updates the Sheet exactly once and public surveys see the new open class', () => {
  const { save, get, sheets, context: ctx } = adminEnvironment();
  const initial = sheets.get('課程清單').getLastRow(), session = row('admin-new', { '課程': '腹腔鏡', '學員人數': 0, '狀態': '預定' });
  const req = crypto.randomUUID();
  assert.equal(save({ mode: 'create', session }, req).receipt.ok, true);
  assert.equal(save({ mode: 'create', session }, req).receipt.ok, true);
  assert.equal(sheets.get('課程清單').getLastRow(), initial + 1);
  assert.equal(get('admin-catalog').records.at(-1).session['學員人數'], 0);
  assert.equal(ctx.doGet({ parameter: { action: 'sessions' } }).sessions.some(s => s['場次ID'] === 'admin-new'), true);
});
test('expired, disabled, removed-role, changed-password and logged-out sessions cannot write even with a cached success receipt', () => {
  for (const change of ['expires', 'disabled', 'role', 'password', 'logout']) {
    const f = adminEnvironment(), { sheets, save, get, adminToken, cache, post, roleColumn } = f;
    const session = row('revoked'), req = crypto.randomUUID();
    assert.equal(save({ mode: 'create', session }, req).result.ok, true);
    const before = JSON.stringify(sheets.get('課程清單').values);
    if (change === 'expires') { const s = JSON.parse(cache.get('admin-session:' + adminToken)); s.expiresAt = 0; cache.set('admin-session:' + adminToken, JSON.stringify(s)); }
    if (change === 'disabled') sheets.get('密碼管理').values[1][2] = '否';
    if (change === 'role') sheets.get('密碼管理').values[1][roleColumn] = '否';
    if (change === 'password') sheets.get('密碼管理').values[1][0] = 'changed-test-value';
    if (change === 'logout') assert.equal(post({ action: 'admin-logout', adminToken }).ok, true);
    assert.equal(save({ mode: 'create', session }, req).result.error, 'admin-auth');
    assert.equal(get('admin-catalog').error, 'admin-auth');
    assert.equal(JSON.stringify(sheets.get('課程清單').values), before);
  }
});
test('missing or forged management authentication cannot create or alter classes', () => {
  const { context: ctx, sheets } = backend(), before = JSON.stringify(sheets.get('課程清單').values);
  for (const adminToken of ['', crypto.randomUUID()]) {
    const result = ctx.doPost({ postData: { contents: JSON.stringify({ action: 'admin-save', password: 'test-only', adminToken, requestId: crypto.randomUUID(), mode: 'create', session: row('attack') }) } });
    assert.equal(result.error, 'admin-auth'); assert.equal(JSON.stringify(sheets.get('課程清單').values), before);
  }
});
test('course updates preserve identities and additional formulas; competing editors cannot silently overwrite newer values', () => {
  const { get, save, sheets } = adminEnvironment(), sh = sheets.get('課程清單');
  sh.values[0].push('同事的自訂欄'); sh.values[1].push(12); sh.formulas.set('2:8', '=6+6');
  const record = get('admin-catalog').records[0];
  const payload = { mode: 'update', row: record.row, version: record.version, session: { ...record.session, '上課日期': '2026-10-21', '學員人數': 9, '狀態': '已開課', '開放填答': '否' } };
  assert.equal(save(payload).result.ok, true); assert.equal(sh.values[1][7], '=6+6');
  assert.equal(sh.values[1][4], 9); assert.equal(sh.values[1][2], '2026-10-21');
  const before = JSON.stringify(sh.values);
  assert.equal(save({ ...payload, session: { ...payload.session, '學員人數': 2 } }).result.error, 'conflict');
  assert.equal(JSON.stringify(sh.values), before);
  const current = get('admin-catalog').records[0];
  for (const changed of [{ '場次ID': 'rename' }, { '課程': '腹腔鏡' }]) {
    assert.equal(save({ mode: 'update', row: current.row, version: current.version, session: { ...current.session, ...changed } }).result.error, 'validation');
    assert.equal(JSON.stringify(sh.values), before);
  }
});
test('invalid administrative fields, duplicate IDs and missing headers fail before any course row is changed', () => {
  const { save, sheets } = adminEnvironment();
  const before = JSON.stringify(sheets.get('課程清單').values);
  for (const changed of [{ '場次ID': 'early' }, { '場次ID': '=formula' }, { '學員人數': -1 }, { '學員人數': 1.5 }, { '課程': '任意課程' }, { '上課日期': '2026-02-30' }, { '開始時間': '25:61' }, { '狀態': '刪除' }, { '開放填答': '' }]) {
    assert.equal(save({ mode: 'create', session: row('valid-new', changed) }).result.error, 'validation');
    assert.equal(JSON.stringify(sheets.get('課程清單').values), before);
  }
  sheets.get('課程清單').values[0][0] = '缺少場次ID';
  const malformed = JSON.stringify(sheets.get('課程清單').values);
  assert.equal(save({ mode: 'create', session: row('valid-new') }).result.error, 'setup');
  assert.equal(JSON.stringify(sheets.get('課程清單').values), malformed);
});
