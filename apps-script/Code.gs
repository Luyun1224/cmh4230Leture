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

// 僅接受八張問卷工作表，防止問卷寫入課程清單或密碼管理。
function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false, token = '';
  try {
    lock.waitLock(20000); locked = true;
    const data = JSON.parse(e.postData.contents);
    token = String(data.receiptToken || '');
    if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error('收件識別碼格式錯誤');
    const previous = CacheService.getScriptCache().get('receipt:' + token);
    if (previous && JSON.parse(previous).ok) return json({ ok: true });
    const name = String(data.sheet || '');
    const match = name.match(/^(心臟超音波|內視鏡|腹部超音波|腹腔鏡)_(前測|後測)$/);
    if (!match) throw new Error('不允許的工作表名稱');
    const row = data.row;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('問卷格式錯誤');
    const sessionID = String(row['場次ID'] || '').trim();
    const session = courseSessions().find(s => s['場次ID'] === sessionID && s['課程'] === match[1]);
    if (!session || session['狀態'] === '取消' || session['開放填答'] !== '是') throw new Error('場次不存在或未開放填答');
    // 以清單為準；時間戳記仍記錄實際收到問卷的時間。
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
  // 不透明的隨機識別碼，只回傳收件狀態，避免 no-cors POST 被拒仍顯示成功。
  if (p.action === 'receipt') {
    const token = String(p.token || '');
    if (!/^[a-f0-9-]{36}$/i.test(token)) return json({ ok: false, error: '收件識別碼格式錯誤' });
    const receipt = CacheService.getScriptCache().get('receipt:' + token);
    return json(receipt ? { ...JSON.parse(receipt), received: true } : { ok: true, received: false });
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
  const only = p.sheet, out = {};
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(sh => {
    const name = sh.getName();
    if (name === PW_SHEET || (only && name !== only)) return;
    out[name] = sheetRows(sh);
  });
  return json({ ok: true, data: out });
}

function sheetRows(sh) {
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  const h = v[0].map(String);
  return v.slice(1).filter(r => r.some(c => c !== '' && c !== null))
    .map(r => Object.fromEntries(h.map((k, i) => {
      const c = r[i];
      // Sheet 時間欄可能回傳 Date，保留 HH:mm 而非 1899 年日期。
      const format = k === '開始時間' ? 'HH:mm' : k === '上課日期' ? 'yyyy-MM-dd' : 'yyyy/MM/dd HH:mm:ss';
      return [k, c instanceof Date ? Utilities.formatDate(c, TZ, format) : c];
    })));
}

function courseSessions() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COURSE_SHEET);
  if (!sh) throw new Error('請先執行 setupCourseSheet 並建立課程清單');
  const rows = sheetRows(sh), counts = {};
  rows.forEach(r => { const id = String(r['場次ID'] || '').trim(); counts[id] = (counts[id] || 0) + 1; });
  return rows.map(r => ({ ...r, '場次ID': String(r['場次ID'] || '').trim(), '課程': String(r['課程'] || '').trim(),
    '上課日期': courseDay(r['上課日期']), '開始時間': String(r['開始時間'] || '').trim(),
    '狀態': String(r['狀態'] || '').trim(), '開放填答': String(r['開放填答'] || '').trim() }))
    .filter(r => r['場次ID'] && counts[r['場次ID']] === 1 && COURSE_NAMES.includes(r['課程']) && r['上課日期']
      && ['預定', '已開課', '取消'].includes(r['狀態']));
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
  sh.getRange('G1').setNote('「是」可填前後測，不受填答日期限制；「否」停止新填答，既有資料仍參與分析。');
  return sh;
}

// ---------- 密碼管理（沿用現有密碼與登入紀錄） ----------
function checkPassword(pw) {
  pw = String(pw || '').trim(); if (!pw) return false;
  const sh = setupPasswordSheet(), last = sh.getLastRow(); if (last < 2) return false;
  const rows = sh.getRange(2, 1, last - 1, 5).getValues();
  for (let i = 0; i < rows.length; i++) {
    const [p, , on, , cnt] = rows[i];
    const enabled = String(on).trim() === '' || /^(是|y|yes|true|啟用|1)$/i.test(String(on).trim());
    if (String(p).trim() === pw && enabled) {
      sh.getRange(i + 2, 4, 1, 2).setValues([[Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss'), (Number(cnt) || 0) + 1]]);
      return true;
    }
  }
  return false;
}
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
