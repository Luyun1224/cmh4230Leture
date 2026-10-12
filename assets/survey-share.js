/* QR generation stays local; the poster contains only the public survey URL. */
window.SurveyShare = (() => {
  const PUBLIC_BASE = 'https://luyun1224.github.io/cmh4230Leture/';
  let phase, course = null, qr, url;
  const el = id => document.getElementById(id);

  function drawQR(canvas, code, cell) {
    const count = code.getModuleCount(), quiet = 4;
    canvas.width = canvas.height = (count + quiet * 2) * cell;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
      }
    }
  }

  function selectCourse(selected) {
    course = selected;
    url = new URL(phase === 'pre' ? 'pretest.html' : 'posttest.html', PUBLIC_BASE);
    if (course) url.searchParams.set('course', course.id);
    qr = qrcode(0, 'M');
    qr.addData(url.href);
    qr.make();
    drawQR(el('shareQR'), qr, 8);
    el('shareCourse').textContent = course ? course.name : '所有課程・掃描後選擇課程';
    el('shareQR').setAttribute('aria-label', `${course ? course.name : '模擬課程'}${phase === 'pre' ? '前測' : '後測'}填答 QR Code`);
    el('shareOpen').href = el('shareURL').href = url.href;
    el('shareURL').textContent = url.href;
    el('shareStatus').textContent = '';
  }

  // Wrap the public URL by character so long course links fit on the poster.
  function centeredLines(ctx, text, y, maxWidth, lineHeight) {
    let line = '';
    for (const char of text) {
      if (ctx.measureText(line + char).width > maxWidth && line) {
        ctx.fillText(line, 620, y); y += lineHeight; line = '';
      }
      line += char;
    }
    ctx.fillText(line, 620, y);
  }

  async function downloadPoster() {
    const button = el('shareDownload');
    button.disabled = true;
    el('shareStatus').textContent = '正在製作海報…';
    // Capture the selection before waiting for fonts.
    const posterQR = qr, posterURL = url.href, posterCourse = course;
    try {
      if (document.fonts) await document.fonts.ready;
      const canvas = document.createElement('canvas');
      canvas.width = 1240; canvas.height = 1754;
      const ctx = canvas.getContext('2d');
      const pre = phase === 'pre';
      const accent = pre ? '#F2661B' : '#14805A';
      ctx.fillStyle = pre ? '#FFF7EC' : '#F4FAF3'; ctx.fillRect(0, 0, 1240, 1754);
      ctx.fillStyle = accent; ctx.fillRect(0, 0, 1240, 430);
      ctx.strokeStyle = '#1B1410'; ctx.lineWidth = 10; ctx.strokeRect(35, 35, 1170, 1684);
      ctx.textAlign = 'center';
      const font = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#fff'; ctx.font = `700 38px ${font}`;
      ctx.fillText('奇美醫院 臨床技能中心', 620, 140);
      ctx.fillStyle = '#FFD84D'; ctx.font = `900 86px ${font}`;
      ctx.fillText(`模擬課程${pre ? '前測' : '後測'}`, 620, 280);
      ctx.fillStyle = '#fff'; ctx.font = `700 32px ${font}`;
      ctx.fillText(pre ? '課前暖身・一起在模擬中變強！' : '課後回饋・讓下一堂課更好！', 620, 365);
      ctx.fillStyle = '#1B1410'; ctx.font = `900 48px ${font}`;
      centeredLines(ctx, posterCourse ? posterCourse.name : '請選擇今天的課程', 545, 1080, 64);
      const qrCanvas = document.createElement('canvas');
      const cell = Math.floor(780 / (posterQR.getModuleCount() + 8));
      drawQR(qrCanvas, posterQR, cell);
      ctx.drawImage(qrCanvas, (1240 - qrCanvas.width) / 2, 640);
      ctx.fillStyle = '#1B1410'; ctx.font = `900 52px ${font}`;
      ctx.fillText('手機掃描 QR Code 即可填答', 620, 1490);
      ctx.font = `400 27px ${font}`;
      centeredLines(ctx, posterURL, 1560, 1050, 38);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG export failed');
      const objectURL = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectURL;
      link.download = `模擬課程_${pre ? '前測' : '後測'}_${posterCourse ? posterCourse.short : '所有課程'}_海報.png`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
      el('shareStatus').textContent = '海報已下載，可列印或分享。';
    } catch (error) {
      el('shareStatus').textContent = '海報下載失敗，請稍後再試。';
    } finally {
      button.disabled = false;
    }
  }

  function init(options) {
    phase = options.phase;
    el('shareTitle').textContent = `${phase === 'pre' ? '前測' : '後測'}填答 QR Code`;
    el('shareDownload').addEventListener('click', downloadPoster);
    selectCourse(null);
  }
  return { init, selectCourse };
})();
