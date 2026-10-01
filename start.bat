@echo off
rem Starts the Document Library on this PC only (http://localhost:3000) and opens it in your browser.
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node --disable-warning=ExperimentalWarning server.js
pause
