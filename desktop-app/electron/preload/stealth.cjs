// electron/preload/stealth.cjs —— 内置浏览器「主世界」反检测补丁 + 指纹自检
//
// ===== 为什么独立成模块、以「源码字符串」形式导出 =====
// <webview preload> 与 session.setPreloads 注册的脚本都运行在**隔离世界**
// （contextIsolation: true 时），在隔离世界改 navigator 对页面完全无效。
// 补丁必须在**主世界**执行，因此本模块只产出字符串，由两条通道各自注入：
//   通道①（早，preload 阶段）：webview.cjs 里 require 本模块后 webFrame.executeJavaScript(code)
//   通道②（兜底）：main.cjs 在 did-start-loading / dom-ready 上 wc.executeJavaScript(code)
// 两条通道都幂等（注入脚本内有 __bossclawStealth 标记守卫），先后顺序无妨。
//
// ===== 开关（便于二分定位副作用）=====
// 环境变量 BOSSCLAW_STEALTH：
//   off            → 完全关闭补丁（仅探针可用）
//   only=a,b       → 只开启列出的补丁项
//   skip=a,b       → 除列出的补丁项外全部开启（默认）
// 补丁项名见 PATCH_KEYS。
'use strict';

// 补丁项清单（每一项都可单独开关，出问题时可二分定位）
const PATCH_KEYS = [
  'webdriver',      // navigator.webdriver → false
  'uaCh',           // User-Agent Client Hints 与 UA 字符串对齐（补 Google Chrome 品牌）
  'plugins',        // navigator.plugins / mimeTypes 补齐（真 Chrome 固定 5 项 PDF 插件）
  'languages',      // navigator.languages → 真实中文 Chrome 的多语言列表
  'notification',   // Notification.permission 修正为 default（并保持 permissions.query 一致）
  'chromeObject',   // window.chrome.runtime 兜底存在
  'toStringGuard',  // 被改写的函数 toString 伪装为 native code（防注入自曝）
];

// ===== 默认关闭项（实测驱动，不是推测）=====
// 依据 2026-10-02 在 Electron 31.7.7 / Chromium 126.0.6478.234 上跑出的真实基线
// （desktop-app/tmp/stealth-probe/out/baseline-webview.json）：
//   webdriver : 实测 navigator.webdriver === false —— 本来就对，改写只会引入风险
//   plugins   : 实测已有 5 项标准 PDF 插件、2 项 mimeTypes、instanceof PluginArray === true —— 完全正常
//               （首版补丁反而把 isPluginArray 改成了 false，等于自己制造破绽）
//   languages : 实测 ['zh-CN','zh-Hans-CN'] —— 是否异常必须用真机 Chrome 对照才能判定，未判定前不动
// 教训：静态推断的 3 项高风险里有 2 项（plugins/mimeTypes、webdriver）实测证伪。
const DEFAULT_OFF = ['webdriver', 'plugins', 'languages'];

const STEALTH_VERSION = 1;
const STEALTH_MARK = '__bossclawStealth';

/**
 * 解析环境变量得到启用的补丁项。
 *   BOSSCLAW_STEALTH 语法：off | only=a,b | skip=a,b
 *   默认集 = PATCH_KEYS - DEFAULT_OFF - skip
 * 不变量：只要有任何补丁启用，toStringGuard 必定启用 ——
 *   否则被改写函数的源码会直接暴露给页面，补丁本身成为最强特征。
 */
