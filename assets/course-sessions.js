/* Shared course registry rules. Survey timestamps never identify a class. */
window.CourseSessions = (() => {
  const SHEET = '課程清單';
  const COURSES = [
    { id: 'echo', short: '心臟超音波', name: '心臟超音波課程' },
    { id: 'endo', short: '內視鏡', name: '內視鏡模擬課程' },
    { id: 'abd', short: '腹部超音波', name: '腹部超音波課程' },
    { id: 'lap', short: '腹腔鏡', name: '腹腔鏡課程' },
  ];
  const text = v => String(v ?? '').trim();
  function date(v) {
    const m = text(v).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:$|[ T])/);
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  function read(rows = []) {
    const issues = [], ids = new Map();
    const sessions = rows.map((r, i) => {
      const course = COURSES.find(c => [c.id, c.short, c.name].includes(text(r['課程'])));
      const id = text(r['場次ID']), day = date(r['上課日期']), status = text(r['狀態']);
      const rawCount = text(r['學員人數']), count = rawCount === '' ? null : Number(rawCount);
      const session = { id, course: course?.id, date: day, time: text(r['開始時間']), status,
        count: count != null && Number.isSafeInteger(count) && count >= 0 ? count : null,
        open: text(r['開放填答']) === '是', valid: !!id && !!course && !!day && ['預定', '已開課', '取消'].includes(status) };
      if (id) ids.set(id, (ids.get(id) || 0) + 1);
      if (!session.valid) issues.push(`第 ${i + 2} 列：請檢查場次ID、課程、日期與狀態。`);
      if (rawCount !== '' && session.count == null) issues.push(`第 ${i + 2} 列：學員人數須為非負整數。`);
      return session;
    });
    sessions.forEach(s => { if (ids.get(s.id) > 1) s.valid = false; });
    [...ids].filter(([, n]) => n > 1).forEach(([id]) => issues.push(`場次ID「${id}」重複，請使用唯一 ID。`));
    return { sessions: sessions.filter(s => s.valid).sort((a, b) => `${a.date} ${a.time} ${a.id}`.localeCompare(`${b.date} ${b.time} ${b.id}`)), issues };
  }
  const label = s => `${s.date}${s.time ? ' ' + s.time : ''}｜${s.id}`;
  function resolve(row, sessions) {
    const id = text(row['場次ID']);
    if (id) return sessions.find(s => s.id === id) || null;
    const day = date(row['上課日期']);
    const matches = day ? sessions.filter(s => s.date === day) : [];
    return matches.length === 1 ? matches[0] : null;
  }
  function stats(sessions) {
    const held = sessions.filter(s => s.status === '已開課');
    return { held: held.length, planned: sessions.filter(s => s.status === '預定').length,
      students: held.reduce((n, s) => n + (s.count ?? 0), 0), missing: held.filter(s => s.count == null).length };
  }
  return { SHEET, COURSES, read, label, resolve, stats, date };
})();
