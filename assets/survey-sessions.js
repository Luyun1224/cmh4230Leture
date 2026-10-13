window.SurveySessions = (() => {
  let catalog = [], loaded = false, course = null, onSelect = () => {};
  let pending = null;
  const el = id => document.getElementById(id);
  function selected() { return catalog.find(s => s.id === el('sessionSelect').value && s.course === course?.id) || null; }
  function render() {
    const select = el('sessionSelect'), previous = select.value;
    select.replaceChildren(new Option('請選擇上課場次', ''));
    catalog.filter(s => s.course === course?.id && s.open && s.status !== '取消').forEach(s => select.add(new Option(CourseSessions.label(s), s.id)));
    const linked = new URLSearchParams(location.search).get('session') || '';
    select.value = previous || linked;
    select.disabled = !loaded || !course;
    el('sessionError').hidden = true;
    el('sessionHint').textContent = !loaded ? '正在載入場次…' : select.options.length === 1
      ? '目前沒有開放填答的場次，請聯絡課程管理者。' : '請選擇實際上課的場次；提前填寫前測也請選這一場。';
    if (linked && !selected() && loaded && course) el('sessionHint').textContent = '連結指定的場次未開放或不屬於此課程，請確認上課場次後再選擇。';
    onSelect(selected());
  }
  async function load(url) {
    loaded = false; render();
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
      catalog = []; loaded = false;
      el('sessionSelect').disabled = true;
      el('sessionHint').textContent = '場次清單載入失敗，請重試；若持續失敗，請聯絡課程管理者確認清單與服務部署。';
      onSelect(null);
    }
  }
  function init({ url, changed }) {
    onSelect = changed;
    el('sessionSelect').addEventListener('change', () => { el('sessionError').hidden = true; onSelect(selected()); });
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
