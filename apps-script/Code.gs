/**
 * 臨床技能中心模擬課程問卷 — 綁定 Google Sheet 的 Apps Script。
 * 初次使用：執行 setupPasswordSheet、setupCourseSheet。
 * 現有使用者：保留原 Sheet，執行 setupCourseSheet，再部署新版本（網址不變）。
 * 課程清單一列一場；前測可以提前填寫，場次以場次ID識別。
 */
const PW_SHEET = '密碼管理';
const COURSE_SHEET = '課程清單';
const TZ = 'Asia/Taipei';
const COURSE_NAMES = ['心臟超音波', '內視鏡', '腹部超音波', '腹腔鏡'];
const COURSE_HEADERS = ['場次ID', '課程', '上課日期', '開始時間', '學員人數', '狀態', '開放填答'];
const ADMIN_HEADER = '管理課程（是／否）';
const ADMIN_SECONDS = 1800;

// 使用 Apps Script 編輯器可解析的語法；保留 0、false 與空字串。
function valueOrEmpty(value) { return value == null ? '' : value; }

// getRange 不會自動補足已刪除的列／欄，先擴充格線再寫入。
function ensureSheetSize(sh, rows, columns) {
  const currentRows = sh.getMaxRows(), currentColumns = sh.getMaxColumns();
  if (currentRows < rows) sh.insertRowsAfter(currentRows, rows - currentRows);
  if (currentColumns < columns) sh.insertColumnsAfter(currentColumns, columns - currentColumns);
}

