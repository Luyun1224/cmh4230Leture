/* Public links and printable artwork are generated locally, without survey answers. */
window.SurveyShare = (() => {
  const PUBLIC_BASE = 'https://luyun1224.github.io/cmh4230Leture/';
  const INK = '#1B1410', YELLOW = '#FFD84D';
  const FONT = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
  const el = id => document.getElementById(id);
  let phase, course = null, qr, url;

  function selectCourse(selected) {
    course = selected;
    url = new URL(phase === 'pre' ? 'pretest.html' : 'posttest.html', PUBLIC_BASE);
    if (course) url.searchParams.set('course', course.id);
    qr = qrcode(0, 'M'); qr.addData(url.href); qr.make();
    el('shareOpen').href = url.href;
    el('sharePoster').setAttribute('aria-label', `${course ? course.name : '所有課程'}${phase === 'pre' ? '前測' : '後測'}海報，掃描 QR Code 填寫，約 3 分鐘，記名填答。`);
    el('shareStatus').textContent = '';
    if (el('shareDialog').open) renderPoster();
  }

  function rounded(ctx, x, y, width, height, radius, fill, stroke, lineWidth = 8) {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) {ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();}
  }

  function ribbon(ctx, color, points) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 6) ctx.bezierCurveTo(...points.slice(i, i + 6));
    ctx.closePath(); ctx.fill();
  }

  function headline(ctx, text, y, size, fill) {
    ctx.save(); ctx.translate(620, y); ctx.transform(1, 0, -.12, 1, 0, 0);
    ctx.textAlign = 'center'; ctx.font = `900 ${size}px ${FONT}`;
    ctx.lineJoin = 'round'; ctx.lineWidth = 27; ctx.strokeStyle = INK;
    ctx.strokeText(text, 9, 14); ctx.strokeText(text, 0, 0);
    ctx.fillStyle = fill; ctx.fillText(text, 0, 0); ctx.restore();
  }

  function renderPoster() {
    const canvas = el('sharePoster'), ctx = canvas.getContext('2d');
    canvas.width = 1240; canvas.height = 1754;
    const pre = phase === 'pre';
    const accent = pre ? '#F2661B' : '#14805A';
    const ground = pre ? '#F2661B' : '#0F4D36';
    const deep = pre ? '#E3550D' : '#0B3F2C';
    const paper = pre ? '#FFF7EC' : '#F4FAF3';
    ctx.fillStyle = ground; ctx.fillRect(0, 0, 1240, 1754);
    // Keep the surveys' orange/green comic palette and bold sticker outlines.
    for (let i = 0; i < 90; i++) {
      const angle = i * Math.PI * 2 / 90;
      ctx.beginPath(); ctx.moveTo(620, 80);
      ctx.lineTo(620 + Math.cos(angle) * 2500, 80 + Math.sin(angle) * 2500);
      ctx.lineTo(620 + Math.cos(angle + .035) * 2500, 80 + Math.sin(angle + .035) * 2500);
      ctx.closePath(); ctx.fillStyle = deep; ctx.fill();
    }
    ctx.fillStyle = INK; ctx.fillRect(0, 1435, 1240, 319);
    ctx.strokeStyle = '#453B32'; ctx.lineWidth = 1;
    for (let x = 0; x <= 1240; x += 55) {ctx.beginPath(); ctx.moveTo(x, 1435); ctx.lineTo(x, 1754); ctx.stroke();}
    for (let y = 1435; y <= 1754; y += 55) {ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1240, y); ctx.stroke();}
    ribbon(ctx, YELLOW, [0,350, 320,520,100,800,390,1070, 500,1230,440,1520,525,1754, 310,1754,190,1754,80,1754, 160,1260,-130,1050,0,350]);
    ribbon(ctx, paper, [0,0, 90,0,155,0,170,0, 115,160,190,380,70,420, -40,450,15,200,0,0]);
    ribbon(ctx, paper, [0,900, 185,1060,130,1300,265,1480, 320,1590,295,1660,335,1754, 260,1754,220,1754,185,1754, 140,1480,-60,1250,0,900]);
    ribbon(ctx, YELLOW, [1000,0, 1110,0,1190,0,1240,0, 1240,100,1240,210,1240,300, 1030,530,1080,180,1000,0]);
    ribbon(ctx, paper, [1240,360, 1060,520,1040,560,970,665, 800,960,930,1250,790,1440, 695,1560,745,1640,720,1754, 840,1754,920,1754,970,1754, 970,1330,1320,1200,1240,360]);
    ribbon(ctx, YELLOW, [1240,900, 1110,1000,1110,1180,1020,1390, 930,1560,960,1640,915,1754, 990,1754,1040,1754,1080,1754, 1110,1490,1280,1480,1240,900]);

    ctx.textAlign = 'center';
    ctx.save(); ctx.translate(620, 170); ctx.rotate(-.08);
    rounded(ctx, -178, -78, 356, 140, 70, INK, INK);
    rounded(ctx, -190, -90, 356, 140, 70, INK, '#fff', 7);
    ctx.font = `900 60px ${FONT}`; ctx.fillStyle = YELLOW;
    const year = Number(new Intl.DateTimeFormat('en', {year:'numeric', timeZone:'Asia/Taipei'}).format(new Date())) - 1911;
    ctx.fillText(`${year} 年度`, -12, 3); ctx.restore();
    headline(ctx, '臨床技能中心', 395, 145, '#fff');
    headline(ctx, `模擬課程${phase === 'pre' ? '前測' : '後測'}`, 550, 128, YELLOW);
    // Keep the QR's four-module white quiet zone clear of the artwork.
    rounded(ctx, 291, 697, 700, 776, 38, INK);
    rounded(ctx, 274, 680, 700, 776, 38, '#fff', INK, 10);
    const count = qr.getModuleCount(), cell = Math.floor(610 / (count + 8));
    const size = (count + 8) * cell, x = Math.round((1240 - size) / 2), y = 718;
    ctx.fillStyle = INK;
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect(x + (col + 4) * cell, y + (row + 4) * cell, cell, cell);
    }
    ctx.font = `900 48px ${FONT}`; ctx.fillText('掃描 QR Code 填寫', 624, 1330);
    ctx.font = `700 40px ${FONT}`; ctx.fillText('約 3 分鐘・記名填答', 624, 1394);
    // Course label sits between the headline and QR card.
    rounded(ctx, 305, 589, 630, 67, 32, accent, INK, 5);
    ctx.fillStyle = '#fff'; ctx.font = `700 35px ${FONT}`;
    ctx.fillText(course ? course.name : '所有課程・掃描後選擇', 620, 635);
    ctx.save(); ctx.translate(620, 1620); ctx.rotate(.018);
    rounded(ctx, -458, -54, 932, 100, 30, INK);
    rounded(ctx, -474, -67, 932, 100, 30, '#fff', INK, 7);
    ctx.fillStyle = INK; ctx.font = `900 35px ${FONT}`;
    ctx.fillText('奇美醫院 教學部 臨床技能中心', -8, -4); ctx.restore();
    // A small pointer illustration echoes the invitation to scan.
    ctx.save(); ctx.translate(1070, 1480); ctx.rotate(-.1);
    ctx.beginPath(); ctx.moveTo(-45,-70); ctx.lineTo(-45,75); ctx.lineTo(-5,42);
    ctx.lineTo(30,105); ctx.lineTo(64,88); ctx.lineTo(30,29); ctx.lineTo(82,29); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
  }

  function openPoster() {
    renderPoster();
    el('shareDialog').showModal();
    document.documentElement.classList.add('share-modal-open');
    // Redraw with the site's fonts when available; the initial preview opens immediately.
    if (document.fonts) document.fonts.ready.then(() => {if (el('shareDialog').open) renderPoster();});
  }

  async function downloadPoster() {
    const button = el('shareDownload'); button.disabled = true;
    const filename = `模擬課程_${phase === 'pre' ? '前測' : '後測'}_${course ? course.short : '所有課程'}_海報.png`;
    try {
      const blob = await new Promise(resolve => el('sharePoster').toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG export failed');
      const objectURL = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = objectURL; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
      el('shareStatus').textContent = '海報已儲存，可列印或分享。';
    } catch (error) {el('shareStatus').textContent = '圖片儲存失敗，請稍後再試。';}
    finally {button.disabled = false;}
  }

  function printPoster() {
    const frame = document.createElement('iframe');
    frame.title = '海報列印'; frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;bottom:0;left:0';
    frame.onload = () => {
      const win = frame.contentWindow;
      win.addEventListener('afterprint', () => frame.remove(), {once:true});
      const image = win.document.querySelector('img');
      const print = () => {win.focus(); win.print();};
      if (image.complete) print(); else image.onload = print;
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc = `<!doctype html><html lang="zh-Hant"><head><title>模擬課程填答海報</title><style>@page{size:A4 portrait;margin:0}html,body{margin:0}img{display:block;width:210mm;height:297mm;object-fit:contain}@media screen{img{width:100%;height:auto}}</style></head><body><img alt="問卷填答海報" src="${el('sharePoster').toDataURL('image/png')}"></body></html>`;
    document.body.appendChild(frame);
  }

  function init(options) {
    phase = options.phase;
    el('shareTitle').textContent = `${phase === 'pre' ? '前測' : '後測'}填答海報`;
    el('shareShow').addEventListener('click', openPoster);
    el('shareClose').addEventListener('click', () => el('shareDialog').close());
    el('shareDialog').addEventListener('close', () => {
      document.documentElement.classList.remove('share-modal-open'); el('shareShow').focus();
    });
    el('shareDialog').addEventListener('click', event => {
      if (event.target !== el('shareDialog')) return;
      const rect = el('shareDialog').getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) el('shareDialog').close();
    });
    el('shareDownload').addEventListener('click', downloadPoster);
    el('sharePrint').addEventListener('click', printPoster);
    selectCourse(null);
  }
  return {init, selectCourse};
})();
