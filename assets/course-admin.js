/* Administration credentials and session tokens stay in memory, never browser storage. */
window.CourseAdmin = (() => {
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let url, onData, onExit, token = '', expiryTimer, busy = false, records = [], editing = null, pending = null, newSuffix;

  function notice(message, kind = 'success') {
    el('adminMessage').textContent = message; el('adminMessage').dataset.kind = kind; el('adminMessage').hidden = !message;
  }
  function buttons() {
    el('adminOpen').textContent = token ? '課程管理' : '管理者登入';
    el('adminSessionStatus').textContent = token ? '管理者已登入・登入有效時間 30 分鐘' : '請使用具有課程管理權限的密碼';
    el('adminLogout').hidden = !token;
    el('adminLoginForm').hidden = !!token; el('adminWorkspace').hidden = !token;
  }
  function setBusy(value) {
    busy = value;
    el('adminDialog').setAttribute('aria-busy', String(value));
    el('adminDialog').querySelectorAll('button,input,select').forEach(control => { control.disabled = value; });
    if (!value) el('adminCourse').disabled = !!editing;
  }
  function invalidate(message) {
    token = ''; clearTimeout(expiryTimer); pending = null; buttons();
    if (message) notice(message, 'error');
  }
  function handleError(error) {
    if (error.code === 'admin-auth') invalidate(error.message);
    else notice(error.message || '目前無法連線，請稍後重試。', 'error');
  }
  async function request(params, signal) {
    const endpoint = new URL(url);
    Object.entries(params).forEach(([key, value]) => endpoint.searchParams.set(key, value));
    const response = await fetch(endpoint, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('目前無法連線，請稍後重試。');
    const result = await response.json();
    if (!result || typeof result.ok !== 'boolean') throw new Error('課程管理服務尚未更新，請聯絡管理者。');
    if (!result.ok) { const error = new Error(result.message || '課程管理服務無法完成操作。'); error.code = result.error; throw error; }
    return result;
  }
  async function postAndConfirm(payload, action, requestId) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, requestId }), signal: controller.signal });
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await request({ action, requestId, ...(payload.adminToken ? { adminToken: payload.adminToken } : {}) }, controller.signal);
        if (result.received) return result;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('尚未確認完成，請稍後重試或重新載入清單確認。');
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('連線逾時，請稍後重試或重新載入清單確認。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function renderList() {
    const course = el('adminFilter').value;
    const shown = records.filter(r => !course || r.session['課程'] === course);
    el('adminRows').innerHTML = shown.length ? shown.map(r => `<tr><td><b>${esc(r.session['課程'])}</b><small>${esc(r.session['場次ID'])}</small></td><td data-label="上課日期">${esc(r.session['上課日期'])}<small>${esc(r.session['開始時間'])}</small></td><td data-label="學員人數">${r.session['學員人數'] === '' ? '待填' : esc(r.session['學員人數'])}</td><td data-label="狀態">${esc(r.session['狀態'])}<small>填答${r.session['開放填答'] === '是' && r.session['狀態'] !== '取消' ? '開放' : '關閉'}</small></td><td><button class="btn btn-ghost" type="button" data-admin-row="${r.row}">編輯</button></td></tr>`).join('')
      : '<tr><td colspan="5">目前沒有場次，按「新增場次」即可建立。</td></tr>';
    el('adminRows').querySelectorAll('[data-admin-row]').forEach(button => button.addEventListener('click', () => edit(records.find(r => r.row === Number(button.dataset.adminRow)))));
  }
  async function refresh() {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await request({ action: 'admin-catalog', adminToken: token }, controller.signal);
      if (!Array.isArray(result.records) || !result.data) throw new Error('課程管理服務尚未更新，請聯絡管理者。');
      records = result.records; renderList(); onData({ data: result.data }); return result;
    } catch (error) {
      if (error.code === 'admin-auth') invalidate(error.message);
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function generateID() {
    if (editing) return;
    const course = CourseSessions.COURSES.find(c => c.short === el('adminCourse').value), day = el('adminDate').value;
    el('adminID').value = course && day ? `${course.id}-${day.replace(/-/g, '')}-${newSuffix}` : '';
  }
  function edit(record) {
    editing = record || null; pending = null; newSuffix = crypto.randomUUID().slice(0, 8);
    const session = record?.session || { '課程': el('adminFilter').value || '心臟超音波', '狀態': '預定', '開放填答': '是' };
    for (const [id, header] of Object.entries({ adminID: '場次ID', adminCourse: '課程', adminDate: '上課日期', adminTime: '開始時間', adminStudents: '學員人數', adminState: '狀態', adminAllow: '開放填答' })) el(id).value = session[header] ?? '';
    el('adminCourse').disabled = !!editing;
    el('adminEditTitle').textContent = editing ? '修改課程場次' : '新增課程場次';
    el('adminSave').textContent = editing ? '儲存修改' : '建立場次';
    generateID(); notice('');
    if (record) el('adminEditForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function login(event) {
    event.preventDefault(); if (busy) return;
    const password = el('adminPassword').value.trim();
    if (!password) { notice('請輸入管理密碼。', 'error'); return; }
    notice(''); setBusy(true);
    try {
      const result = await postAndConfirm({ action: 'admin-login', password }, 'admin-login-result', crypto.randomUUID());
      if (!result.adminToken || !Number.isFinite(result.expiresAt)) throw new Error('課程管理服務尚未更新，請聯絡管理者。');
      token = result.adminToken; el('adminPassword').value = ''; buttons();
      clearTimeout(expiryTimer); expiryTimer = setTimeout(() => invalidate('管理者登入已過期，請重新登入；未儲存的內容仍保留。'), Math.max(0, result.expiresAt - Date.now()));
      await refresh();
      notice('已登入，可以新增或修改課程場次。');
    } catch (error) { handleError(error); }
    finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); if (busy) return;
    if (!token) { invalidate('請先登入管理者。'); return; }
    generateID();
    if (!el('adminEditForm').reportValidity()) return;
    const session = Object.fromEntries(Object.entries({ adminID: '場次ID', adminCourse: '課程', adminDate: '上課日期', adminTime: '開始時間', adminStudents: '學員人數', adminState: '狀態', adminAllow: '開放填答' }).map(([id, header]) => [header, el(id).value]));
    if (!session['場次ID']) { notice('請先選擇課程與上課日期。', 'error'); return; }
    const payload = { action: 'admin-save', adminToken: token, mode: editing ? 'update' : 'create',
      ...(editing ? { row: editing.row, version: editing.version } : {}), session };
    const key = JSON.stringify(payload);
    if (!pending || pending.key !== key) pending = { key, requestId: crypto.randomUUID() };
    notice(''); setBusy(true); let saved = false;
    try {
      await postAndConfirm(payload, 'admin-receipt', pending.requestId);
      saved = true; pending = null; await refresh(); edit(null);
      notice('已儲存，課程清單與總覽已更新。');
    } catch (error) {
      handleError(error);
      if (saved) notice('場次已儲存，但目前無法重新載入清單；請稍後重新載入確認。', 'error');
    } finally { setBusy(false); }
  }
  function logout(notify = true) {
    const previous = token;
    invalidate(''); records = []; edit(null); el('adminPassword').value = '';
    if (previous) {
      fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'admin-logout', adminToken: previous }) }).catch(() => {});
      if (notify) onExit();
    }
  }
  function open() {
    const dialog = el('adminDialog'); if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('admin-dialog-open');
    if (!token) el('adminPassword').focus();
  }
  function init(options) {
    ({ url, onData, onExit } = options);
    const courseOptions = CourseSessions.COURSES.map(c => new Option(c.short, c.short));
    courseOptions.forEach(option => el('adminCourse').add(option));
    CourseSessions.COURSES.forEach(c => el('adminFilter').add(new Option(c.short, c.short)));
    ['adminOpen', 'adminEntry'].forEach(id => el(id).addEventListener('click', open));
    el('adminClose').addEventListener('click', () => el('adminDialog').close());
    el('adminDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    el('adminDialog').addEventListener('close', () => document.documentElement.classList.remove('admin-dialog-open'));
    el('adminLoginForm').addEventListener('submit', login); el('adminEditForm').addEventListener('submit', save);
    el('adminLogout').addEventListener('click', () => logout());
    el('adminNew').addEventListener('click', () => { edit(null); el('adminEditForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    el('adminCancelEdit').addEventListener('click', () => edit(null));
    el('adminFilter').addEventListener('change', renderList);
    ['adminCourse', 'adminDate'].forEach(id => { el(id).addEventListener('change', generateID); el(id).addEventListener('input', generateID); });
    el('adminRefresh').addEventListener('click', async () => {
      setBusy(true); try { await refresh(); notice('清單已重新載入；正在編輯的內容仍保留。'); } catch (error) { handleError(error); } finally { setBusy(false); }
    });
    edit(null); buttons();
  }
  return { init, logout, refresh, isAuthenticated: () => !!token };
})();
