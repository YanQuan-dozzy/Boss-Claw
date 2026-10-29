"""隐身引擎「固定身份 + 持久 profile」回归测试 —— 纯离线，不启动真浏览器。

背景（用户反馈：自动沟通一用就提示「身份验证失效」）
--------------------------------------------------------------------
原实现每次 `open_browser()` 都开一个一次性 profile，且 Camoufox 默认每启动一次就
随机抽一套指纹。平台的会话令牌（BOSS 的 `__zp_stoken__` 等）与指纹绑定，同一份登录
Cookie 换到新指纹下会被判为「身份验证失效」——刚扫码登录成功，一投递就要求重新验证，
而且永远好不了（下次又是新指纹）。

这里守住三条不变式：
1. 指纹首次生成后落盘，之后每次启动**复用同一份**；
2. profile 按平台持久化且**每次都指回同一目录**（保留 localStorage 等非 Cookie 会话）；
3. 同平台并发 / 持久 profile 启动失败时必须降级到一次性目录，绝不阻断业务，
   且降级目录用完即删。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from platforms import common  # noqa: E402

FAKE_FP = {'navigator': {'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0'}}


class _FakePage:
    def __init__(self):
        self.context = None


class _FakeContext:
    def __init__(self):
        self.page = _FakePage()
        self.page.context = self
        self.pages = [self.page]


class _FakeCamoufox:
    """替身：记录启动参数；`fail_launches` > 0 时模拟启动失败。"""

    calls: list = []
    fail_launches = 0

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        _FakeCamoufox.calls.append(kwargs)

    def __enter__(self):
        if _FakeCamoufox.fail_launches > 0:
            _FakeCamoufox.fail_launches -= 1
            raise RuntimeError('profile is locked')
        return _FakeContext()

    def __exit__(self, *exc):
        return False


class BrowserIdentityTest(unittest.TestCase):
    def setUp(self):
        _FakeCamoufox.calls = []
        _FakeCamoufox.fail_launches = 0
        common._PROFILE_LOCKS.clear()
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.data_dir = root / 'bossclaw'
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.patches = [
            mock.patch.object(common, 'DATA_DIR', self.data_dir),
            mock.patch.object(common, '_PROFILE_ROOT', self.data_dir / 'camoufox-profiles'),
            mock.patch.object(common, 'detect_kernel', lambda force=False: {'kind': 'camoufox', 'message': 'ok'}),
            mock.patch('camoufox.sync_api.Camoufox', _FakeCamoufox),
            mock.patch('camoufox.fingerprints.generate_fingerprint',
                       lambda **kw: json.loads(json.dumps(FAKE_FP))),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        common._PROFILE_LOCKS.clear()
        self._tmp.cleanup()

    # ---------- 指纹固定 ----------
    def test_fingerprint_generated_once_then_reused(self):
        first = common.load_identity('boss', 'windows')
        second = common.load_identity('boss', 'windows')
        self.assertEqual(first, FAKE_FP)
        self.assertEqual(second, FAKE_FP)
        files = list(self.data_dir.glob('camoufox-identity-*.json'))
        self.assertEqual(len(files), 1, '指纹只应落盘一份，不应每次启动重新生成')

    def test_missing_os_resolves_to_host_identity(self):
        """不传 os 与传宿主 os 必须命中同一份身份。

        前端有的调用点传 `cfg.camoufox?.os`（可能 undefined）、有的不传；
        若两者落到两套指纹，同一账号会在两套环境之间来回切，反而更像异常设备。
        """
        implicit = common.load_identity('boss')
        explicit = common.load_identity('boss', common.normalize_os(None))
        self.assertEqual(implicit, explicit)
        self.assertEqual(len(list(self.data_dir.glob('camoufox-identity-boss-*.json'))), 1)

    def test_corrupted_identity_file_is_regenerated(self):
        f = common.identity_file('boss', 'windows')
        f.write_text('{ not json', encoding='utf-8')
        self.assertEqual(common.load_identity('boss', 'windows'), FAKE_FP)

    def test_identity_generation_failure_does_not_raise(self):
        with mock.patch('camoufox.fingerprints.generate_fingerprint', side_effect=OSError('offline')):
            self.assertIsNone(common.load_identity('boss', 'windows'))

    # ---------- profile 持久化 ----------
    def test_open_browser_uses_persistent_platform_profile(self):
        for _ in range(2):
            with common.open_browser(os_name='windows', platform='boss') as page:
                self.assertIsNotNone(page)
        self.assertEqual(len(_FakeCamoufox.calls), 2)
        dirs = [c.get('user_data_dir') for c in _FakeCamoufox.calls]
        self.assertEqual(dirs[0], dirs[1], '同一平台两次启动必须落在同一 profile 目录')
        self.assertEqual(dirs[0], str(common.profile_dir('boss')))
        for c in _FakeCamoufox.calls:
            self.assertTrue(c.get('persistent_context'))
            self.assertEqual(c.get('fingerprint'), FAKE_FP, '两次启动必须使用同一套指纹')
            self.assertNotIn('os', c, '传了固定指纹就不该再传 os（两者会互相矛盾）')

    def test_platforms_do_not_share_profile(self):
        with common.open_browser(platform='boss'):
            pass
        with common.open_browser(platform='liepin'):
            pass
        a, b = (c['user_data_dir'] for c in _FakeCamoufox.calls)
        self.assertNotEqual(a, b, '不同平台不能共用一个 profile（登录态会互相污染）')

    # ---------- 降级路径 ----------
    def test_concurrent_use_falls_back_to_temp_profile(self):
        lock = common._PROFILE_LOCKS.setdefault('boss', common.threading.Lock())
        self.assertTrue(lock.acquire(blocking=False))
        try:
            with mock.patch.object(common, 'log'):
                with common.open_browser(platform='boss') as page:
                    self.assertIsNotNone(page)
            used = _FakeCamoufox.calls[-1]['user_data_dir']
            self.assertNotEqual(used, str(common.profile_dir('boss')))
            self.assertFalse(Path(used).exists(), '降级用的一次性 profile 必须用完即删')
            self.assertEqual(_FakeCamoufox.calls[-1]['fingerprint'], FAKE_FP,
                             '降级后指纹仍须固定，否则登录态照样失效')
        finally:
            lock.release()

    def test_launch_failure_falls_back_to_temp_profile(self):
        _FakeCamoufox.fail_launches = 1
        with mock.patch.object(common, 'log'):
            with common.open_browser(platform='boss') as page:
                self.assertIsNotNone(page)
        self.assertEqual(len(_FakeCamoufox.calls), 2, 'persistent 启动失败应重试一次临时 profile')
        used = _FakeCamoufox.calls[-1]['user_data_dir']
        self.assertNotEqual(used, str(common.profile_dir('boss')))
        self.assertFalse(Path(used).exists())

    def test_caller_exception_is_not_retried(self):
        with self.assertRaises(ValueError):
            with common.open_browser(platform='boss'):
                raise ValueError('业务异常')
        self.assertEqual(len(_FakeCamoufox.calls), 1, '调用方异常不得被当成启动失败而重试')

    def test_profile_lock_released_after_use(self):
        with common.open_browser(platform='boss'):
            pass
        with common.open_browser(platform='boss') as page:
            self.assertIsNotNone(page)
        self.assertEqual(_FakeCamoufox.calls[-1]['user_data_dir'], str(common.profile_dir('boss')))

    # ---------- 退出登录 ----------
    def test_clear_session_removes_cookie_file_and_profile(self):
        common.cookie_file('boss').write_text('{"cookies": []}', encoding='utf-8')
        profile = common.profile_dir('boss')
        profile.mkdir(parents=True, exist_ok=True)
        (profile / 'localstore').mkdir()
        with mock.patch.object(common, 'log'):
            self.assertTrue(common.clear_session('boss'))
        self.assertFalse(common.cookie_file('boss').exists())
        self.assertFalse(profile.exists(), '退出登录必须清掉 profile，否则平台仍认成已登录')

    def test_clear_session_keeps_pinned_identity(self):
        f = common.identity_file('boss', 'windows')
        common._write_json_atomic(f, FAKE_FP)
        common.profile_dir('boss').mkdir(parents=True, exist_ok=True)
        with mock.patch.object(common, 'log'):
            common.clear_session('boss')
        self.assertTrue(f.exists(), '固定指纹必须保留：换指纹会被平台判成设备异常')

    def test_logout_retried_on_next_open_when_profile_locked(self):
        """浏览器还开着时删不掉 profile —— 必须留标记，下次独占时补删。

        否则「退出登录」点了等于没点：profile 里的 wt2 / localStorage 还在，
        下次打开平台依旧认为已登录。
        """
        import shutil as _shutil
        profile = common.profile_dir('boss')
        (profile / 'localstore').mkdir(parents=True, exist_ok=True)
        real_rmtree = _shutil.rmtree

        def boom(path, *a, **kw):
            if str(path) == str(profile):
                raise OSError('directory in use')
            return real_rmtree(path, *a, **kw)

        with mock.patch.object(common, 'log'), mock.patch.object(common.shutil, 'rmtree', side_effect=boom):
            common.clear_session('boss')
        self.assertTrue(common._pending_clear_file('boss').exists(), '删不掉时必须留下补删标记')
        self.assertTrue((profile / 'localstore').exists())

        # 下一次拿到独占锁时补删
        with mock.patch.object(common, 'log'):
            with common.open_browser(platform='boss'):
                pass
        self.assertFalse(common._pending_clear_file('boss').exists())
        self.assertEqual(list(profile.iterdir()), [], '残留 profile 内容必须被清空')


if __name__ == '__main__':
    unittest.main()
