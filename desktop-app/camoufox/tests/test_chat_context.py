"""Issue #4 offline regressions against the actual Playwright browser DOM.

Run from the repository root:
    python -m unittest discover -s desktop-app/camoufox/tests -v

The default browser is Playwright Firefox. BOSSCLAW_TEST_BROWSER may point to
an existing Camoufox/Firefox executable; BOSSCLAW_TEST_ENGINE=chromium can be
used with a Playwright-compatible Chromium executable. No network request is
allowed through, and no real account, cookies, messages or resumes are used.
"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from unittest.mock import patch

from playwright.sync_api import sync_playwright


HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
CHAT = (FIXTURES / "chat.html").read_text(encoding="utf-8")
DETAIL = (FIXTURES / "detail.html").read_text(encoding="utf-8")
STYLE = """<style>
body { width:1100px; margin:24px; }
.chat-conversation { width:760px; margin-left:250px; padding:12px; }
.chat-header { min-height:48px; }
.chat-message { height:220px; }
textarea, input, [contenteditable] { width:600px; min-height:50px; }
.im-list { padding:0; }
.item-myself { margin-left:300px; width:350px; min-height:24px; }
</style>"""
GREETING = "您好，我对该岗位很感兴趣，希望进一步了解职位要求。"
EXPECTED = {"recruiterName": "测试招聘者", "company": "示例科技有限公司"}


# common.py creates DATA_DIR on import. Isolate that side effect in a temporary
# home so importing the production module never creates or reads user data.
_IMPORT_HOME = tempfile.TemporaryDirectory(prefix="bossclaw-chat-regression-")
sys.path.insert(0, str(HERE.parent))
with patch.object(Path, "home", return_value=Path(_IMPORT_HOME.name)):
    server = importlib.import_module("camoufox_server")


def document(body, script=""):
    return "<!doctype html><meta charset='utf-8'>" + STYLE + body + "<script>" + script + "</script>"


def instrumented_chat(chat=CHAT, bubble="full"):
    # All send effects are confined to a synthetic DOM and counted for assertions.
    return document(chat, """
