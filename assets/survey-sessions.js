window.SurveySessions = (() => {
  // 問卷永遠開放：清單上沒有的上課日期，學員可自行選日期送出。
  const MANUAL = '__date';
  let catalog = [], loaded = false, failed = false, autoPicked = false, course = null, onSelect = () => {};
  let pending = null;
  const el = id => document.getElementById(id);
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
  function selected() {
    if (!course) return null;
    if (el('sessionSelect').value === MANUAL) {
      const date = CourseSessions.date(el('sessionDate').value);
      return date ? { id: '', course: course.id, date, time: '', manual: true } : null;
    }
    return catalog.find(s => s.id === el('sessionSelect').value && s.course === course.id) || null;
  }
  function nearest(options) {
    const day = today();
    return options.find(s => s.date >= day) || options[options.length - 1];
  }
  function render() {
    const select = el('sessionSelect'), previous = autoPicked ? '' : select.value;
    const options = catalog.filter(s => s.course === course?.id && s.open && s.status !== '取消');
    select.replaceChildren(new Option('請選擇上課日期', ''));
    // 只顯示日期；同一天有兩場時才補上開始時間區分。
    options.forEach(s => select.add(new Option(options.some(o => o !== s && o.date === s.date) && s.time ? `${s.date} ${s.time}` : s.date, s.id)));
    select.add(new Option(options.length ? '清單上沒有我的上課日期（自行選擇日期）' : '選擇上課日期', MANUAL));
    const linked = new URLSearchParams(location.search).get('session') || '';
    select.value = previous || linked;
    if (select.selectedIndex < 0) select.value = '';
    // 不讓學員卡在空白選項：自動帶入最可能的上課日期（今天、下一場、否則最近一場）；
    // 清單沒有場次或載入失敗時改為自行選日期（預設今天）。自動帶入的值之後仍讓連結指定的場次優先。
    autoPicked = !select.value && !!course && (loaded || failed);
    if (autoPicked) select.value = options.length ? nearest(options).id : MANUAL;
    select.disabled = !course;
    el('sessionError').hidden = true;
    el('sessionDateWrap').hidden = select.value !== MANUAL;
    if (!el('sessionDate').value) el('sessionDate').value = today();
    el('sessionHint').textContent = !loaded ? '場次清單載入中；也可以直接選「自行選擇日期」填寫。'
      : options.length ? '已自動帶入最近的上課日期；若不是你上課那天，請改選。' : '請選擇實際上課的日期。';
    if (linked && loaded && course && select.value !== linked) el('sessionHint').textContent = '連結指定的場次已不在清單上，請直接選擇上課日期。';
    onSelect(selected());
  }
  async function load(url) {
    loaded = false; failed = false; render();
    try {
      const endpoint = new URL(url); endpoint.searchParams.set('action', 'sessions');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      let result;
      try { const response = await fetch(endpoint, { signal: controller.signal }); if (!response.ok) throw new Error('HTTP'); result = await response.json(); }
      finally { clearTimeout(timer); }
      if (!result.ok || !Array.isArray(result.sessions)) throw new Error('sessions');
      const parsed = CourseSessions.read(result.sessions);
      catalog = parsed.sessions; loaded = true; render();
    } catch (error) {
      catalog = []; loaded = false; failed = true; render();
      el('sessionHint').textContent = '場次清單載入失敗，可按「重新載入場次」，或直接選「自行選擇日期」填寫。';
    }
  }
  function init({ url, changed }) {
    onSelect = changed;
    const wrap = document.createElement('div');
    wrap.id = 'sessionDateWrap'; wrap.className = 'textin'; wrap.hidden = true; wrap.style.marginTop = '12px';
    wrap.innerHTML = '<label for="sessionDate" style="display:block;margin-bottom:6px">上課日期</label><input type="date" id="sessionDate" style="width:100%;padding:12px;font:inherit">';
    el('sessionSelect').closest('.textin').after(wrap);
    const changedSelection = () => { autoPicked = false; el('sessionError').hidden = true; el('sessionDateWrap').hidden = el('sessionSelect').value !== MANUAL; onSelect(selected()); };
    el('sessionSelect').addEventListener('change', changedSelection);
    el('sessionDate').addEventListener('change', changedSelection);
    el('sessionRetry').addEventListener('click', () => load(url));
    load(url);
  }
  function selectCourse(c) { course = c; el('sessionCard').hidden = false; render(); }
  function requireSelection() {
    if (selected()) return selected();
    el('sessionError').hidden = false; el('sessionCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    el('sessionSelect').focus(); return null;
  }
  // 送出只在後台確認收件後才算成功：先直接讀 GAS 回應（一趟完成）；
  // 讀不到回應時改用收件識別碼查詢，相同識別碼重送不會重複寫入。
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const reason = text => String(text || '').replace(/^Error:\s*/, '');
  class Rejected extends Error {}
  async function timed(resource, options, ms) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(resource, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
  }
  async function receipt(url, token) {
    const endpoint = new URL(url); endpoint.searchParams.set('action', 'receipt'); endpoint.searchParams.set('token', token);
    const result = await (await timed(endpoint, {}, 8000)).json();
    if (!result.ok) throw new Rejected(reason(result.error) || '問卷未能寫入。');
    return result.received;
  }
  async function send(url, payload) {
    const comparable = { ...payload.row }; delete comparable['時間戳記'];
    const key = JSON.stringify({ sheet: payload.sheet, row: comparable });
    if (!pending || pending.key !== key) pending = { key, token: crypto.randomUUID() };
    const token = pending.token, body = JSON.stringify({ ...payload, receiptToken: token });
    const post = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body };
    try {
      const result = await (await timed(url, post, 15000)).json();
      if (result.ok) { pending = null; return; }
      throw new Rejected(reason(result.error) || '問卷未能寫入。');
    } catch (error) { if (error instanceof Rejected) throw error; }
    // 直接回應讀不到（網路不穩或瀏覽器阻擋）：確認是否已收到，沒有就再送一次後確認。
    try { if (await receipt(url, token)) { pending = null; return; } } catch (error) { if (error instanceof Rejected) throw error; }
    try { await timed(url, { ...post, mode: 'no-cors' }, 15000); } catch (error) { /* 以收件查詢為準 */ }
    for (let i = 0; i < 4; i++) {
      try { if (await receipt(url, token)) { pending = null; return; } } catch (error) { if (error instanceof Rejected) throw error; }
      await wait(1000);
    }
    throw new Error('目前無法確認後台是否收到問卷，可能是網路不穩。');
  }
  return { init, selectCourse, selected, requireSelection, send };
})();
