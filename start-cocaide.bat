@echo off
rem One click: starts the Cocaide bridge (your Claude subscription through
rem Claude Code) and opens Cocaide already paired with it.
rem Put a shortcut to this file on your desktop. Close the "Cocaide bridge"
rem window to stop the bridge.

setlocal
cd /d "%~dp0"
set "SITE=https://mattymattmattmatt.github.io/Cocaide/"
set "BRIDGE=http://127.0.0.1:8787"
set "TOKENFILE=%USERPROFILE%\.cocaide-bridge\token"

where node >nul 2>nul || (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause & exit /b 1
)
where claude >nul 2>nul || (
  echo Claude Code is not installed. Installing it now...
  call npm install -g @anthropic-ai/claude-code || (pause & exit /b 1)
  echo.
  echo Now log in once: a Claude Code window opens. Log in with your Claude subscription, then type /exit.
  start "Claude Code login" /wait cmd /c claude
)
rem Keep the Cocaide folder up to date: the bridge runs the AI's tools from
rem this folder, so an old copy means an AI with old tools.
set "UPDATED="
if not exist .git goto updated
where git >nul 2>nul || goto updated
for /f %%r in ('git rev-parse HEAD') do set "OLDREV=%%r"
echo Checking for Cocaide updates...
rem npm install can rewrite the lock file; it is generated, so put it back first.
git checkout -q -- package-lock.json 2>nul
git pull -q --ff-only || (
  echo Could not update the Cocaide folder automatically ^(see above^). Carrying on with the copy you have.
  goto updated
)
for /f %%r in ('git rev-parse HEAD') do set "NEWREV=%%r"
if not "%OLDREV%"=="%NEWREV%" (
  set "UPDATED=1"
  echo Updated. Installing any new parts...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
:updated

if not exist node_modules (
  echo First run: installing Cocaide's parts, this takes a minute...
  call npm install || (pause & exit /b 1)
)

rem Updated while an old bridge is running? Stop it so the new one starts.
if defined UPDATED (
  taskkill /fi "WINDOWTITLE eq Cocaide bridge*" /t /f >nul 2>nul
  timeout /t 2 /nobreak >nul
)
curl -s -o nul %BRIDGE%/health && if defined UPDATED (
  echo An older bridge is still running in a window this launcher did not start.
  echo Close it ^(press Ctrl+C in that window^) and run this again.
  pause & exit /b 1
)

rem Already running? Then just open the page.
curl -s -o nul %BRIDGE%/health && goto open

echo Starting the bridge...
start "Cocaide bridge" /min cmd /k npm run bridge

rem Wait (up to about a minute) until it answers.
for /l %%i in (1,1,60) do (
  curl -s -o nul %BRIDGE%/health && goto open
  timeout /t 1 /nobreak >nul
)
echo The bridge did not start. Look at the "Cocaide bridge" window for the reason.
pause & exit /b 1

:open
if not exist "%TOKENFILE%" (
  echo No pairing token found at %TOKENFILE%. Look at the "Cocaide bridge" window.
  pause & exit /b 1
)
set /p TOKEN=<"%TOKENFILE%"
start "" "%SITE%#bridge=%BRIDGE%&token=%TOKEN%"
endlocal
