@echo off
rem Starts the Document Library so a phone/tablet on the SAME Wi-Fi can use it.
rem WARNING: there is no login. Anyone on your network can read, upload and delete files. Use only on a trusted network.
cd /d "%~dp0"
set LAN=1
echo Open this on your phone using one of these addresses, port 3000:
ipconfig | findstr /i "IPv4"
echo.
node --disable-warning=ExperimentalWarning server.js
pause
