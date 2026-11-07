<#
.SYNOPSIS
    一键下载并启用 BossClaw 模拟面试的本地语音资源包（朗读 / 识别 / 克隆音色）。

.DESCRIPTION
    为什么需要它：四套资源共约 900MB，直接在国内访问 GitHub Releases 常常几十 KB/s 甚至超时。
    本脚本会依次尝试官方地址与几个加速镜像，下载后校验体积与 sha256，解压落位到应用的语音目录，
    并写好 manifest 与「当前朗读模型」偏好 —— 打开应用设置页即可看到「已安装」。

    落位（与 electron/speechInstall.cjs 完全一致）：
        <SpeechDir>/models/tts      朗读 Kokoro（24kHz，8 音色）
        <SpeechDir>/models/melo     朗读 MeloTTS（44.1kHz 单女声）
        <SpeechDir>/models/clone    克隆音色（ZipVoice + vocos 声码器）
        <SpeechDir>/models/asr      语音识别（SenseVoice 中英日韩粤）
    默认 SpeechDir = %APPDATA%\BossClaw\speech（打包版的 userData 位置）。

.PARAMETER Packs
    要安装的包：kokoro / melo / asr / clone / all。默认 kokoro,asr（能朗读 + 能语音作答的最小组合）。

.PARAMETER SpeechDir
    语音根目录。默认 %APPDATA%\BossClaw\speech；开发期想装到项目里可显式指定。

.PARAMETER TtsPack
    装完把哪套设为当前朗读模型：kokoro / melo。缺省 = 已装的那套（两套都装时用 kokoro）。

.PARAMETER Proxy
    本机代理，例如 http://127.0.0.1:7890。下载全程走它（镜像也不通时兜底）。

.PARAMETER SourceDir
    离线模式：优先从这个目录找同名归档/文件（没有再去下载）。适合已手动下载过、或内网分发。

.PARAMETER Force
    已安装的包也重装。

.PARAMETER KeepArchive
    安装成功后保留下载的归档（默认删除，省 900MB 磁盘）。

.EXAMPLE
    .\enable-speech-packs.cmd
        # 装朗读 + 识别，自动选镜像，装完直接用

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\enable-speech-packs.ps1 -Packs all -TtsPack melo
        # 四套全装，并把朗读切到 MeloTTS
