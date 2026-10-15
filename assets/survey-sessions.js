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
  async function send(url, payload) {
    const comparable = { ...payload.row }; delete comparable['時間戳記'];
    const key = JSON.stringify({ sheet: payload.sheet, row: comparable });
    if (!pending || pending.key !== key) pending = { key, token: crypto.randomUUID() };
    const token = pending.token;
    const body = JSON.stringify({ ...payload, receiptToken: token });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, signal: controller.signal });
      for (let i = 0; i < 6; i++) {
        const endpoint = new URL(url); endpoint.searchParams.set('action', 'receipt'); endpoint.searchParams.set('token', token);
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error('目前無法確認問卷收件，請稍後重試。');
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || '問卷未能寫入，請確認場次是否開放。');
        if (result.received) { pending = null; return; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('尚未確認收件，請稍後重試；相同答案重試會沿用收件識別碼。');
    } finally { clearTimeout(timer); }
  }
  return { init, selectCourse, selected, requireSelection, send };
})();
