"""Browser regression checks with a local server and mocked Apps Script; no live writes."""
import functools
import json
import threading
import time
import copy
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def session(identifier, **changes):
    return {'場次ID': identifier, '課程': '心臟超音波', '上課日期': '2026-10-14', '開始時間': '09:00',
            '學員人數': 6, '狀態': '已開課', '開放填答': '是', **changes}

CATALOG = [session('echo-A'), session('echo-B', **{'開始時間': '13:00', '學員人數': 8}),
           session('echo-C', **{'上課日期': '2026-10-28', '狀態': '預定', '學員人數': 10}),
           session('echo-cancel', **{'狀態': '取消', '學員人數': 30}),
           session('echo-closed', **{'上課日期': '2026-09-01', '開放填答': '否', '學員人數': ''}),
           session('endo-A', **{'課程': '內視鏡', '學員人數': 0})]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

class BrowserChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}/'
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.errors = []; self.sent = []; self.reject = False; self.catalog_fail = False; self.dashboard_fail = False
        self.post_drop = 0; self.never_received = False; self.receipt_checks = 0
        self.admin_catalog = copy.deepcopy(CATALOG); self.admin_versions = [0] * len(CATALOG)
        self.admin_token = 'abcdef01-1234-4234-8234-123456789abc'; self.admin_expired = False
        self.admin_login_results = {}; self.admin_receipts = {}; self.manager_writes = []; self.read_urls = []
        self.admin_data = {'課程清單': copy.deepcopy(self.admin_catalog)}
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('https://fonts.googleapis.com/**', lambda r: r.abort())
        self.page.route('https://fonts.gstatic.com/**', lambda r: r.abort())
        self.page.route('https://script.google.com/**', self.backend)

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.context.close()

    def backend(self, route):
        request = route.request
        params = parse_qs(urlsplit(request.url).query)
        action = params.get('action', [''])[0]
        if request.method == 'GET': self.read_urls.append(request.url)
        if request.method == 'POST':
            payload = json.loads(request.post_data)
            if payload.get('action', '').startswith('admin-'):
                self.admin_post(payload)
                route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
                return
            if self.post_drop:
                # 模擬網路中斷：請求沒有送達後台。
                self.post_drop -= 1; route.abort(); return
            self.sent.append(payload)
            result = {'ok': not self.reject}
            if self.reject: result['error'] = 'Error: 場次不存在或未開放填答'
        elif action == 'admin-login-result':
            result = {**self.admin_login_results.get(params['requestId'][0], {'ok': True}), 'received': True}
        elif action.startswith('admin-'):
            if self.admin_expired or params.get('adminToken', [''])[0] != self.admin_token:
                result = {'ok': False, 'error': 'admin-auth', 'message': '管理者登入已過期，請重新登入。'}
            elif action == 'admin-catalog':
                result = {'ok': True, 'records': [{'row': i + 2, 'session': s, 'version': f'v{self.admin_versions[i]}'} for i, s in enumerate(self.admin_catalog)], 'data': self.admin_data}
            else:
                result = {**self.admin_receipts.get(params['requestId'][0], {'ok': True}), 'received': True}
        elif 'action=receipt' in request.url:
            self.receipt_checks += 1
            token = params.get('token', [''])[0]
            got = not self.never_received and any(p.get('receiptToken') == token for p in self.sent)
            result = {'ok': not self.reject, 'received': got}
            if self.reject: result['error'] = '場次不存在或未開放填答'
        elif not action:
            result = {'ok': False, 'error': 'Error: 暫時無法讀取'} if self.dashboard_fail else {'ok': True, 'data': {'課程清單': copy.deepcopy(CATALOG)}}
        elif self.catalog_fail:
            result = {'ok': False, 'error': '清單尚未建立'}
        else:
            # Public projection intentionally lacks student counts.
            result = {'ok': True, 'sessions': [{k: v for k, v in s.items() if k != '學員人數'} for s in CATALOG]}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(result))

    def admin_post(self, payload):
        if payload['action'] == 'admin-login':
            accepted = payload['password'] == 'test-admin'
            self.admin_login_results[payload['requestId']] = {'ok': True, 'adminToken': self.admin_token, 'expiresAt': int(time.time() * 1000) + 1800000} if accepted else {'ok': False, 'error': 'admin-auth', 'message': '密碼不正確、停用，或尚未開啟課程管理權限。'}
            if accepted: self.admin_expired = False
        elif payload['action'] == 'admin-logout':
            self.admin_expired = True
        elif payload['action'] == 'admin-save':
            if self.admin_expired: return
            identifier = payload['requestId']
            if self.admin_receipts.get(identifier, {}).get('ok'): return
            if payload['mode'] == 'update':
                index = payload['row'] - 2
                if payload['version'] != f'v{self.admin_versions[index]}':
                    self.admin_receipts[identifier] = {'ok': False, 'error': 'conflict', 'message': '其他人已修改此場次，請重新載入清單，再按「編輯」確認最新內容。'}
                    return
                self.admin_catalog[index] = payload['session']; self.admin_versions[index] += 1
            else:
                self.admin_catalog.append(payload['session']); self.admin_versions.append(0)
            self.manager_writes.append(payload)
            self.admin_data['課程清單'] = copy.deepcopy(self.admin_catalog)
            self.admin_receipts[identifier] = {'ok': True}

    def fill_answers(self):
        self.page.evaluate('''() => {
          for (const q of questions) {
            const el = document.getElementById(`q-${q.n}`);
            if (q.t === 'text' || q.t === 'area') el.querySelector('input,textarea').value = '測試學員';
            else if (q.t === 'likert') for (let r=0; r<q.items.length; r++) el.querySelector(`input[name="f${q.n}-r${r}"][value="4"]`).checked = true;
            else {
              const input = [...el.querySelectorAll('.chips input')].find(i => i.value !== '其他' && i.value !== q.follow?.when);
              if (input) input.checked = true;
            }
            const input = el.querySelector('input,textarea');
            if (input) input.dispatchEvent(new Event('change', {bubbles:true}));
          }
        }''')

    def test_survey_selection_validation_poster_and_confirmed_submission(self):
        for name in ['pretest.html', 'posttest.html']:
            with self.subTest(page=name):
                self.page.goto(self.base + name + '?course=echo')
                self.page.wait_for_function('!document.getElementById("sessionSelect").disabled')
                # 只顯示日期；同日兩場補上時間；最後一項為自行選日期。
                labels = self.page.locator('#sessionSelect option').all_inner_texts()
                self.assertEqual(labels[1:4], ['2026-10-14 09:00', '2026-10-14 13:00', '2026-10-28'])
                self.assertIn('自行選擇日期', labels[-1]); self.assertEqual(len(labels), 5)
                self.assertFalse(any('echo-' in t for t in labels))
                # 一開始就自動帶入日期，不會停在空白選項。
                self.assertNotEqual(self.page.locator('#sessionSelect').input_value(), '')
                self.page.locator('#sessionSelect').select_option('echo-A')
                self.page.locator('#submitBtn').click()
                self.assertTrue(self.page.locator('#formerr').is_visible())
                self.page.locator('#shareShow').click()
                self.assertTrue(self.page.locator('#shareDialog').is_visible())
                self.assertIn('session=echo-A', self.page.locator('#shareOpen').get_attribute('href'))
                self.assertTrue(self.page.locator('#sharePoster').evaluate('(c) => c.width===1240 && c.height===1754 && c.toDataURL().length>10000'))
                self.page.locator('#shareClose').click()
                self.fill_answers(); self.page.locator('#submitBtn').click()
                self.page.locator('#done').wait_for(state='visible')
                self.assertEqual(self.sent[-1]['row']['場次ID'], 'echo-A')
                self.assertEqual(self.sent[-1]['row']['上課日期'], '2026-10-14')
                self.assertEqual(len(self.sent[-1]['receiptToken']), 36)
                self.assertFalse(self.page.locator('#form').is_visible())
                self.sent.clear()

    def test_deep_link_failure_retry_and_wrong_course_are_safe(self):
        self.catalog_fail = True
        self.page.goto(self.base + 'pretest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionHint").textContent.includes("載入失敗")')
        self.assertEqual(self.page.locator('#sessionSelect').input_value(), '__date')
        self.page.locator('#submitBtn').click(); self.assertEqual(self.sent, [])
        self.catalog_fail = False; self.page.locator('#sessionRetry').click()
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.page.locator('[data-id="endo"]').click()
        self.assertEqual(self.page.locator('#sessionSelect').input_value(), 'endo-A')
        self.assertNotIn('session=echo-A', self.page.locator('#shareOpen').get_attribute('href'))
        self.page.goto(self.base + 'pretest.html?course=echo&session=echo-cancel')
        self.page.wait_for_function('!document.getElementById("sessionSelect").disabled')
        self.assertNotEqual(self.page.locator('#sessionSelect').input_value(), 'echo-cancel')
        self.assertIn('已不在清單上', self.page.locator('#sessionHint').inner_text())

    def test_unlisted_date_and_failed_catalog_still_submit(self):
        self.page.goto(self.base + 'posttest.html?course=echo')
        self.page.wait_for_function('document.getElementById("sessionHint").textContent.includes("自動帶入")')
        self.page.locator('#sessionSelect').select_option('__date')
        self.assertTrue(self.page.locator('#sessionDate').is_visible())
        self.page.locator('#sessionDate').fill('2026-11-05')
        self.fill_answers(); self.page.locator('#submitBtn').click()
        self.page.locator('#done').wait_for(state='visible')
        self.assertEqual(self.sent[-1]['row']['場次ID'], ''); self.assertEqual(self.sent[-1]['row']['上課日期'], '2026-11-05')
        self.sent.clear(); self.catalog_fail = True
        self.page.goto(self.base + 'pretest.html?course=lap')
        self.page.wait_for_function('document.getElementById("sessionHint").textContent.includes("載入失敗")')
        self.assertEqual(self.page.locator('#sessionSelect').input_value(), '__date')
        self.assertFalse(self.page.locator('#sessionSelect').is_disabled())
        self.page.locator('#sessionDate').fill('2026-11-06')
        self.fill_answers(); self.page.locator('#submitBtn').click()
        self.page.locator('#done').wait_for(state='visible')
        self.assertEqual(self.sent[-1]['row']['上課日期'], '2026-11-06'); self.assertEqual(self.sent[-1]['sheet'], '腹腔鏡_前測')

    def test_rejected_receipt_keeps_answers_and_reuses_token(self):
        self.page.goto(self.base + 'posttest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.fill_answers(); self.reject = True
        self.page.locator('#submitBtn').click()
        self.page.locator('#sendFail').wait_for(state='visible')
        self.assertIn('未開放填答', self.page.locator('#sendReason').inner_text())
        self.assertNotIn('Error:', self.page.locator('#sendReason').inner_text())
        self.page.locator('#sendBack').click(); self.assertFalse(self.page.locator('#sendDialog').is_visible())
        self.assertFalse(self.page.locator('#done').is_visible()); self.assertTrue(self.page.locator('#form').is_visible())
        self.assertFalse(self.page.locator('#sessionSelect').is_disabled())
        self.assertFalse(self.page.locator('#form input').first.is_disabled())
        token = self.sent[-1]['receiptToken']; self.reject = False
        self.page.locator('#submitBtn').click(); self.page.locator('#done').wait_for(state='visible')
        self.assertEqual(self.sent[-1]['receiptToken'], token)
        self.assertFalse(self.page.locator('#sendDialog').is_visible())

    def test_direct_reply_confirms_in_one_round_trip(self):
        self.page.goto(self.base + 'posttest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.fill_answers(); self.page.locator('#submitBtn').click()
        self.page.locator('#done').wait_for(state='visible')
        self.assertEqual(len(self.sent), 1); self.assertEqual(self.receipt_checks, 0)

    def test_dropped_request_is_resent_and_only_confirmed_receipts_succeed(self):
        self.page.goto(self.base + 'posttest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.fill_answers(); self.post_drop = 1
        self.page.locator('#submitBtn').click(); self.page.locator('#done').wait_for(state='visible')
        self.assertEqual(len(self.sent), 1); self.assertGreater(self.receipt_checks, 0)
        # 後台始終沒有確認收件：一定要跳出失敗視窗，不可顯示成功。
        self.sent.clear(); self.page.goto(self.base + 'pretest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.fill_answers(); self.post_drop = 99; self.never_received = True
        self.page.locator('#submitBtn').click()
        self.page.locator('#sendFail').wait_for(state='visible', timeout=20000)
        self.assertFalse(self.page.locator('#done').is_visible())
        self.assertIn('無法確認', self.page.locator('#sendReason').inner_text())
        self.post_drop = 0; self.never_received = False
        self.page.locator('#sendRetry').click(); self.page.locator('#done').wait_for(state='visible')

    def open_dashboard(self):
        self.page.goto(self.base + 'index.html')
        self.page.locator('#app').wait_for(state='visible')

    def apply_fixture(self):
        self.open_dashboard()
        self.page.evaluate('''catalog => {
          const raw = demoData(); raw['課程清單'] = catalog;
          const pre = raw['心臟超音波_前測'][0], post = raw['心臟超音波_後測'][0];
          const record = (base, name, session, stamp) => ({...base, '姓名':name, '場次ID':session, '上課日期':'2026-10-14', '時間戳記':stamp});
          raw['心臟超音波_前測'] = [record(pre,'測試甲','echo-A','2026/10/10 09:00:00'), record(pre,'測試甲','echo-A','2026/10/11 09:00:00'), record(pre,'測試甲','echo-B','2026/10/12 09:00:00'), record(pre,'跨場次','echo-A','2026/10/11 09:00:00'), record(pre,'舊資料','','2026/10/14 09:00:00')];
          raw['心臟超音波_前測'].at(-1)['上課日期']='';
          raw['心臟超音波_後測'] = [record(post,'測試甲','echo-A','2026/10/14 11:00:00'), record(post,'測試甲','echo-B','2026/10/14 15:00:00'), record(post,'跨場次','echo-B','2026/10/14 15:00:00'), record(post,'舊資料','','2026/10/14 15:00:00')];
          raw['心臟超音波_後測'].at(-1)['上課日期']='';
          applyData({data:raw,demo:true});
        }''', CATALOG)

    def test_overview_registry_counts_and_session_pairing(self):
        self.apply_fixture()
        row = self.page.locator('#courseOpening tbody tr').first
        self.assertEqual(row.locator('td').all_text_contents(), ['心臟超音波','3 場','14 人次（1 場待填）','1 場'])
        before = row.inner_text(); self.page.locator('#fId').select_option('PGY2')
        self.assertEqual(row.inner_text(), before)
        self.page.locator('#fId').select_option('')
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pairs.length"), 2)
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pre.length"), 4)
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pre.find(r=>r['姓名']==='測試甲' && r._session==='session:echo-A')['時間戳記']"), '2026/10/11 09:00:00')
        self.page.locator('[data-t="echo"]').click()
        self.assertEqual(self.page.locator('#fSes option').count(), 7)
        self.page.locator('#fSes').select_option('session:echo-A')
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pre.length"), 2)
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pairs.length"), 1)
        self.page.locator('#fSes').select_option('__unassigned')
        self.assertEqual(self.page.evaluate("courseData(COURSES[0]).pairs.length"), 0)
        self.assertIn('未指定場次', self.page.locator('#view').inner_text())

    def test_dashboard_opens_without_password_and_retries_after_failure(self):
        self.open_dashboard()
        self.assertFalse(self.page.locator('#gate').is_visible()); self.assertEqual(self.page.locator('input[type=password]:visible').count(), 0)
        self.assertTrue(all('pw=' not in url for url in self.read_urls))
        self.assertIn('Google Sheet', self.page.locator('#srcText').inner_text())
        self.dashboard_fail = True; self.page.goto(self.base + 'index.html')
        self.page.locator('#loadBtn').wait_for(state='visible'); self.assertIn('無法連線', self.page.locator('#loadErr').inner_text())
        self.dashboard_fail = False; self.page.locator('#loadBtn').click()
        self.page.locator('#app').wait_for(state='visible')

    def test_missing_registry_and_all_demo_tabs_still_render(self):
        self.open_dashboard()
        self.page.evaluate("applyData({data:demoData(),demo:true})")
        self.assertEqual(self.page.locator('#courseOpening tbody tr').count(), 4)
        for i in range(5):
            self.page.locator('#tabs button').nth(i).click()
            self.assertGreater(len(self.page.locator('#view').inner_text()), 100)
        self.page.evaluate("const raw=demoData(); delete raw['課程清單']; state.tab='overview'; applyData({data:raw,demo:true})")
        self.assertIn('尚無有效課程清單', self.page.locator('#view').inner_text())
        self.assertIn('0 場', self.page.locator('#courseOpening').inner_text())

    def test_small_screen_picker_and_overview_fit(self):
        self.page.set_viewport_size({'width':390, 'height':844})
        self.page.goto(self.base + 'pretest.html?course=echo&session=echo-A')
        self.page.wait_for_function('document.getElementById("sessionSelect").value==="echo-A"')
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        self.apply_fixture()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    def admin_login(self, dashboard=True):
        if dashboard:
            self.apply_fixture(); self.admin_data = self.page.evaluate('RAW')
            self.page.locator('#adminOpen').click()
        else:
            self.open_dashboard(); self.page.locator('#adminOpen').click()
        self.page.locator('#adminPassword').fill('test-admin')
        self.page.locator('#adminLoginSubmit').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已登入")')

    def test_admin_login_permissions_and_credentials_stay_out_of_storage_and_get_urls(self):
        self.open_dashboard(); self.page.locator('#adminOpen').click()
        self.page.locator('#adminPassword').fill('wrong-fixture'); self.page.locator('#adminLoginSubmit').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("密碼不正確")')
        self.assertFalse(self.page.locator('#adminWorkspace').is_visible()); self.assertEqual(self.manager_writes, [])
        self.page.locator('#adminPassword').fill('test-admin'); self.page.locator('#adminLoginSubmit').click()
        self.page.locator('#adminWorkspace').wait_for(state='visible')
        self.page.wait_for_function('document.querySelectorAll("#adminRows tr").length===6')
        self.assertEqual(self.page.locator('#adminPassword').input_value(), '')
        self.assertEqual(self.page.locator('#adminOpen').inner_text(), '課程管理')
        self.assertNotIn('test-admin', '\n'.join(self.read_urls))
        storage = self.page.evaluate('JSON.stringify({local: {...localStorage},session: {...sessionStorage}})')
        self.assertNotIn('test-admin', storage); self.assertNotIn(self.admin_token, storage)

    def test_admin_can_create_class_and_overview_updates_after_confirmed_save(self):
        self.admin_login()
        self.page.locator('#adminCourse').select_option('腹部超音波')
        self.page.locator('#adminDate').fill('2026-10-20'); self.page.locator('#adminTime').fill('15:30')
        self.page.locator('#adminStudents').fill('10'); self.page.locator('#adminState').select_option('已開課')
        identifier = self.page.locator('#adminID').input_value()
        self.assertRegex(identifier, r'^abd-20261020-[a-f0-9]{8}$')
        self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已儲存")')
        self.assertEqual(self.manager_writes[-1]['session']['場次ID'], identifier)
        self.assertEqual(self.manager_writes[-1]['session']['學員人數'], '10')
        self.assertEqual(self.page.locator('#adminDate').input_value(), '')
        self.page.locator('#adminClose').click()
        self.assertEqual(self.page.locator('#courseOpening tbody tr').nth(2).locator('td').all_text_contents(), ['腹部超音波','1 場','10 人次','0 場'])

    def test_admin_can_edit_date_zero_students_and_close_answers_without_changing_identity(self):
        self.admin_login(); self.page.locator('[data-admin-row="2"]').click()
        self.assertTrue(self.page.locator('#adminCourse').is_disabled())
        self.assertTrue(self.page.locator('#adminID').evaluate('(e)=>e.readOnly'))
        self.page.locator('#adminDate').fill('2026-10-21'); self.page.locator('#adminStudents').fill('0')
        self.page.locator('#adminAllow').select_option('否'); self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已儲存")')
        written = self.manager_writes[-1]
        self.assertEqual(written['mode'], 'update'); self.assertEqual(written['session']['場次ID'], 'echo-A')
        self.assertEqual(written['session']['上課日期'], '2026-10-21'); self.assertEqual(written['session']['學員人數'], '0')
        self.assertEqual(written['session']['開放填答'], '否'); self.assertEqual(len(self.admin_catalog), 6)

    def test_conflicting_edit_keeps_draft_and_requires_reloading_current_version(self):
        self.admin_login(); self.page.locator('[data-admin-row="2"]').click()
        self.page.locator('#adminStudents').fill('7')
        self.admin_versions[0] += 1; self.admin_catalog[0]['學員人數'] = 9
        self.admin_data['課程清單'] = copy.deepcopy(self.admin_catalog)
        self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("其他人已修改")')
        self.assertEqual(self.page.locator('#adminStudents').input_value(), '7'); self.assertEqual(self.manager_writes, [])
        self.page.locator('#adminRefresh').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已重新載入")')
        self.assertEqual(self.page.locator('#adminStudents').input_value(), '7')
        self.page.locator('[data-admin-row="2"]').click(); self.assertEqual(self.page.locator('#adminStudents').input_value(), '9')
        self.page.locator('#adminStudents').fill('7'); self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已儲存")')
        self.assertEqual(len(self.manager_writes), 1)

    def test_expired_admin_session_keeps_draft_for_relogin_and_logout_clears_editing_access(self):
        self.admin_login(); self.page.locator('#adminDate').fill('2026-11-01'); self.page.locator('#adminStudents').fill('12')
        self.admin_expired = True; self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("登入已過期")')
        self.assertFalse(self.page.locator('#adminWorkspace').is_visible()); self.assertEqual(self.manager_writes, [])
        self.page.locator('#adminPassword').fill('test-admin'); self.page.locator('#adminLoginSubmit').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已登入")')
        self.assertEqual(self.page.locator('#adminStudents').input_value(), '12')
        self.page.locator('#adminSave').click()
        self.page.wait_for_function('document.getElementById("adminMessage").textContent.includes("已儲存")')
        self.page.locator('#adminLogout').click()
        self.assertFalse(self.page.locator('#adminWorkspace').is_visible()); self.assertTrue(self.page.locator('#adminLoginForm').is_visible())
        self.assertEqual(self.page.locator('#adminPassword').input_value(), '')
        self.assertFalse(self.page.evaluate('CourseAdmin.isAuthenticated()'))

    def test_admin_mobile_dialog_fits_and_escape_restores_focus(self):
        self.page.set_viewport_size({'width':390, 'height':844}); self.admin_login(dashboard=False)
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        self.assertTrue(self.page.locator('#adminDialog').evaluate('(e)=>e.scrollWidth <= e.clientWidth'))
        self.page.keyboard.press('Escape')
        self.assertFalse(self.page.locator('#adminDialog').is_visible())
        self.assertFalse(self.page.evaluate('document.documentElement.classList.contains("admin-dialog-open")'))

    def test_dashboard_refresh_clears_revoked_admin_access_and_preserves_the_draft(self):
        self.admin_login(); self.page.locator('#adminDate').fill('2026-11-03'); self.page.locator('#adminStudents').fill('5')
        self.admin_expired = True; self.page.evaluate('load()')
        self.assertFalse(self.page.locator('#adminWorkspace').is_visible())
        self.assertTrue(self.page.locator('#adminLoginForm').is_visible())
        self.assertEqual(self.page.locator('#adminStudents').input_value(), '5')
        self.assertFalse(self.page.evaluate('CourseAdmin.isAuthenticated()')); self.assertEqual(self.manager_writes, [])

if __name__ == '__main__':
    unittest.main(verbosity=2)
