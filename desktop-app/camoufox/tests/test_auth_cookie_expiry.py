"""登录态「过期判定」回归测试 —— 纯离线。

用户反馈的另一半根因：界面显示「已登录」，点开始自动沟通却被平台以
「身份验证失效」拒掉。原因是登录态判定只看 Cookie 名字在不在，不看它是否已过期：
`wt2` 早已过期却仍被认成已登录，界面绿灯、实际会话是死的。

这里守住两条：
1. 判定（engine_status）必须把过期 Cookie 算作「未登录」；
2. 注入（load_cookies）必须跳过过期条目，并把误写成毫秒的 expires 归一秒。
"""
import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import camoufox_server as server  # noqa: E402
from platforms import common  # noqa: E402


def _cookie(name, value='v', expires=-1, domain='.zhipin.com'):
    return {'name': name, 'value': value, 'domain': domain, 'path': '/', 'expires': expires}


class AuthCookieExpiryTest(unittest.TestCase):
    def test_valid_wt2_counts_as_logged_in(self):
        cookies = [_cookie('wt2', expires=time.time() + 86400)]
        self.assertTrue(server._auth_hint_hit(cookies, 'wt2'))

    def test_expired_wt2_does_not_count_as_logged_in(self):
        cookies = [_cookie('wt2', expires=time.time() - 60)]
        self.assertFalse(server._auth_hint_hit(cookies, 'wt2'),
                         '过期的 wt2 不能被认成已登录，否则界面绿灯但实际必然被平台拒')

    def test_session_cookie_counts_as_logged_in(self):
        self.assertTrue(server._auth_hint_hit([_cookie('wt2', expires=-1)], 'wt2'))

    def test_empty_value_does_not_count(self):
        self.assertFalse(server._auth_hint_hit([_cookie('wt2', value='')], 'wt2'))

    def test_millisecond_timestamp_is_normalised(self):
        future_ms = (time.time() + 86400) * 1000
        past_ms = (time.time() - 86400) * 1000
        self.assertTrue(server._auth_hint_hit([_cookie('wt2', expires=future_ms)], 'wt2'))
        self.assertFalse(server._auth_hint_hit([_cookie('wt2', expires=past_ms)], 'wt2'),
                         '毫秒时间戳必须归一秒后再比较，否则过期判断永远失效')

    def test_paired_condition_needs_both_alive(self):
        # 智联：at + rt 成对，任一过期都不算登录
        ok = [_cookie('at', domain='.zhaopin.com', expires=time.time() + 60),
              _cookie('rt', domain='.zhaopin.com', expires=time.time() + 60)]
        self.assertTrue(server._auth_hint_hit(ok, ('=at', '=rt')))
        ok[1] = _cookie('rt', domain='.zhaopin.com', expires=time.time() - 60)
        self.assertFalse(server._auth_hint_hit(ok, ('=at', '=rt')))

    def test_engine_status_reports_not_logged_in_when_expired(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(common, 'DATA_DIR', root):
                expired = {'cookies': [_cookie('wt2', expires=time.time() - 60)], 'origins': []}
                common.cookie_file('boss').write_text(json.dumps(expired), encoding='utf-8')
                with mock.patch.object(server, 'cookie_file', common.cookie_file):
                    self.assertFalse(server.engine_status('boss')['loggedIn'])

                fresh = {'cookies': [_cookie('wt2', expires=time.time() + 86400)], 'origins': []}
                common.cookie_file('boss').write_text(json.dumps(fresh), encoding='utf-8')
                with mock.patch.object(server, 'cookie_file', common.cookie_file):
                    self.assertTrue(server.engine_status('boss')['loggedIn'])


class LoadCookiesTest(unittest.TestCase):
    def _write(self, root: Path, cookies):
        (root).mkdir(parents=True, exist_ok=True)
        common.cookie_file('boss').write_text(json.dumps({'cookies': cookies, 'origins': []}), encoding='utf-8')

    def test_expired_cookie_is_not_injected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(common, 'DATA_DIR', root), mock.patch.object(common, 'log'):
                self._write(root, [_cookie('wt2', expires=time.time() - 60), _cookie('zp_at', expires=time.time() + 60)])
                out = common.load_cookies('boss')
            self.assertEqual([c['name'] for c in out], ['zp_at'])

    def test_millisecond_expiry_is_converted_to_seconds(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            future_ms = (time.time() + 86400) * 1000
            with mock.patch.object(common, 'DATA_DIR', root), mock.patch.object(common, 'log'):
                self._write(root, [_cookie('wt2', expires=future_ms)])
                out = common.load_cookies('boss')
            self.assertEqual(len(out), 1)
            self.assertLess(out[0]['expires'], 1e11, 'expires 必须是秒级时间戳，毫秒直译会变成永久 Cookie')

    def test_session_cookie_keeps_no_expires_field(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(common, 'DATA_DIR', root), mock.patch.object(common, 'log'):
                self._write(root, [_cookie('wt2', expires=-1)])
                out = common.load_cookies('boss')
            self.assertNotIn('expires', out[0], '会话 Cookie 不应被写成带过期时间的持久 Cookie')


if __name__ == '__main__':
    unittest.main()
