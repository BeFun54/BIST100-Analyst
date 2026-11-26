@echo off
title BIST100 Analist V2
cd /d "%~dp0"
echo BIST100 Analist V2 baslatiliyor...

rem Tarayiciyi 2 saniye gecikmeyle ac (sunucu ayaga kalksin)
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:3010"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  echo Node.js bulunamadi; Python sunucusu deneniyor...
  py server.py
)

pause