function resolveEnabled() {
  const raw = String(process.env.BOSSCLAW_STEALTH || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return [];
  let list;
  if (raw.startsWith('only=')) {
    const want = raw.slice(5).split(',').map((s) => s.trim()).filter(Boolean);
    list = PATCH_KEYS.filter((k) => want.includes(k));
  } else {
    const skipMatch = /(?:^|;)skip=([^;]*)/.exec(raw);
    const skip = skipMatch ? skipMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    list = PATCH_KEYS.filter((k) => !DEFAULT_OFF.includes(k) && !skip.includes(k));
  }
  if (list.length > 0 && !list.includes('toStringGuard')) list.push('toStringGuard');
  return list;
}

/**
 * 构建主世界补丁源码。
 * 约束：注入源码内部**不使用反引号与 ${}**，避免与外层模板字符串冲突。
 * @param {{enabled?: string[]}} [opts]
 */
function buildStealthScript(opts) {
  const enabled = (opts && opts.enabled) || resolveEnabled();
  const flags = JSON.stringify(enabled.reduce((acc, k) => { acc[k] = true; return acc; }, {}));
  return `(function(){
  'use strict';
  if (window.${STEALTH_MARK}) return;
  try {
    Object.defineProperty(window, '${STEALTH_MARK}', { value: ${STEALTH_VERSION}, enumerable: false, configurable: false });
  } catch (e) { window.${STEALTH_MARK} = ${STEALTH_VERSION}; }

  var ON = ${flags};
  var _nativeToString = Function.prototype.toString;
  var _patched = new WeakMap();

  // 让被改写的函数在 toString() 时仍返回 native code —— 否则补丁本身成为最强特征。
  // 用 WeakMap 按「函数实例 → 伪装串」登记（标准做法）。首版采用「每次 disguise 都覆盖
  // Function.prototype.toString」的写法，实测会让 String(Function.prototype.toString)
  // 返回 "function query() { [native code] }"（函数名错位），本身就是可检测破绽。
  function disguise(fn, name) {
    try { _patched.set(fn, 'function ' + (name || '') + '() { [native code] }'); } catch (e) {}
    return fn;
  }

  // 安装 toString 守卫（幂等）。守卫自身也登记，使
  // Function.prototype.toString.call(Function.prototype.toString) 仍返回标准形式。
  function installToStringGuard() {
    try {
      var cur = Function.prototype.toString;
      if (_patched.has(cur)) return;
      var shim = function toString() {
        if (_patched.has(this)) return _patched.get(this);
        return _nativeToString.call(this);
      };
      _patched.set(shim, 'function toString() { [native code] }');
      Function.prototype.toString = shim;
    } catch (e) {}
  }

  function def(target, prop, getter, name) {
    try {
      Object.defineProperty(target, prop, { get: getter, set: undefined, configurable: true, enumerable: true });
    } catch (e) {}
  }

  // ===== 1. navigator.webdriver =====
  if (ON.webdriver) {
    try {
      if (navigator.webdriver !== false) {
        def(Navigator.prototype, 'webdriver', disguise(function () { return false; }, 'get webdriver'));
      }
    } catch (e) {}
  }

  // ===== 2. UA-CH 与 UA 字符串对齐 =====
  // 根因（实测确认）：Electron 的 UA-CH brands 只有 ["Not/A)Brand","Chromium"]，
  // 而 UA 字符串自称 Chrome/126 —— 缺 Google Chrome 品牌是可直接判定的矛盾。
  // 做法：**保留原生条目与顺序**（含原生 grease 品牌及其版本），只插入 Google Chrome；
  //   高熵值先取原生结果再补 brand —— 不硬编码 platformVersion 之类（硬编码会与真机不符）。
  if (ON.uaCh) {
    try {
      var nativeUAD = navigator.userAgentData;
      var ua = navigator.userAgent || '';
      var m = /Chrome\\/([0-9.]+)/.exec(ua);
      var full = m ? m[1] : '';
      var major = full ? full.split('.')[0] : '';
      var isGrease = function (b) { return /^Not/i.test(b && b.brand); };

      if (nativeUAD && full) {
        // 把 brand 列表补齐为真实 Chrome 形态：normal 项 + Google Chrome + 原生 grease 项
        var withGoogleChrome = function (list, ver) {
          var normal = [], grease = [];
          for (var i = 0; i < list.length; i++) (isGrease(list[i]) ? grease : normal).push(list[i]);
          for (var j = 0; j < normal.length; j++) { if (normal[j].brand === 'Google Chrome') return list; }
          return normal.concat([{ brand: 'Google Chrome', version: ver }], grease);
        };

        var brands = withGoogleChrome(Array.prototype.slice.call(nativeUAD.brands || []), major);

        var uaData = {
          brands: brands,
          mobile: nativeUAD.mobile,
          platform: nativeUAD.platform,
          getHighEntropyValues: disguise(function (hints) {
            return nativeUAD.getHighEntropyValues(hints).then(function (res) {
              try {
                if (res && res.brands) res.brands = withGoogleChrome(Array.prototype.slice.call(res.brands), major);
                if (res && res.fullVersionList) res.fullVersionList = withGoogleChrome(Array.prototype.slice.call(res.fullVersionList), full);
              } catch (e) {}
              return res;
            });
          }, 'getHighEntropyValues'),
          toJSON: disguise(function () {
            return { brands: brands, mobile: nativeUAD.mobile, platform: nativeUAD.platform };
          }, 'toJSON')
        };
        def(Navigator.prototype, 'userAgentData', disguise(function () { return uaData; }, 'get userAgentData'));
      }
    } catch (e) {}
  }

  // ===== 3. plugins / mimeTypes =====
  // 真 Chrome（Win）固定 5 项 PDF 相关插件；空数组是公认的自动化 tell。
  if (ON.plugins) {
    try {
      var PLUGIN_DEFS = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', desc: 'Portable Document Format' }
      ];
      var MIME_DEFS = [
        { type: 'application/pdf', suffixes: 'pdf', desc: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', desc: 'Portable Document Format' }
      ];
      // 用 PluginArray.prototype 作为原型，保证 instanceof / item() 等行为自然
      function makeArrayLike(defs, proto, factory) {
        var arr = Object.create(proto || Object.prototype);
        for (var i = 0; i < defs.length; i++) arr[i] = factory(defs[i], i);
        Object.defineProperty(arr, 'length', { value: defs.length, enumerable: false });
        Object.defineProperty(arr, 'item', {
          value: disguise(function (idx) { return this[idx] || null; }, 'item'), enumerable: false
        });
        Object.defineProperty(arr, 'namedItem', {
          value: disguise(function (nm) {
            for (var j = 0; j < this.length; j++) { if (this[j] && this[j].name === nm) return this[j]; }
            return null;
          }, 'namedItem'), enumerable: false
        });
        try { arr[Symbol.iterator] = Array.prototype[Symbol.iterator]; } catch (e) {}
        return arr;
      }
      // 原型必须取 MimeTypeArray.prototype / PluginArray.prototype —— 传 null 会让
      // instanceof 变成 false，等于把原本正常的 plugins 改坏（首版实测 isPluginArray: true → false）。
      var mimes = makeArrayLike(MIME_DEFS, MimeTypeArray.prototype, function (d) {
        var o = Object.create(MimeType.prototype);
        try { Object.defineProperties(o, {
          type: { value: d.type, enumerable: true },
          suffixes: { value: d.suffixes, enumerable: true },
          description: { value: d.desc, enumerable: true },
          enabledPlugin: { value: null, enumerable: true }
        }); } catch (e) {}
        return o;
      });
      var plugins = makeArrayLike(PLUGIN_DEFS, PluginArray.prototype, function (d) {
        var o = Object.create(Plugin.prototype);
        try { Object.defineProperties(o, {
          name: { value: d.name, enumerable: true },
          filename: { value: d.filename, enumerable: true },
          description: { value: d.desc, enumerable: true },
          length: { value: MIME_DEFS.length, enumerable: false }
        }); } catch (e) {}
        for (var k = 0; k < MIME_DEFS.length; k++) { try { o[k] = mimes[k]; } catch (e) {} }
        try { o.item = disguise(function (idx) { return this[idx] || null; }, 'item'); } catch (e) {}
        try { o.namedItem = disguise(function (t) {
          for (var j = 0; j < this.length; j++) { if (this[j] && (this[j].type === t)) return this[j]; }
          return null;
        }, 'namedItem'); } catch (e) {}
        return o;
      });
      // MimeType.enabledPlugin 指向对应插件，保持双向一致
      for (var mi = 0; mi < mimes.length; mi++) {
        try { Object.defineProperty(mimes[mi], 'enabledPlugin', { value: plugins[0], enumerable: true }); } catch (e) {}
      }
      def(Navigator.prototype, 'plugins', disguise(function () { return plugins; }, 'get plugins'));
      def(Navigator.prototype, 'mimeTypes', disguise(function () { return mimes; }, 'get mimeTypes'));
    } catch (e) {}
  }

  // ===== 4. languages =====
  if (ON.languages) {
    try {
      var cur = Array.prototype.slice.call(navigator.languages || []);
      if (cur.length < 3) {
        var want = ['zh-CN', 'zh', 'en'];
        def(Navigator.prototype, 'languages', disguise(function () { return want.slice(); }, 'get languages'));
        def(Navigator.prototype, 'language', disguise(function () { return 'zh-CN'; }, 'get language'));
      }
    } catch (e) {}
  }

  // ===== 5. Notification.permission =====
  // 实测：Electron 里首访即为 'granted'（比推断的 'denied' 更可疑 —— 真 Chrome 未授权时为 'default'，
  // 没有哪家站点会自动获得通知授权）。必须**两处同时改**：Notification.permission 与
  // permissions.query，否则两者不一致本身就是新的可检测矛盾（首版正是踩了这个坑）。
  // 语义对应：Notification.permission === 'default'  ↔  query({name:'notifications'}).state === 'prompt'
  if (ON.notification) {
    try {
      var TARGET_STATE = 'default';
      if (window.Notification && Notification.permission !== TARGET_STATE) {
        def(Notification, 'permission', disguise(function () { return TARGET_STATE; }, 'get permission'));
      }
      if (navigator.permissions && navigator.permissions.query) {
        var _query = navigator.permissions.query.bind(navigator.permissions);
        var patched = disguise(function (desc) {
          var name = desc && desc.name;
          if (name === 'notifications') {
            return Promise.resolve({
              state: 'prompt', name: 'notifications', onchange: null,
              addEventListener: function () {}, removeEventListener: function () {},
              dispatchEvent: function () { return false; }
            });
          }
          return _query(desc);
        }, 'query');
        try {
          Object.defineProperty(navigator.permissions, 'query', { value: patched, configurable: true, enumerable: true });
        } catch (e) {}
      }
    } catch (e) {}
  }

  // ===== 6. window.chrome 兜底 =====
  if (ON.chromeObject) {
    try {
      if (!window.chrome) Object.defineProperty(window, 'chrome', { value: {}, enumerable: true, configurable: true });
      if (!window.chrome.runtime) {
        try { window.chrome.runtime = {}; } catch (e) {}
      }
    } catch (e) {}
  }

  // ===== 7. toString 守卫（必须最后执行 —— 前面所有 disguise 只是往 _patched 登记）=====
  if (ON.toStringGuard) installToStringGuard();
})();`;
}

// =====================================================================
// 指纹自检：把「内置浏览器与真实 Chrome 的差异」变成可测数据。
// 只读、不 monkey-patch、不写 window（除返回用），全部 try/catch。
// 在**页面主世界**执行——站点能读到的，本探针都能读到。
// 返回 Promise<string>（含异步项：UA-CH 高熵值 / permissions.query），
// Electron 的 executeJavaScript 会等待 Promise resolve。
// =====================================================================
const PROBE_VERSION = 1;
const PROBE_SCRIPT = `(async function () {
  var out = {};
  var t = function (k, fn) {
    try { var v = fn(); out[k] = (v && typeof v.then === 'function') ? { __promise: true } : v; return v; }
    catch (e) { out[k] = { error: String((e && e.message) || e) }; }
  };
  var ta = function (k, fn) {
    return Promise.resolve().then(fn).then(function (v) { out[k] = v; },
      function (e) { out[k] = { error: String((e && e.message) || e) }; });
  };
  var pending = [];

  // ---------- 1. 身份 / UA ----------
  t('ua', function () {
    return {
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: Array.prototype.slice.call(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory == null ? null : navigator.deviceMemory,
      cookieEnabled: navigator.cookieEnabled,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      webdriver: navigator.webdriver,
      doNotTrack: navigator.doNotTrack
    };
  });

  t('uaDataSync', function () {
    var d = navigator.userAgentData;
    if (!d) return { present: false };
    return { present: true, brands: d.brands, mobile: d.mobile, platform: d.platform };
  });

  pending.push(ta('uaDataHighEntropy', function () {
    var d = navigator.userAgentData;
    if (!d || !d.getHighEntropyValues) return { present: false };
    return d.getHighEntropyValues(['fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness'])
      .then(function (h) { return { present: true, value: h }; });
  }));

  // UA 声称的 Chrome 版本 vs UA-CH 声称的版本 —— 不一致即强特征
  t('uaConsistency', function () {
    var m = /Chrome\\/([0-9.]+)/.exec(navigator.userAgent || '');
    var uaVer = m ? m[1] : null;
    var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    var chromeBrand = null;
    for (var i = 0; i < brands.length; i++) {
      if (brands[i].brand === 'Google Chrome') chromeBrand = brands[i];
    }
    var uaMajor = uaVer ? uaVer.split('.')[0] : null;
    return {
      uaChromeVersion: uaVer,
      hasGoogleChromeBrand: !!chromeBrand,
      googleChromeBrandVersion: chromeBrand ? chromeBrand.version : null,
      brandCount: brands.length,
      uaBrandMismatch: !!(chromBrandVersion(chromeBrand) && uaMajor && chromBrandVersion(chromeBrand) !== uaMajor)
    };
    function chromBrandVersion(b) { return b ? b.version : null; }
  });

  // ---------- 2. chrome.* 运行时对象 ----------
  t('chromeObject', function () {
    var c = window.chrome;
    return {
      hasWindowChrome: typeof c !== 'undefined',
      keys: c ? Object.keys(c) : [],
      hasRuntime: !!(c && c.runtime),
      hasApp: !!(c && c.app),
      hasLoadTimes: !!(c && c.loadTimes),
      hasCsi: !!(c && c.csi),
      appIsInstalled: (c && c.app && c.app.isInstalled) || null
    };
  });

  // ---------- 3. 插件 / MIME ----------
  t('plugins', function () {
    var names = Array.prototype.slice.call(navigator.plugins || []).map(function (p) { return p.name; });
    var mimeTypes = Array.prototype.slice.call(navigator.mimeTypes || []).map(function (x) { return x.type; });
    return {
      count: names.length,
      names: names,
      mimeCount: mimeTypes.length,
      mimeTypes: mimeTypes,
      hasPdfViewer: names.some(function (n) { return /PDF/i.test(n); }),
      isPluginArray: (navigator.plugins instanceof PluginArray),
      hasItem: typeof (navigator.plugins || {}).item === 'function'
    };
  });

  // ---------- 4. 权限 ----------
  t('notificationPermission', function () {
    return { value: (window.Notification && Notification.permission) || null };
  });

  pending.push(ta('permissionsNotifications', function () {
    if (!navigator.permissions || !navigator.permissions.query) return { present: false };
    return navigator.permissions.query({ name: 'notifications' })
      .then(function (st) { return { present: true, state: st && st.state }; })
      .catch(function (e) { return { present: true, error: String((e && e.message) || e) }; });
  }));

  // ---------- 5. WebGL ----------
  t('webgl', function () {
    var probe = function (kind) {
      try {
        var c = document.createElement('canvas');
        var gl = kind === 'webgl2' ? c.getContext('webgl2') : (c.getContext('webgl') || c.getContext('experimental-webgl'));
        if (!gl) return { present: false };
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          present: true,
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION)
        };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    };
    var gl = probe('webgl');
    gl.softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(String(gl.renderer || '') + String(gl.vendor || ''));
    gl.webgl2Present = probe('webgl2').present;
    return gl;
  });

  // ---------- 6. 窗口 / 屏幕 ----------
  t('windowGeom', function () {
    return {
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenX: window.screenX, screenY: window.screenY,
      screen: {
        width: screen.width, height: screen.height,
        availWidth: screen.availWidth, availHeight: screen.availHeight,
        colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth
      },
      outerEqualsInner: window.outerWidth === window.innerWidth && window.outerHeight === window.innerHeight
    };
  });

  // ---------- 7. 原型链真实性（改造后必须复测，防补丁自曝）----------
  t('prototypeIntegrity', function () {
    var check = function (obj, path, fn) {
      try { return { path: path, src: String(fn).slice(0, 120), native: /\\[native code\\]/.test(Function.prototype.toString.call(fn)) }; }
      catch (e) { return { path: path, error: String((e && e.message) || e) }; }
    };
    return {
      permissionsQuery: check(navigator.permissions, 'permissions.query', navigator.permissions && navigator.permissions.query),
      fnToString: String(Function.prototype.toString).slice(0, 120),
      fnToStringIsNative: /\\[native code\\]/.test(Function.prototype.toString.call(Function.prototype.toString)),
      getPluginsDesc: (function () {
        try {
          var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
          return d ? { hasGetter: !!d.get, hasSetter: !!d.set, enumerable: d.enumerable, configurable: d.configurable } : null;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      })(),
      stealthMark: window.${STEALTH_MARK} || null
    };
  });

  // ---------- 8. 自动化 / Node 残留 ----------
  t('automationResidue', function () {
    var keys = Object.keys(window).filter(function (k) {
      return /^(__playwright|__puppeteer|__nightmare|cdc_|_phantom|__selenium|__webdriver|callSelenium)/i.test(k);
    });
    return {
      suspiciousWindowKeys: keys,
      hasProcess: typeof window.process !== 'undefined',
      hasRequire: typeof window.require !== 'undefined',
      hasModule: typeof window.module !== 'undefined',
      hasGlobal: typeof window.global !== 'undefined',
      hasBuffer: typeof window.Buffer !== 'undefined'
    };
  });

  // ---------- 9. 时区 / 字体 ----------
  t('misc', function () {
    return {
      timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })(),
      timezoneOffset: new Date().getTimezoneOffset(),
      isSecureContext: window.isSecureContext,
      speechVoices: (function () {
        try { return (window.speechSynthesis ? (speechSynthesis.getVoices() || []).length : null); } catch (e) { return null; }
      })()
    };
  });

  // ---------- 10. iframe 一致性（子框架是否与主世界同步）----------
  pending.push(ta('iframeConsistency', function () {
    return new Promise(function (resolve) {
      try {
        var f = document.createElement('iframe');
        f.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0';
        document.body.appendChild(f);
        var d = f.contentWindow;
        var r = {
          accessible: !!d,
          pluginsCount: d && d.navigator ? (d.navigator.plugins || []).length : null,
          languages: d && d.navigator ? Array.prototype.slice.call(d.navigator.languages || []) : null,
          webdriver: d && d.navigator ? d.navigator.webdriver : null,
          hasChrome: !!(d && d.chrome),
          uaDataPresent: !!(d && d.navigator && d.navigator.userAgentData)
        };
        try { document.body.removeChild(f); } catch (e) {}
        resolve(r);
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    });
  }));

  // ---------- 11. 定时器精度 ----------
  t('timerPrecision', function () {
    var MIN = 1e9;
    for (var i = 0; i < 50; i++) {
      var a = performance.now();
      var s = performance.now();
      while (performance.now() - s < 0.5) { /* spin */ }
      var d = performance.now() - a;
      if (d > 0 && d < MIN) MIN = d;
    }
    return { minTickMs: Number(MIN.toFixed(5)) };
  });

  out.__meta = {
    probeVersion: ${PROBE_VERSION},
    stealthVersion: window.${STEALTH_MARK} || null,
    electron: (navigator.userAgent.match(/Electron\\/([0-9.]+)/) || [])[1] || null,
    href: (location.href || '').slice(0, 120),
    origin: location.origin
  };

  try { await Promise.all(pending); } catch (e) {}
  return JSON.stringify(out);
})()`;

module.exports = {
  PATCH_KEYS,
  STEALTH_VERSION,
  STEALTH_MARK,
  PROBE_VERSION,
  PROBE_SCRIPT,
  buildStealthScript,
  resolveEnabled,
};
