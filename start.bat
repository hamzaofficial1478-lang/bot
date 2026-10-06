@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing everything, this takes a minute or two...
  call npm install || goto :failed
  call npx playwright install chromium || goto :failed
)

call npm start
pause
exit /b 0

:failed
echo.
echo Setup didn't finish. Check your internet connection and try again.
pause
exit /b 1