// 僅接受八張問卷工作表，防止問卷寫入課程清單或密碼管理；不因場次未建立而拒收。
function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false, token = '';
  try {
    lock.waitLock(20000); locked = true;
    const data = JSON.parse(e.postData.contents);
    if (data.action) return adminPost(data);
    token = String(data.receiptToken || '');
    if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error('收件識別碼格式錯誤');
    const previous = CacheService.getScriptCache().get('receipt:' + token);
    if (previous && JSON.parse(previous).ok) return json({ ok: true });
    const name = String(data.sheet || '');
    const match = name.match(/^(心臟超音波|內視鏡|腹部超音波|腹腔鏡)_(前測|後測)$/);
    if (!match) throw new Error('不允許的工作表名稱');
    const row = data.row;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('問卷格式錯誤');
    // 問卷永遠開放：場次ID有效就以清單為準；否則依學員填的上課日期收件，
    // 當天恰好一場同課程場次時自動歸入，找不到就先留白，之後補建場次即可在儀表板自動配對。
    const sessionID = String(row['場次ID'] || '').trim();
    const sessions = surveySessions().filter(s => s['課程'] === match[1] && s['狀態'] !== '取消');
    let session = sessionID ? sessions.find(s => s['場次ID'] === sessionID) : null;
    if (!session) {
      const day = courseDay(row['上課日期']);
      if (!day) throw new Error('請選擇上課日期');
      const sameDay = sessions.filter(s => s['上課日期'] === day);
      session = sameDay.length === 1 ? sameDay[0] : { '場次ID': '', '上課日期': day };
    }
    // 時間戳記仍記錄實際收到問卷的時間。
    row['場次ID'] = session['場次ID'];
    row['上課日期'] = session['上課日期'];
    row['問卷'] = match[2];
    row['時間戳記'] = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    let headers = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    const tokenColumn = headers.indexOf('收件ID') + 1;
    if (tokenColumn && sh.getLastRow() > 1 && sh.getRange(2, tokenColumn, sh.getLastRow() - 1, 1).getValues().some(r => r[0] === token)) {
      CacheService.getScriptCache().put('receipt:' + token, JSON.stringify({ ok: true }), 21600);
      return json({ ok: true });
    }
    row['收件ID'] = token;
    const missing = Object.keys(row).filter(k => headers.indexOf(k) === -1);
    if (missing.length) {
      headers = headers.concat(missing);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    sh.appendRow(headers.map(h => (h in row ? sheetValue(row[h]) : '')));
    CacheService.getScriptCache().put('receipt:' + token, JSON.stringify({ ok: true }), 21600);
    return json({ ok: true });
  } catch (err) {
    if (/^[a-f0-9-]{36}$/i.test(token)) CacheService.getScriptCache().put('receipt:' + token, JSON.stringify({ ok: false, error: String(err) }), 21600);
    return json({ ok: false, error: String(err) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// 避免學員輸入的文字被 Sheet 當成公式；數字量表仍保留為數字。
function sheetValue(value) {
  if (typeof value === 'string' && /^\s*[=+@-]/.test(value)) return "'" + value;
  return value;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (String(p.action || '').startsWith('admin-')) return adminGet(p);
  // 不透明的隨機識別碼，只回傳收件狀態，避免 no-cors POST 被拒仍顯示成功。
  if (p.action === 'receipt') {
    const token = String(p.token || '');
    if (!/^[a-f0-9-]{36}$/i.test(token)) return json({ ok: false, error: '收件識別碼格式錯誤' });
    const receipt = CacheService.getScriptCache().get('receipt:' + token);
    return json(receipt ? Object.assign({}, JSON.parse(receipt), { received: true }) : { ok: true, received: false });
  }
  // 問卷只需要可公開的場次資訊；不回傳人數、姓名、答案或管理密碼。
  if (p.action === 'sessions') {
    try {
      const sessions = courseSessions().filter(s => s['開放填答'] === '是' && s['狀態'] !== '取消')
        .map(s => ({ '場次ID': s['場次ID'], '課程': s['課程'], '上課日期': s['上課日期'],
          '開始時間': s['開始時間'], '狀態': s['狀態'], '開放填答': s['開放填答'] }));
      return json({ ok: true, sessions });
    } catch (err) { return json({ ok: false, error: String(err) }); }
  }
  if (!checkPassword(p.pw)) return json({ ok: false, error: 'auth' });
  return json({ ok: true, data: dashboardData(p.sheet) });
}

function dashboardData(only) {
  const out = {};
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(sh => {
    const name = sh.getName();
    if (name === PW_SHEET || (only && name !== only)) return;
    out[name] = sheetRows(sh);
  });
  return out;
}

function sheetRows(sh) {
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  const h = v[0].map(String);
  return v.slice(1).filter(r => r.some(c => c !== '' && c !== null))
    .map(r => sheetObject(h, r));
}

function sheetObject(headers, row) {
  return Object.fromEntries(headers.map((key, i) => {
    const value = row[i];
    const format = key === '開始時間' ? 'HH:mm' : key === '上課日期' ? 'yyyy-MM-dd' : 'yyyy/MM/dd HH:mm:ss';
    return [key, value instanceof Date ? Utilities.formatDate(value, TZ, format) : value];
  }));
}

function courseSessions() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COURSE_SHEET);
  if (!sh) throw new Error('請先執行 setupCourseSheet 並建立課程清單');
  const rows = sheetRows(sh), counts = {};
  rows.forEach(r => { const id = String(r['場次ID'] || '').trim(); counts[id] = (counts[id] || 0) + 1; });
  return rows.map(r => Object.assign({}, r, { '場次ID': String(r['場次ID'] || '').trim(), '課程': String(r['課程'] || '').trim(),
    '上課日期': courseDay(r['上課日期']), '開始時間': String(r['開始時間'] || '').trim(),
    '狀態': String(r['狀態'] || '').trim(), '開放填答': String(r['開放填答'] || '').trim() }))
    .filter(r => r['場次ID'] && counts[r['場次ID']] === 1 && COURSE_NAMES.includes(r['課程']) && r['上課日期']
      && ['預定', '已開課', '取消'].includes(r['狀態']));
}

// 課程清單缺漏或格式錯誤時仍要收問卷，不讓學員卡住。
function surveySessions() {
  try { return courseSessions(); } catch (err) { return []; }
}

function courseDay(value) {
  const m = String(value || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:$|[ T])/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// 已存在就直接回傳，重跑不覆寫清單或插入假場次。
function setupCourseSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(COURSE_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(COURSE_SHEET);
  sh.getRange(1, 1, 1, COURSE_HEADERS.length).setValues([COURSE_HEADERS])
    .setFontWeight('bold').setBackground('#1B1410').setFontColor('#FFD84D');
  sh.getRange('A2:B1000').setNumberFormat('@');
  sh.getRange('C2:C1000').setNumberFormat('yyyy-mm-dd');
  sh.getRange('D2:D1000').setNumberFormat('@');
  sh.getRange('E2:E1000').setNumberFormat('0');
  const validation = SpreadsheetApp.newDataValidation();
  sh.getRange('B2:B1000').setDataValidation(validation.requireValueInList(COURSE_NAMES, true).setAllowInvalid(false).build());
  sh.getRange('E2:E1000').setDataValidation(SpreadsheetApp.newDataValidation().requireFormulaSatisfied('=OR(ISBLANK(E2),AND(ISNUMBER(E2),E2>=0,MOD(E2,1)=0))').setAllowInvalid(false).build());
  sh.getRange('F2:F1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['預定', '已開課', '取消'], true).setAllowInvalid(false).build());
  sh.getRange('G2:G1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['是', '否'], true).setAllowInvalid(false).build());
  sh.setColumnWidths(1, COURSE_HEADERS.length, 150); sh.setFrozenRows(1);
  sh.getRange('A1').setNote('場次ID須唯一。問卷已使用的ID請勿修改；同一天兩場也要用不同ID。');
  sh.getRange('E1').setNote('已開課請填實際學員人數；預定場次可填預計人數。留白表示尚未登記，0表示確定沒有學員。');
  sh.getRange('F1').setNote('只有「已開課」計入已開辦場次與學員人次；不會依日期自動判定。');
  sh.getRange('G1').setNote('「是」會出現在問卷的日期選單；「否」只從選單隱藏，學員仍可自行選日期填寫，問卷永遠開放。');
  return sh;
}

// ---------- 課程管理：登入權限與有效期限由伺服器驗證 ----------
function enabled(value) { return /^(是|y|yes|true|啟用|1)$/i.test(String(value || '').trim()); }
function digest(value) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}
function adminError(code, message) { const error = new Error(message); error.code = code; throw error; }
function requestID(value) { return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(value || '')); }

function passwordRecord(pw, admin = false) {
  pw = String(pw || '').trim(); if (!pw) return null;
  const sh = setupPasswordSheet(), last = sh.getLastRow(); if (last < 2) return null;
  const width = Math.max(sh.getLastColumn(), 5);
  const headers = sh.getRange(1, 1, 1, width).getValues()[0];
  const adminColumn = headers.indexOf(ADMIN_HEADER);
  const rows = sh.getRange(2, 1, last - 1, width).getValues();
  for (let i = 0; i < rows.length; i++) {
    const [p, , on, , count] = rows[i];
    const active = String(on).trim() === '' || enabled(on);
    if (String(p).trim() === pw && active && (!admin || (adminColumn >= 0 && enabled(rows[i][adminColumn])))) {
      return { sh, row: i + 2, count };
    }
  }
  return null;
}
function stampLogin(record) {
  record.sh.getRange(record.row, 4, 1, 2).setValues([[Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss'), (Number(record.count) || 0) + 1]]);
}
function checkPassword(pw) { const record = passwordRecord(pw); if (!record) return false; stampLogin(record); return true; }

function requireAdmin(token) {
  if (!requestID(token)) adminError('admin-auth', '管理者登入已過期，請重新登入。');
  const cached = CacheService.getScriptCache().get('admin-session:' + token);
  if (!cached) adminError('admin-auth', '管理者登入已過期，請重新登入。');
  const session = JSON.parse(cached), sh = setupPasswordSheet();
  const width = Math.max(sh.getLastColumn(), 5), headers = sh.getRange(1, 1, 1, width).getValues()[0];
  const roleColumn = headers.indexOf(ADMIN_HEADER);
  const row = session.row <= sh.getLastRow() ? sh.getRange(session.row, 1, 1, width).getValues()[0] : [];
  if (session.expiresAt <= Date.now() || roleColumn < 0 || !enabled(row[roleColumn])
    || !(String(valueOrEmpty(row[2])).trim() === '' || enabled(row[2])) || digest(String(row[0] || '').trim()) !== session.passwordHash) {
    CacheService.getScriptCache().remove('admin-session:' + token);
    adminError('admin-auth', '管理者登入已過期或權限已停用，請重新登入。');
  }
  return session;
}

function adminPost(data) {
  const cache = CacheService.getScriptCache();
  let resultKey = '';
  try {
    if (data.action === 'admin-logout') {
      if (requestID(data.adminToken)) cache.remove('admin-session:' + data.adminToken);
      return json({ ok: true });
    }
    if (!requestID(data.requestId)) adminError('validation', '收件識別碼格式錯誤。');
    if (data.action === 'admin-login') {
      resultKey = 'admin-login:' + data.requestId;
      const record = passwordRecord(data.password, true);
      if (!record) adminError('admin-auth', '密碼不正確、停用，或尚未開啟課程管理權限。');
      const token = Utilities.getUuid(), expiresAt = Date.now() + ADMIN_SECONDS * 1000;
      cache.put('admin-session:' + token, JSON.stringify({ row: record.row, passwordHash: digest(String(data.password).trim()), expiresAt }), ADMIN_SECONDS);
      stampLogin(record);
      cache.put(resultKey, JSON.stringify({ ok: true, adminToken: token, expiresAt }), 60);
      return json({ ok: true });
    }
    if (data.action !== 'admin-save') adminError('validation', '不支援的管理操作。');
    requireAdmin(data.adminToken);
    resultKey = 'admin-receipt:' + data.adminToken + ':' + data.requestId;
    const previous = cache.get(resultKey);
    if (previous && JSON.parse(previous).ok) return json({ ok: true });
    saveCourseSession(data);
    cache.put(resultKey, JSON.stringify({ ok: true }), ADMIN_SECONDS);
    return json({ ok: true });
  } catch (error) {
    const result = { ok: false, error: error.code || 'server', message: String(error.message || error) };
    if (resultKey) cache.put(resultKey, JSON.stringify(result), data.action === 'admin-login' ? 60 : ADMIN_SECONDS);
    return json(result);
  }
}

function adminGet(p) {
  try {
    const cache = CacheService.getScriptCache();
    if (p.action === 'admin-login-result') {
      if (!requestID(p.requestId)) adminError('validation', '收件識別碼格式錯誤。');
      const result = cache.get('admin-login:' + p.requestId);
      return json(result ? Object.assign({}, JSON.parse(result), { received: true }) : { ok: true, received: false });
    }
    requireAdmin(p.adminToken);
    if (p.action === 'admin-catalog') return json({ ok: true, records: adminCatalog(), data: dashboardData() });
    if (p.action === 'admin-receipt') {
      if (!requestID(p.requestId)) adminError('validation', '收件識別碼格式錯誤。');
      const result = cache.get('admin-receipt:' + p.adminToken + ':' + p.requestId);
      return json(result ? Object.assign({}, JSON.parse(result), { received: true }) : { ok: true, received: false });
    }
    adminError('validation', '不支援的管理操作。');
  } catch (error) { return json({ ok: false, error: error.code || 'server', message: String(error.message || error) }); }
}

function courseSheetInfo() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COURSE_SHEET);
  if (!sh) adminError('setup', '請先執行 setupCourseSheet 建立課程清單。');
  const values = sh.getDataRange().getValues(), headers = values[0].map(String);
  if (COURSE_HEADERS.some(h => headers.filter(v => v === h).length !== 1)) adminError('setup', '課程清單欄位不完整或重複，請確認七個標準欄位。');
  return { sh, values, headers };
}
function recordVersion(session, row) { return digest(JSON.stringify([row, ...COURSE_HEADERS.map(h => valueOrEmpty(session[h]))])); }
function adminCatalog() {
  const { values, headers } = courseSheetInfo();
  return values.slice(1).map((row, i) => {
    const session = sheetObject(headers, row);
    return { row: i + 2, session: Object.fromEntries(COURSE_HEADERS.map(h => [h, valueOrEmpty(session[h])])), version: recordVersion(session, i + 2) };
  }).filter(r => COURSE_HEADERS.some(h => r.session[h] !== ''));
}
function validCourseSession(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) adminError('validation', '課程資料格式錯誤。');
  const session = Object.fromEntries(COURSE_HEADERS.map(h => [h, String(valueOrEmpty(input[h])).trim()]));
  if (!session['場次ID'] || session['場次ID'].length > 80 || /^[=+@-]/.test(session['場次ID']) || /[\x00-\x1f\x7f]/.test(session['場次ID'])) adminError('validation', '請填寫有效的場次ID（最多80字，不可以公式符號開頭）。');
  if (!COURSE_NAMES.includes(session['課程'])) adminError('validation', '請選擇四門模擬課程之一。');
  const day = courseDay(session['上課日期']);
  if (!day) adminError('validation', '請填寫有效的上課日期。');
  session['上課日期'] = day;
  if (session['開始時間'] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(session['開始時間'])) adminError('validation', '開始時間格式須為 HH:mm。');
  if (session['學員人數'] !== '') {
    const n = Number(session['學員人數']);
    if (!Number.isSafeInteger(n) || n < 0) adminError('validation', '學員人數須為非負整數或留白。');
    session['學員人數'] = n;
  }
  if (!['預定', '已開課', '取消'].includes(session['狀態']) || !['是', '否'].includes(session['開放填答'])) adminError('validation', '請選擇有效的狀態與填答設定。');
  return session;
}
function saveCourseSession(data) {
  const session = validCourseSession(data.session), { sh, values, headers } = courseSheetInfo();
  let row = null;
  if (data.mode === 'update') {
    row = Number(data.row);
    if (!Number.isSafeInteger(row) || row < 2 || row > values.length) adminError('conflict', '場次已移動或移除，請重新載入清單後再編輯。');
    const current = sheetObject(headers, values[row - 1]);
    if (recordVersion(current, row) !== data.version) adminError('conflict', '其他人已修改此場次，請重新載入清單，再按「編輯」確認最新內容。');
    if (session['場次ID'] !== String(valueOrEmpty(current['場次ID'])).trim() || session['課程'] !== String(valueOrEmpty(current['課程'])).trim()) adminError('validation', '既有場次的ID與課程不可更改；請新增場次並將原場次設為取消。');
  } else if (data.mode !== 'create') adminError('validation', '不支援的儲存方式。');
  if (values.slice(1).some((r, i) => i + 2 !== row && String(r[headers.indexOf('場次ID')] || '').trim() === session['場次ID'])) adminError('validation', '場次ID已存在，請使用不同ID。');
  if (row) {
    const range = sh.getRange(row, 1, 1, headers.length), formulas = range.getFormulas()[0];
    range.setValues([headers.map((h, i) => COURSE_HEADERS.includes(h) ? session[h] : formulas[i] || values[row - 1][i])]);
  } else sh.appendRow(headers.map(h => COURSE_HEADERS.includes(h) ? session[h] : ''));
}

// 升級現有密碼表：只新增管理權限欄，不改密碼或登入紀錄，也不自動授權。
function setupCourseAdmin() {
  const sh = setupPasswordSheet(), width = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, width).getValues()[0];
  let column = headers.indexOf(ADMIN_HEADER) + 1;
  ensureSheetSize(sh, Math.max(1000, sh.getLastRow()), column || width + 1);
  if (!column) {
    column = width + 1;
    sh.getRange(1, column, 1, 1).setValues([[ADMIN_HEADER]]).setFontWeight('bold').setBackground('#1B1410').setFontColor('#FFD84D');
    if (sh.getLastRow() > 1) sh.getRange(2, column, sh.getLastRow() - 1, 1).setValues(Array.from({ length: sh.getLastRow() - 1 }, () => ['否']));
  }
  sh.getRange(2, column, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['是', '否'], true).setAllowInvalid(false).build());
  sh.getRange(1, column, 1, 1).setNote('只有「是」且密碼啟用的使用者能在儀表板新增或修改課程。預設「否」保留查看權限。');
  return sh;
}

// ---------- 密碼管理（沿用現有密碼與登入紀錄） ----------
function setupPasswordSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); let sh = ss.getSheetByName(PW_SHEET); if (sh) return sh;
  sh = ss.insertSheet(PW_SHEET, 0);
  sh.getRange(1, 1, 1, 5).setValues([['密碼', '使用者／備註', '啟用（是／否）', '最後登入時間', '登入次數']])
    .setFontWeight('bold').setBackground('#1B1410').setFontColor('#FFD84D');
  const defaultPw = 'csc' + Math.random().toString(36).slice(2, 8);
  sh.getRange(2, 1, 1, 5).setValues([[defaultPw, '預設密碼，請改成自己的', '是', '', 0]]);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('C2:C200').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['是', '否'], true).build());
  sh.setColumnWidths(1, 5, 160); sh.setFrozenRows(1);
  sh.getRange('G1').setValue('說明：每一列是一組可登入儀表板的密碼。新增密碼＝新增一列；暫停使用＝「啟用」改成「否」；D、E 欄會自動記錄。').setFontColor('#7D6A5C');
  return sh;
}
function archiveLapSheets() { archiveCourseSheets('腹腔鏡'); }
function archiveCourseSheets(course) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  ['前測', '後測'].forEach(phase => { const sh = ss.getSheetByName(`${course}_${phase}`); if (sh) sh.setName(`${course}_${phase}_舊版_${stamp}`); });
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
