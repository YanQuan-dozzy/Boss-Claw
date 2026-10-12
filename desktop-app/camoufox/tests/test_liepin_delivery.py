"""离线验证真实猎聘 collector 的发送流程，仅替换浏览器边界；不读用户 Cookie、不联网。"""
import importlib
from contextlib import contextmanager
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_isolated = tempfile.TemporaryDirectory(prefix='bossclaw-liepin-send-')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
with patch.object(Path, 'home', return_value=Path(_isolated.name)):
    liepin = importlib.import_module('platforms.liepin')
    base = importlib.import_module('platforms.base')

GREETING = '您好，我对该岗位很感兴趣，具备相关项目经验，希望进一步沟通。'


class Locator:
    def __init__(self, page, action):
        self.page, self.action = page, action

    def count(self):
        return 1

    def fill(self, text, **_kwargs):
        self.page.writes += 1
        if self.page.input_fail:
            raise RuntimeError('offline input failure')
        self.page.state['editorText'] = text
        if self.page.after_input:
            self.page.state.update(self.page.after_input)

    def click(self, **_kwargs):
        if self.action == 'entry':
            self.page.entries += 1
            return
        self.page.sends += 1
        if not self.page.retain_editor:
            self.page.state['editorText'] = ''
        if not self.page.no_bubble:
            self.page.state['matching'] = 1
        if self.page.changed:
            self.page.state['heading'] = '另一个招聘方'


class Page:
    def __init__(self):
        self.frames = [self]
        self.context = object()
        self.url = 'https://www.liepin.com/job/offline.shtml'
        self.state = dict(ready=True, heading='示例招聘方', editorText='', matching=0, outgoing=0,
                          defaultOutgoing=0, nonDefaultOutgoing=0, incoming=0, sendReady=True)
        self.writes = self.sends = self.entries = 0
        self.input_fail = self.no_bubble = self.retain_editor = self.changed = False
        self.after_input = None

    def evaluate(self, _script, args=None):
        if args and args.get('phase') == 'before':
            return dict(ready=False)
        return dict(self.state)

    def locator(self, selector):
        return Locator(self, 'editor' if 'liepin-editor' in selector else 'send')

    def goto(self, *_args, **_kwargs):
        pass


