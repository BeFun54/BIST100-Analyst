@echo off
title BIST100 Analyst
cd /d "%~dp0"
echo BIST100 Analyst baslatiliyor...

start "" http://localhost:3000
node server.js
pause