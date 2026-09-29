@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Risk Tide Map] Node.js was not found.
  echo Opening index.html directly. For the full OSM base map, install Node.js.
  echo.
  start "" "%~dp0index.html"
  pause
  exit /b 0
)

echo.
echo Starting Risk Tide Map...
echo Browser will open automatically at http://localhost:8080
echo Keep this window open while using the map.
echo.
node "%~dp0serve.js"
pause