#>
[CmdletBinding()]
param(
    [ValidateSet('kokoro', 'melo', 'asr', 'clone', 'all')]
    [string[]]$Packs = @('kokoro', 'asr'),

    [string]$SpeechDir = '',

    [ValidateSet('', 'kokoro', 'melo')]
    [string]$TtsPack = '',

    [string]$SourceDir = '',

    [string]$Proxy = '',

    [switch]$Force,
    [switch]$KeepArchive,

    [string]$Repo = 'YanQuan-dozzy/Boss-Claw',
    # 语音资源包已并入应用自身的 Release（不再单独发资源包条目）
    [string]$Tag = 'v2.6.2'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PS 5.1 默认可能还在 TLS 1.0，GitHub 会直接断连
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ===== 资源清单（体积 / sha256 与 Release 上的 speech-packs.json 一致）=====
# 只在远端清单拿不到时用；远端清单优先，便于以后换版本不改脚本。
$MANIFEST = @{
    kokoro = @{
        label    = 'Kokoro 多语言（朗读）'
        dir      = 'tts'
        kind     = 'tar'
        assets   = @(@{ name = 'kokoro-multi-lang-v1_1.tar.gz'; bytes = 359038967; sha256 = 'a64dd0db91f97d1fe3175756d6ea1f9966744183a496fdc7c3865933f77927f5' })
        required = @('model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data')
    }
    melo   = @{
        label    = 'MeloTTS 中英（朗读）'
        dir      = 'melo'
        kind     = 'tar'
        assets   = @(@{ name = 'vits-melo-tts-zh_en.tar.bz2'; bytes = 167006755; sha256 = 'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514' })
        required = @('model.onnx', 'tokens.txt', 'lexicon.txt')
    }
    clone  = @{
        label    = '克隆音色（ZipVoice + 声码器）'
        dir      = 'clone'
        kind     = 'tar'
        assets   = @(@{ name = 'zipvoice-clone-int8.tar.gz'; bytes = 158223368; sha256 = '0741ef7afe221da838758bc7afa2cc6fd410eac18778f55d53aae82046918a2c' })
        required = @('encoder.int8.onnx', 'decoder.int8.onnx', 'vocos_24khz.onnx', 'tokens.txt')
    }
    asr    = @{
        label    = 'SenseVoice 语音识别'
        dir      = 'asr'
        kind     = 'files'
        assets   = @(
            @{ name = 'sensevoice-model.int8.onnx'; save = 'model.int8.onnx'; bytes = 239233841; sha256 = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
            @{ name = 'sensevoice-tokens.txt'; save = 'tokens.txt'; bytes = 315894; sha256 = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' }
        )
        required = @('model.int8.onnx', 'tokens.txt')
    }
}

# 加速镜像前缀（拼在 https://github.com/... 之前）；第一个是官方直连
$MIRRORS = @('', 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://gh-proxy.net/')

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    [OK] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    [!] $text" -ForegroundColor Yellow }
function Write-Err2($text) { Write-Host "    [x] $text" -ForegroundColor Red }

function Format-Bytes([double]$bytes) {
    if ($bytes -ge 1GB) { return ('{0:N2} GB' -f ($bytes / 1GB)) }
    if ($bytes -ge 1MB) { return ('{0:N0} MB' -f ($bytes / 1MB)) }
    return ('{0:N0} KB' -f ($bytes / 1KB))
}

function Get-DefaultSpeechDir {
    if ($env:APPDATA) { return (Join-Path $env:APPDATA 'BossClaw\speech') }
    return (Join-Path $env:LOCALAPPDATA 'BossClaw\speech')
}

function Test-PackInstalled($def) {
    $target = Join-Path $ModelsDir $def.dir
    foreach ($f in $def.required) {
        $p = Join-Path $target $f
        if (-not (Test-Path -LiteralPath $p)) { return $false }
        $item = Get-Item -LiteralPath $p
        if ($item.PSIsContainer) { continue }
        # 挡「存在但 0 字节」的半成品；MeloTTS 的 tokens.txt 只有 655B，别拿 1KB 一刀切
        if ($item.Length -lt 32) { return $false }
        if ($f -like '*.onnx' -and $item.Length -lt 1MB) { return $false }
    }
    return $true
}

function Get-RemoteManifest {
    # 远端清单只是「加分项」：拿不到就用脚本内置的哈希，不让网络问题阻断安装
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) 'bossclaw-speech-packs.json'
    foreach ($m in $MIRRORS) {
        $url = "${m}https://github.com/$Repo/releases/download/$Tag/speech-packs.json"
        try {
            $args0 = @('-fsSL', '--connect-timeout', '15', '--max-time', '30', '-o', $tmp, $url)
            $args0 = (Get-CurlProxyArgs) + $args0
            $eap0 = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { & curl.exe @args0 2>$null } finally { $ErrorActionPreference = $eap0 }
            if ($LASTEXITCODE -ne 0) { continue }
            # 落盘再按 UTF-8 读：curl 直接输出会被控制台代码页（GBK）截断成乱码
            $raw = Get-Content -LiteralPath $tmp -Raw -Encoding UTF8
            $json = $raw | ConvertFrom-Json
            if ($json.packs) { Write-Ok "已取到远端校验清单（$Tag）"; return $json.packs }
        } catch { }
    }
    Write-Warn2 '取不到远端校验清单，使用脚本内置的体积 / sha256'
    return $null
}

function Get-CurlProxyArgs {
    if ($Proxy) { return @('--proxy', $Proxy) }
    return @()
}

function Invoke-Download($assetName, $expectBytes, $dest) {
    $githubUrl = "https://github.com/$Repo/releases/download/$Tag/$assetName"
    if (Test-Path -LiteralPath $dest) {
        $have = (Get-Item -LiteralPath $dest).Length
        if ($expectBytes -gt 0 -and $have -eq $expectBytes) {
            Write-Ok "已有完整归档，跳过下载：$assetName"
            return $true
        }
    }
    foreach ($m in $MIRRORS) {
        $url = "$m$githubUrl"
        $label = '官方直连'
        if ($m -ne '') { $label = $m.TrimEnd('/') }
        Write-Host ("    尝试 {0} …" -f $label) -ForegroundColor DarkGray
        # -C - 断点续传：上一轮镜像断在中途也能接上
        $curlArgs = @('-fL', '-sS', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '-C', '-', '-o', $dest, $url)
        $curlArgs = (Get-CurlProxyArgs) + $curlArgs
        # 原生程序写 stderr 会被 EAP=Stop 当成终止错误直接中断脚本 —— 调 curl 期间必须放宽
        $eap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & curl.exe @curlArgs 2>$null } finally { $ErrorActionPreference = $eap }
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            Write-Warn2 ("{0} 失败（curl {1}）" -f $label, $code)
            continue
        }
        $size = 0
        if (Test-Path -LiteralPath $dest) { $size = (Get-Item -LiteralPath $dest).Length }
        if ($expectBytes -gt 0 -and $size -ne $expectBytes) {
            Write-Warn2 ("体积不符：{0} / 期望 {1}，换下一个镜像" -f (Format-Bytes $size), (Format-Bytes $expectBytes))
            continue
        }
        Write-Ok ("下载完成：{0}" -f (Format-Bytes $size))
        return $true
    }
    return $false
}

function Test-Hash($path, $sha256) {
    if (-not $sha256) { return $true }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $sha256.ToLowerInvariant()) {
        Write-Warn2 "sha256 不符（实际 $actual），删除后重试"
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        return $false
    }
    return $true
}