document.body.dataset.inputCount = '0'; document.body.dataset.sendCount = '0'; document.body.dataset.attachmentCount = '0';
document.addEventListener('input', () => document.body.dataset.inputCount = String(Number(document.body.dataset.inputCount) + 1));
document.querySelector('#send-message').onclick = () => {
  document.body.dataset.sendCount = String(Number(document.body.dataset.sendCount) + 1);
  const text = document.querySelector('#chat-input').value;
  const mode = BUBBLE;
  if (mode !== 'none') {
    const li = document.createElement('li'); li.className = 'message-item item-myself';
    li.innerHTML = '<div class="text"><span></span></div>';
    li.querySelector('span').textContent = mode === 'partial' ? text.slice(0, -5) : text;
    document.querySelector('.im-list').appendChild(li);
  }
};
document.querySelector('#send-resume').onclick = () => document.body.dataset.attachmentCount = String(Number(document.body.dataset.attachmentCount) + 1);
""".replace("BUBBLE", json.dumps(bubble)))


def detail_document(chat=CHAT, popup=False):
    script = "document.body.dataset.entryClicks='0'; document.querySelector('#communication-entry').onclick=()=>{document.body.dataset.entryClicks=String(Number(document.body.dataset.entryClicks)+1); ACTION};"
    action = ("window.open('https://fixtures.invalid/chat', '_blank');" if popup else
              "document.body.insertAdjacentHTML('beforeend', " + json.dumps(chat) + ");")
    return document(DETAIL, script.replace("ACTION", action))


class ChatContextRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        engine = os.environ.get("BOSSCLAW_TEST_ENGINE", "firefox")
        options = {"headless": True}
        executable = os.environ.get("BOSSCLAW_TEST_BROWSER")
        if executable:
            options["executable_path"] = executable
        try:
            cls.browser = getattr(cls.playwright, engine).launch(**options)
        except Exception:
            cls.playwright.stop()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        _IMPORT_HOME.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.context.route("**/*", lambda route: route.abort())
        self.page = self.context.new_page()
        self.addCleanup(self.context.close)

    def content(self, body):
        self.page.set_content(document(body))

    @contextmanager
    def fast_poll(self):
        with patch.object(server, "human_sleep", side_effect=lambda *_a, **_k: self.page.wait_for_timeout(5)):
            yield

    def test_only_search_controls_do_not_establish_chat(self):
        self.content(DETAIL)
        self.assertIsNone(server._find_chat_input(self.page))
        self.assertEqual(self.page.locator("[data-bossclaw-chat-input]").count(), 0)

    def test_search_is_hard_excluded_even_inside_chat_panel(self):
        cases = [
            '<textarea id="chat-input" placeholder="搜索联系人"></textarea>',
            '<input id="chat-input" type="search" placeholder="输入消息">',
            '<div class="chat-filter"><textarea id="chat-input" placeholder="输入消息"></textarea></div>',
            '<input class="chat-input" aria-label="筛选会话" type="text">',
            '<div class="contact-search"><textarea id="chat-input" placeholder="回复"></textarea></div>',
        ]
        for control in cases:
            with self.subTest(control=control):
                self.content(CHAT.replace('<textarea id="chat-input" placeholder="输入消息"></textarea>', control))
                self.assertIsNone(server._find_chat_input(self.page))

    def test_generic_prompt_geometry_and_textarea_are_insufficient(self):
        for control in ('<textarea placeholder="请输入"></textarea>',
                        '<div class="editor" contenteditable="true">请输入</div>',
                        '<textarea id="chat-input" placeholder="输入消息"></textarea>'):
            with self.subTest(control=control):
                self.content('<div style="margin:500px 0 0 300px">' + control + '</div>')
                self.assertIsNone(server._find_chat_input(self.page))
        self.content(CHAT.replace('id="chat-input" placeholder="输入消息"', 'placeholder="请输入"'))
        self.assertIsNone(server._find_chat_input(self.page))

    def test_search_and_chat_coexist_without_search_selection(self):
        self.content(DETAIL + CHAT)
        loc = server._find_chat_input(self.page)
        self.assertIsNotNone(loc)
        self.assertEqual(loc.get_attribute("id"), "chat-input")
        self.assertEqual(loc.evaluate("el => el.ownerDocument === document"), True)

    def test_explicit_contenteditable_chat_editor_is_supported(self):
        self.content(CHAT.replace('<textarea id="chat-input" placeholder="输入消息"></textarea>',
                                 '<div id="chat-input" contenteditable="true" aria-label="输入消息"></div>'))
        loc = server._find_chat_input(self.page)
        self.assertIsNotNone(loc)
        self.assertEqual(loc.get_attribute('contenteditable'), 'true')
        self.assertTrue(server._inject_text_via_exec(self.page, GREETING))
        self.assertEqual(loc.inner_text(), GREETING)

    def test_disabled_readonly_hidden_and_stale_markers_are_rejected(self):
        for attribute in ('disabled', 'readonly', 'aria-disabled="true"', 'aria-readonly="true"',
                          'style="display:none"', 'style="visibility:hidden"'):
            with self.subTest(attribute=attribute):
                self.content(CHAT.replace('id="chat-input"', 'id="chat-input" data-bossclaw-chat-input="1" ' + attribute))
                self.assertIsNone(server._find_chat_input(self.page))
                self.assertEqual(self.page.locator('[data-bossclaw-chat-input]').count(), 0)
        control = '<textarea id="chat-input" placeholder="输入消息"></textarea>'
        self.content(CHAT.replace(control, '<fieldset disabled>' + control + '</fieldset>'))
        self.assertIsNone(server._find_chat_input(self.page))

    def test_rebuilt_input_receives_fresh_marker(self):
        self.content(CHAT)
        old = server._find_chat_input(self.page)
        self.assertIsNotNone(old)
        self.page.evaluate("""() => {
          const old=document.querySelector('#chat-input'); old.id='retired-input'; old.readOnly=true;
          old.insertAdjacentHTML('afterend', '<textarea id="chat-input" placeholder="输入消息"></textarea>');
        }""")
        loc = server._find_chat_input(self.page)
        self.assertEqual(loc.get_attribute('id'), 'chat-input')
        self.assertEqual(self.page.locator('[data-bossclaw-chat-input]').count(), 1)
        self.assertIsNone(self.page.locator('#retired-input').get_attribute('data-bossclaw-chat-input'))

    def test_single_page_lookup_ignores_existing_chat_tab(self):
        unrelated = self.context.new_page()
        unrelated.set_content(document(CHAT))
        self.content(DETAIL)
        self.assertIsNone(server._find_chat_input(self.page))
        self.assertEqual(unrelated.locator('[data-bossclaw-chat-input]').count(), 0)

    def test_identity_comes_from_selected_panel_header(self):
        hidden = CHAT.replace('id="active-panel"', 'id="old-panel" style="display:none"').replace('测试招聘者', '旧招聘者').replace('示例科技', '旧公司')
        self.content(DETAIL + hidden + CHAT)
        self.assertIsNotNone(server._find_chat_input(self.page))
        self.assertEqual(server._chat_header_identity(self.page), {"recruiter": "测试招聘者", "company": "示例科技有限公司"})

    def test_recommended_company_is_not_identity_fallback(self):
        without_company = CHAT.replace('<span>示例科技有限公司</span>', '')
        self.content(DETAIL + without_company)
        self.assertIsNotNone(server._find_chat_input(self.page))
        self.assertEqual(server._chat_header_identity(self.page).get('company', ''), '')

    def test_multiple_visible_chat_panels_are_ambiguous(self):
        self.content(CHAT + CHAT.replace('active-panel', 'other-panel').replace('chat-input', 'other-chat-input'))
        self.assertIsNone(server._find_chat_input(self.page))

    def test_enter_chat_clicks_entry_despite_search_and_ignores_existing_tab(self):
        unrelated = self.context.new_page()
        unrelated.set_content(document(CHAT.replace('测试招聘者', '其他招聘者')))
        self.page.set_content(detail_document())
        with self.fast_poll():
            target, loc = server._enter_chat(self.page, timeout=2)
        self.assertIs(target, self.page)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.entryClicks)'), 1)
        self.assertEqual(loc.get_attribute('id'), 'chat-input')
        self.assertEqual(server._chat_header_identity(target)['recruiter'], '测试招聘者')

    def test_enter_chat_new_popup_returns_popup_and_its_input(self):
        self.context.unroute('**/*')
        self.context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=document(CHAT)))
        unrelated = self.context.new_page()
        unrelated.set_content(document(CHAT.replace('测试招聘者', '其他招聘者')))
        self.page.set_content(detail_document(popup=True))
        with self.fast_poll():
            target, loc = server._enter_chat(self.page, timeout=3)
        self.assertIsNotNone(target)
        self.assertIsNot(target, self.page)
        self.assertIsNot(target, unrelated)
        self.assertIs(target.opener(), self.page)
        self.assertEqual(target.evaluate('document.querySelector("#chat-input") === null'), False)
        self.assertEqual(loc.evaluate('el => el.ownerDocument.URL'), target.url)
        self.assertEqual(server._chat_header_identity(target)['recruiter'], '测试招聘者')

    def test_injection_uses_actual_selected_input_and_single_evaluate_argument(self):
        self.content(DETAIL + CHAT)
        self.assertIsNotNone(server._find_chat_input(self.page))
        self.assertTrue(server._inject_text_via_exec(self.page, GREETING))
        self.assertEqual(self.page.locator('#chat-input').input_value(), GREETING)
        self.assertEqual(self.page.locator('#job-search').input_value(), '')

    @contextmanager
    def offline_greeting(self, chat=CHAT, bubble='full', popup=False):
        self.context.unroute('**/*')
        self.context.route('**/*', lambda route: route.fulfill(
            status=200, content_type='text/html', body=(
                document('<nav class="nav-resume-box">在线简历</nav>')
                if '/web/geek/job?' in route.request.url else
                detail_document(chat=chat, popup=popup) if '/job_detail/' in route.request.url else
                instrumented_chat(chat, bubble))))
        # Entry still uses the production click path, then initializes the
        # fixture-only counters/handlers once the panel appears in the DOM.
        actual_click = server._click_chat_button
        def click_and_instrument(page, label):
            result = actual_click(page, label)
            if result and page.locator('#chat-input').count():
                script = instrumented_chat(chat, bubble).split('<script>', 1)[1].split('</script>', 1)[0]
                page.evaluate('() => {' + script + '}')
            return result

        @contextmanager
        def browser_fixture(**_kwargs):
            yield self.page

        with ExitStack() as stack:
            stack.enter_context(patch.object(server, 'open_browser', browser_fixture))
            stack.enter_context(patch.object(server, 'load_cookies', return_value=[]))
            stack.enter_context(patch.object(server, 'save_cookies'))
            stack.enter_context(patch.object(server, 'human_sleep', side_effect=lambda *_a, **_k: self.page.wait_for_timeout(5)))
            stack.enter_context(patch.object(server, 'type_greeting_human', side_effect=lambda page, text: page.keyboard.type(text)))
            stack.enter_context(patch.object(server, '_click_chat_button', side_effect=click_and_instrument))
            yield

    def assert_no_send(self, result):
        self.assertFalse(result['ok'])
        self.assertFalse(result['sent'])
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.inputCount || 0)'), 0)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount || 0)'), 0)
        self.assertEqual(self.page.locator('#chat-input').input_value(), '')

    def test_full_flow_conflicting_identity_does_not_input_or_send(self):
        with self.offline_greeting():
            result = server.chat_greeting('offline-job', GREETING, expected={"recruiterName": "不同招聘者", "company": EXPECTED['company']})
        self.assert_no_send(result)
        self.assertEqual(result['code'], 602)

    def test_full_flow_unknown_actual_identity_does_not_input_or_send(self):
        chat = CHAT.replace('测试招聘者', '').replace('示例科技有限公司', '')
        with self.offline_greeting(chat):
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assert_no_send(result)

    def test_full_flow_missing_expected_identity_does_not_input_or_send(self):
        with self.offline_greeting():
            result = server.chat_greeting('offline-job', GREETING, expected={})
        self.assert_no_send(result)

    def test_full_flow_unconfirmed_bubble_is_failure_and_blocks_attachments(self):
        actual_confirm = server._confirm_message
        with self.offline_greeting(bubble='none'), \
                patch.object(server, '_confirm_message', side_effect=lambda page, text, before: actual_confirm(page, text, before, timeout_ms=80)), \
                patch.object(server, '_open_resume_entry') as attachment_entry, \
                patch.object(server, '_upload_resume_images') as upload:
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED,
                                          send_online_resume=True, send_resume_image=True,
                                          resume_images=['fixture-only.png'])
        self.assertFalse(result['ok'])
        self.assertFalse(result['sent'])
        self.assertEqual(result['code'], 501)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 1)
        attachment_entry.assert_not_called()
        upload.assert_not_called()
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.attachmentCount)'), 0)

    def test_attachment_delay_identity_change_preserves_text_receipt_and_blocks_attachments(self):
        def delay_and_switch(seconds, *_args, **_kwargs):
            if seconds == 9.0:
                self.page.locator('.name-text').evaluate("el => el.textContent = '不同招聘者'")
            self.page.wait_for_timeout(5)
        with self.offline_greeting(), \
                patch.object(server, 'human_sleep', side_effect=delay_and_switch), \
                patch.object(server, '_open_resume_entry') as attachment_entry, \
                patch.object(server, '_upload_resume_images') as upload:
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED,
                                          send_online_resume=True, send_resume_image=True,
                                          resume_images=['fixture-only.png'], attachment_delay_seconds=9.0)
        self.assertFalse(result['ok'])
        self.assertTrue(result['sent'])
        self.assertEqual(result['code'], 602)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 1)
        self.assertEqual(self.page.locator('.item-myself .text span').inner_text(), GREETING)
        attachment_entry.assert_not_called()
        upload.assert_not_called()
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.attachmentCount)'), 0)

    def test_upload_selects_unique_visible_resume_dialog_file(self):
        self.content('<input id="unrelated-file" type="file">' + CHAT +
                     '<div class="upload-resume-dialog" style="display:none"><input id="old-file" type="file"></div>' +
                     '<div class="upload-resume-dialog"><input id="resume-file" type="file"></div>')
        payload = {'name': 'synthetic-fixture.txt', 'mimeType': 'text/plain',
                   'buffer': b'Synthetic offline regression attachment; no personal information.'}
        with self.fast_poll():
            result = server._fill_upload_resume_files(self.page, [payload], EXPECTED)
        self.assertTrue(result)
        self.assertEqual(self.page.locator('#resume-file').evaluate('el => Array.from(el.files).map(f => f.name)'),
                         ['synthetic-fixture.txt'])
        self.assertEqual(self.page.locator('#unrelated-file').evaluate('el => el.files.length'), 0)
        self.assertEqual(self.page.locator('#old-file').evaluate('el => el.files.length'), 0)

    def test_upload_unknown_identity_does_not_set_files(self):
        chat = CHAT.replace('测试招聘者', '').replace('示例科技有限公司', '')
        self.content(chat + '<div class="upload-resume-dialog"><input id="resume-file" type="file"></div>')
        payload = {'name': 'synthetic-fixture.txt', 'mimeType': 'text/plain', 'buffer': b'Offline fixture.'}
        with self.fast_poll():
            result = server._fill_upload_resume_files(self.page, [payload], EXPECTED)
        self.assertFalse(result)
        self.assertEqual(self.page.locator('#resume-file').evaluate('el => el.files.length'), 0)

    def test_full_flow_confirms_complete_bubble(self):
        with self.offline_greeting():
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assertTrue(result['ok'])
        self.assertTrue(result['sent'])
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.entryClicks)'), 1)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 1)
        self.assertEqual(self.page.locator('.item-myself .text span').inner_text(), GREETING)
        self.assertEqual(self.page.locator('#job-search').input_value(), '')

    def test_full_flow_popup_keeps_keyboard_and_confirmation_in_same_session(self):
        unrelated = self.context.new_page()
        unrelated.set_content(instrumented_chat(CHAT.replace('测试招聘者', '其他招聘者')))
        with self.offline_greeting(popup=True):
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assertTrue(result['sent'])
        popup = next(page for page in self.context.pages if page.opener() is self.page)
        self.assertEqual(popup.evaluate('Number(document.body.dataset.sendCount)'), 1)
        self.assertEqual(popup.locator('.item-myself .text span').inner_text(), GREETING)
        self.assertEqual(unrelated.evaluate('Number(document.body.dataset.inputCount)'), 0)
        self.assertEqual(unrelated.evaluate('Number(document.body.dataset.sendCount)'), 0)
        self.assertEqual(self.page.locator('#job-search').input_value(), '')

    def test_session_identity_changed_during_typing_blocks_send(self):
        with self.offline_greeting():
            def type_then_switch(page, text):
                page.keyboard.type(text)
                page.locator('.name-text').evaluate("el => el.textContent = '不同招聘者'")
            with patch.object(server, 'type_greeting_human', side_effect=type_then_switch):
                result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assertFalse(result['ok'])
        self.assertFalse(result['sent'])
        self.assertEqual(result['code'], 602)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 0)

    def test_identity_changed_during_input_delay_blocks_typing_and_send(self):
        def delay_and_switch(seconds, *_args, **_kwargs):
            if seconds == 0.4:
                self.page.locator('.name-text').evaluate("el => el.textContent = '不同招聘者'")
            self.page.wait_for_timeout(5)
        with self.offline_greeting(), patch.object(server, 'human_sleep', side_effect=delay_and_switch):
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assert_no_send(result)
        self.assertEqual(result['code'], 602)

    def test_identity_changed_during_final_send_delay_blocks_send(self):
        half_second_calls = 0
        def delay_and_switch(seconds, *_args, **_kwargs):
            nonlocal half_second_calls
            if seconds == 0.5:
                half_second_calls += 1
                if half_second_calls == 2:
                    self.page.locator('.name-text').evaluate("el => el.textContent = '不同招聘者'")
            self.page.wait_for_timeout(5)
        with self.offline_greeting(), patch.object(server, 'human_sleep', side_effect=delay_and_switch):
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assertFalse(result['ok'])
        self.assertFalse(result['sent'])
        self.assertEqual(result['code'], 602)
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 0)

    def test_editor_rebuilt_during_final_send_delay_blocks_old_marker_send(self):
        half_second_calls = 0
        def delay_and_rebuild(seconds, *_args, **_kwargs):
            nonlocal half_second_calls
            if seconds == 0.5:
                half_second_calls += 1
                if half_second_calls == 2:
                    self.page.evaluate("""() => {
                      const old = document.querySelector('#chat-input');
                      old.id = 'retired-input'; old.readOnly = true;
                      old.insertAdjacentHTML('afterend', '<textarea id="chat-input" placeholder="输入消息"></textarea>');
                    }""")
            self.page.wait_for_timeout(5)
        with self.offline_greeting(), patch.object(server, 'human_sleep', side_effect=delay_and_rebuild):
            result = server.chat_greeting('offline-job', GREETING, expected=EXPECTED)
        self.assertFalse(result['ok'])
        self.assertFalse(result['sent'])
        self.assertEqual(self.page.evaluate('Number(document.body.dataset.sendCount)'), 0)
        self.assertEqual(self.page.locator('#chat-input').input_value(), '')

    def test_incoming_full_greeting_is_not_outgoing_confirmation(self):
        self.content(CHAT)
        self.assertIsNotNone(server._find_chat_input(self.page))
        before = server._outgoing_message_fingerprints(self.page)
        self.page.evaluate("""text => {
          const li=document.createElement('li'); li.className='message-item item-friend';
          li.style.cssText='margin-left:300px;width:350px;min-height:24px';
          li.innerHTML='<div class="text"><span></span></div>'; li.querySelector('span').textContent=text;
          document.querySelector('.im-list').appendChild(li);
        }""", GREETING)
        self.assertEqual(server._outgoing_message_fingerprints(self.page), before)
        self.assertFalse(server._confirm_message(self.page, GREETING, before, timeout_ms=80))

    def test_partial_greeting_bubble_is_not_complete_confirmation(self):
        self.page.set_content(instrumented_chat(bubble='partial'))
        self.assertIsNotNone(server._find_chat_input(self.page))
        before = server._outgoing_message_fingerprints(self.page)
        self.page.locator('#chat-input').fill(GREETING)
        self.page.locator('#send-message').click()
        self.assertFalse(server._confirm_message(self.page, GREETING, before, timeout_ms=3600))


if __name__ == '__main__':
    unittest.main()