class LiepinDeliveryRegression(unittest.TestCase):
    def setUp(self):
        self.page = Page()
        self.collector = liepin.LiepinCollector()
        self.collector._limit_hit = lambda _page: False
        self.counter = 0
        def clock():
            self.counter += 0.5
            return self.counter
        self.patches = [patch.object(liepin.time, 'time', clock), patch.object(liepin, 'human_sleep'),
                        patch.object(liepin, 'risk_text_hit', return_value=None)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def finish(self):
        return self.collector.finish_action(self.page, GREETING)

    def test_actual_send_requires_written_text_and_new_message(self):
        result = self.finish()
        self.assertTrue(result['sent'])
        self.assertTrue(result['greetingConfirmed'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 1))

    def test_open_window_without_bubble_is_unconfirmed(self):
        self.page.no_bubble = True
        result = self.finish()
        self.assertFalse(result['sent'])
        self.assertTrue(result['needsReview'])
        self.assertEqual(self.page.sends, 1, '确认超时不能重发')

    def test_existing_message_is_skipped_without_counting_success(self):
        self.page.state['outgoing'] = 1
        self.page.state['nonDefaultOutgoing'] = 1
        result = self.finish()
        self.assertEqual(result['code'], 701)
        self.assertIn('默认句以外的本人消息', result['message'])
        self.assertFalse(result['sent'])
        self.assertEqual((self.page.writes, self.page.sends), (0, 0))

    def test_platform_default_message_does_not_replace_workbench_greeting(self):
        self.page.state.update(outgoing=1, defaultOutgoing=1)
        result = self.finish()
        self.assertTrue(result['greetingConfirmed'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 1))

    def test_workbench_greeting_already_sent_is_not_repeated(self):
        self.page.state.update(matching=1, outgoing=1, nonDefaultOutgoing=1)
        result = self.finish()
        self.assertEqual(result['code'], 701)
        self.assertIn('与当前工作台文案相同', result['message'])
        self.assertEqual((self.page.writes, self.page.sends), (0, 0))

    def test_real_reply_with_default_message_is_existing_conversation(self):
        self.page.state.update(outgoing=1, defaultOutgoing=1, incoming=1)
        result = self.finish()
        self.assertEqual(result['code'], 701)
        self.assertIn('已有招聘方回复', result['message'])
        self.assertEqual((self.page.writes, self.page.sends), (0, 0))

    def test_hr_reply_during_fill_preserves_draft_without_sending(self):
        self.page.after_input = {'incoming': 1}
        result = self.finish()
        self.assertTrue(result['needsReview'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 0))
        self.assertEqual(self.page.state['editorText'], GREETING)

    def test_current_message_appears_during_fill_is_not_repeated(self):
        self.page.after_input = {'matching': 1}
        self.assertTrue(self.finish()['needsReview'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 0))

    def test_default_appears_during_fill_still_sends_workbench_text(self):
        self.page.after_input = {'outgoing': 1, 'defaultOutgoing': 1}
        self.assertTrue(self.finish()['greetingConfirmed'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 1))

    def test_existing_draft_is_preserved(self):
        self.page.state['editorText'] = '本人尚未提交的草稿'
        self.assertTrue(self.finish()['needsReview'])
        self.assertEqual((self.page.writes, self.page.sends), (0, 0))

    def test_input_failure_never_clicks_send(self):
        self.page.input_fail = True
        self.assertTrue(self.finish()['needsReview'])
        self.assertEqual(self.page.sends, 0)

    def test_send_button_unavailable_does_not_click(self):
        self.page.state['sendReady'] = False
        self.page.state['readiness'] = dict(officialSendButtons=1, disabledOfficialSendButtons=1, sendCandidates=0)
        result = self.finish()
        self.assertTrue(result['needsReview'])
        self.assertIn('文案已填入', result['message'])
        self.assertIn('官方按钮 1，禁用 1，可用 0', result['message'])
        self.assertEqual(self.page.sends, 0)

    def test_partial_input_never_sends_and_reports_character_counts(self):
        self.page.after_input = {'editorText': GREETING[:-1]}
        result = self.finish()
        self.assertTrue(result['needsReview'])
        self.assertIn(f'应为 {len(GREETING)} 字，读到 {len(GREETING)-1} 字', result['message'])
        self.assertEqual((self.page.writes, self.page.sends), (1, 0))

    def test_changed_target_stops_after_one_send(self):
        self.page.changed = True
        self.assertTrue(self.finish()['needsReview'])
        self.assertEqual(self.page.sends, 1)

    def test_input_not_cleared_is_unconfirmed(self):
        self.page.retain_editor = True
        self.assertTrue(self.finish()['needsReview'])

    def test_security_prompt_stops_before_input(self):
        with patch.object(liepin, 'risk_text_hit', return_value='安全验证'):
            result = self.finish()
        self.assertEqual(result['code'], 35)
        self.assertEqual((self.page.writes, self.page.sends), (0, 0))

    def test_base_returns_message_confirmation_not_window_confirmation(self):
        @contextmanager
        def browser(**_kwargs):
            yield self.page
        self.page.no_bubble = True
        with patch.object(base, 'open_browser', browser), patch.object(base, 'load_cookies', return_value=[]), \
             patch.object(base, 'save_cookies'), patch.object(base, 'goto_stable', return_value=True), \
             patch.object(base, 'human_sleep'), patch.object(base, 'risk_text_hit', return_value=None), \
             patch.object(self.collector, 'find_action_button', return_value=('ready', Locator(self.page, 'entry'))), \
             patch.object(self.collector, 'confirm_sent', return_value=True) as old_window_confirmation:
            result = self.collector.deliver({'jobId': 'offline', 'url': self.page.url}, GREETING)
        self.assertFalse(result['sent'])
        self.assertTrue(result['needsReview'])
        self.assertEqual((self.page.entries, self.page.writes, self.page.sends), (1, 1, 1))
        old_window_confirmation.assert_not_called()

    def test_base_default_hooks_keep_resume_confirmation(self):
        @contextmanager
        def browser(**_kwargs):
            yield self.page
        with patch.object(base, 'open_browser', browser), patch.object(base, 'load_cookies', return_value=[]), \
             patch.object(base, 'save_cookies'), patch.object(base, 'goto_stable', return_value=True), \
             patch.object(base, 'human_sleep'), patch.object(base, 'risk_text_hit', return_value=None), \
             patch.object(self.collector, 'find_action_button', return_value=('ready', Locator(self.page, 'entry'))), \
             patch.object(self.collector, 'before_action', base.CollectorBase.before_action.__get__(self.collector)), \
             patch.object(self.collector, 'finish_action', base.CollectorBase.finish_action.__get__(self.collector)), \
             patch.object(self.collector, 'confirm_sent', return_value=True) as resume_confirmation, \
             patch.object(self.collector, 'after_sent'):
            result = self.collector.deliver({'jobId': 'offline', 'url': self.page.url}, GREETING)
        self.assertTrue(result['sent'])
        resume_confirmation.assert_called_once_with(self.page)
        self.assertEqual((self.page.entries, self.page.writes, self.page.sends), (1, 0, 0))


if __name__ == '__main__':
    unittest.main()