function Expand-ToTarget($archive, $target) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('bc-pack-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        & tar.exe -xf $archive -C $tmp
        if ($LASTEXITCODE -ne 0) { throw "解压失败（系统 tar 不可用或归档损坏）" }
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        $entries = @(Get-ChildItem -LiteralPath $tmp -Force)
        if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
            # 官方包形态：归档里只有一个顶层目录，拍平进去
            Get-ChildItem -LiteralPath $entries[0].FullName -Force | Move-Item -Destination $target -Force
        } else {
            # 本脚本自打包形态：内容直接在归档根
            $entries | Move-Item -Destination $target -Force
        }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-AppManifest($packKey, $dir, $bytes) {
    $path = Join-Path $SpeechDir 'manifest.json'
    $manifest = @{ packs = @{} }
    if (Test-Path -LiteralPath $path) {
        try {
            $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
            if ($raw.Trim()) {
                $parsed = $raw | ConvertFrom-Json
                if ($parsed.packs) {
                    # ConvertFrom-Json 出来的是 PSCustomObject，转回哈希表再合并
                    $manifest.packs = @{}
                    foreach ($p in $parsed.packs.PSObject.Properties) {
                        $manifest.packs[$p.Name] = $p.Value
                    }
                }
            }
        } catch { }
    }
    $manifest.packs[$packKey] = [pscustomobject]@{
        version     = $Tag
        installedAt = [int64](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds())
        bytes       = $bytes
        source      = "https://github.com/$Repo/releases/tag/$Tag"
    }
    $json = $manifest | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-ActiveTtsPack($pack) {
    $path = Join-Path $SpeechDir 'settings.json'
    $settings = @{}
    if (Test-Path -LiteralPath $path) {
        try {
            $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
            if ($raw.Trim()) {
                $parsed = $raw | ConvertFrom-Json
                foreach ($p in $parsed.PSObject.Properties) { $settings[$p.Name] = $p.Value }
            }
        } catch { }
    }
    $settings['ttsPack'] = $pack
    $json = $settings | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "当前朗读模型设为：$pack"
}

# ===== 开跑 =====
Write-Host ''
Write-Host '  BossClaw 语音资源包 · 一键下载并启用' -ForegroundColor White
Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray

if (-not $SpeechDir) { $SpeechDir = Get-DefaultSpeechDir }
$SpeechDir = [System.IO.Path]::GetFullPath($SpeechDir)
$ModelsDir = Join-Path $SpeechDir 'models'
$CacheDir = Join-Path $SpeechDir 'downloads'

if ($Packs -contains 'all') { $Packs = @('kokoro', 'melo', 'asr', 'clone') }
$Packs = @($Packs | Select-Object -Unique)

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Write-Err2 '系统没有 tar.exe（Windows 10 1803 以下）。请升级系统，或手动解压归档到 models/ 下。'
    exit 1
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Err2 '系统没有 curl.exe（Windows 10 1803+ 自带）。请在 Windows 设置里更新系统后再试。'
    exit 1
}

Write-Host ("  目标目录：{0}" -f $SpeechDir) -ForegroundColor Gray
Write-Host ("  计划安装：{0}" -f ($Packs -join ', ')) -ForegroundColor Gray
New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null

# 模型文件被占用时 Windows 解压 / 覆盖会失败，先提醒（不擅自杀进程）
$running = @(Get-Process -Name 'BossClaw', 'electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*BossClaw*' -or $_.Path -like '*desktop-app*' })
if ($running.Count -gt 0) {
    Write-Warn2 '检测到 BossClaw 正在运行：模型文件可能被占用。建议先退出应用再继续（本脚本会尝试覆盖）。'
}

$remote = Get-RemoteManifest

