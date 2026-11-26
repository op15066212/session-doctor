@echo off
rem Session Doctor launcher.
rem ASCII only on purpose: a .cmd read in the OEM code page mangles any non-ASCII
rem text that appears before/around quotes and parentheses. All Chinese prompts
rem live in launch.mjs, where Node handles UTF-8 properly.
setlocal
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found.
  echo   Install Node.js ^(https://nodejs.org^), or drop a portable electron at:
  echo     %APP%\vendor\electron\electron.exe
  pause
  exit /b 1
)
node "%APP%\launch.mjs" %*
if errorlevel 1 pause
endlocal
