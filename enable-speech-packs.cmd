@echo off
chcp 936 >nul
setlocal EnableExtensions
REM ============================================================
REM  BossClaw 语音资源包 · 一键下载并启用
REM
REM  双击即可：默认安装「朗读 Kokoro + 语音识别 SenseVoice」，
REM  自动尝试加速镜像，校验体积与 sha256，解压落位到
REM  %APPDATA%\BossClaw\speech\models，并写好当前朗读模型偏好。
REM
REM  常用参数（可写在命令行）：
REM    enable-speech-packs.cmd --all              四套全装（朗读/识别/克隆）
REM    enable-speech-packs.cmd -Packs kokoro,melo
REM    enable-speech-packs.cmd -TtsPack melo      装完把朗读切到 MeloTTS
REM    enable-speech-packs.cmd -Force             已装也重装
REM    enable-speech-packs.cmd -SourceDir D:\pk   优先用本地已下载的归档
REM ============================================================

set "PS1=%~dp0enable-speech-packs.ps1"
if not exist "%PS1%" (
  echo [x] 没找到 enable-speech-packs.ps1
  echo     请确认本文件放在 BossClaw 项目根目录（与 start-bossclaw.cmd 同级）。
  echo.
  pause
  exit /b 1
)

set "ARGS=%*"
echo %* | findstr /I /C:"--all" >nul 2>&1 && set "ARGS=-Packs kokoro,melo,asr,clone"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %ARGS%
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [完成] 打开 BossClaw 后进入 设置 ^> 语音 即可看到「已安装」。
) else (
  echo [未完成] 可以直接重跑本脚本（支持断点续传），或手动从 Releases 下载后解压到 models 目录。
)
echo.
pause
exit /b %RC%