$failed = @()
foreach ($name in $Packs) {
    $def = $MANIFEST[$name]
    if (-not $def) { Write-Err2 "未知的包：$name"; $failed += $name; continue }

    Write-Step ("{0}  {1}" -f $name, $def.label)
    if (-not $Force -and (Test-PackInstalled $def)) {
        Write-Ok '已安装，跳过（要重装加 -Force）'
        continue
    }

    # 体积 / 哈希以远端清单为准，拿不到用内置值
    $assets = @()
    foreach ($a in $def.assets) {
        $item = @{ name = $a.name; bytes = $a.bytes; sha256 = $a.sha256 }
        if ($a.save) { $item.save = $a.save }
        if ($remote -and $remote.$name -and $remote.$name.assets) {
            $hit = @($remote.$name.assets | Where-Object { $_.name -eq $a.name })
            if ($hit.Count -gt 0) {
                if ($hit[0].bytes) { $item.bytes = [int64]$hit[0].bytes }
                if ($hit[0].sha256) { $item.sha256 = [string]$hit[0].sha256 }
            }
        }
        $assets += , $item
    }

    $okAll = $true
    $ready = @()      # 真正可用的本地文件（来源可能是下载，也可能是 -SourceDir）
    $downloaded = @() # 只记本脚本下载的，收尾清理只删这些
    foreach ($a in $assets) {
        $dest = Join-Path $CacheDir $a.name
        $local = ''
        if ($SourceDir) { $local = Join-Path $SourceDir $a.name }
        if ($local -and (Test-Path -LiteralPath $local)) {
            Write-Ok ("使用本地文件：{0}" -f $local)
            if (-not (Test-Hash $local $a.sha256)) { Write-Err2 ("{0} 校验失败" -f $a.name); $okAll = $false; break }
            $ready += $local
        } else {
            $got = Invoke-Download $a.name ([int64]$a.bytes) $dest
            if (-not $got) { Write-Err2 ("{0} 下载失败（所有镜像都不可用）" -f $a.name); $okAll = $false; break }
            if (-not (Test-Hash $dest $a.sha256)) { Write-Err2 ("{0} 校验失败" -f $a.name); $okAll = $false; break }
            $ready += $dest
            $downloaded += $dest
        }
    }
    if (-not $okAll) { $failed += $name; continue }

    $target = Join-Path $ModelsDir $def.dir
    try {
        if ($def.kind -eq 'tar') {
            Write-Host '    解压中…' -ForegroundColor DarkGray
            if ($ready.Count -eq 0) { throw '没有可用的归档文件' }
            Expand-ToTarget $ready[0] $target
        } else {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
            for ($i = 0; $i -lt $assets.Count; $i++) {
                $a = $assets[$i]
                $saveAs = $a.name
                if ($a.save) { $saveAs = $a.save }
                Copy-Item -LiteralPath $ready[$i] -Destination (Join-Path $target $saveAs) -Force
            }
        }
    } catch {
        Write-Err2 ("落位失败：{0}" -f $_.Exception.Message)
        $failed += $name
        continue
    }

    if (-not (Test-PackInstalled $def)) {
        Write-Err2 '安装后校验不通过（关键文件缺失或过小）'
        $failed += $name
        continue
    }

    $bytes = 0
    foreach ($f in Get-ChildItem -LiteralPath $target -Recurse -File) { $bytes += $f.Length }
    Update-AppManifest $name $def.dir $bytes
    Write-Ok ("已安装到 {0}（{1}）" -f $target, (Format-Bytes $bytes))

    if (-not $KeepArchive -and $downloaded.Count -gt 0) {
        foreach ($d in $downloaded) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue }
    }
}

# ===== 选当前朗读模型 =====
$kokoroOk = Test-PackInstalled $MANIFEST['kokoro']
$meloOk = Test-PackInstalled $MANIFEST['melo']
$want = $TtsPack
if (-not $want) {
    if ($kokoroOk) { $want = 'kokoro' }
    elseif ($meloOk) { $want = 'melo' }
}
if ($want) {
    $installed = ($want -eq 'kokoro' -and $kokoroOk) -or ($want -eq 'melo' -and $meloOk)
    if ($installed) { Set-ActiveTtsPack $want }
    else { Write-Warn2 ("指定的朗读模型 {0} 没有安装，保持应用原设置" -f $want) }
}

# ===== 汇总 =====
Write-Host ''
Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray
foreach ($name in @('kokoro', 'melo', 'asr', 'clone')) {
    $def = $MANIFEST[$name]
    $ok = Test-PackInstalled $def
    $state = '未安装'
    $color = 'DarkGray'
    if ($ok) { $state = '已安装'; $color = 'Green' }
    Write-Host ("    {0,-7} {1} {2}" -f $name, $def.label.PadRight(24), $state) -ForegroundColor $color
}

if ($failed.Count -gt 0) {
    Write-Err2 ("未完成：{0}" -f ($failed -join ', '))
    Write-Host '    可以重跑本脚本（支持断点续传）；或手动从 Releases 下载后解压到 models/ 对应目录。' -ForegroundColor Yellow
    exit 1
}

Write-Ok '全部完成。启动 BossClaw → 设置 → 语音，应显示「已安装」。'
Write-Host '    想换朗读模型：设置 → 语音 → 在 Kokoro / MeloTTS 那行点「切换到这套」。' -ForegroundColor Gray
exit 0
