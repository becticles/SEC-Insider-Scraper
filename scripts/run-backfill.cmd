@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "ROOT=%~dp0.."
set "TOKEN_FILE=%ROOT%\data\collector-token.txt"
set "LOG_DIR=%ROOT%\logs"
set "LATEST=%LOG_DIR%\backfill-latest.json"
set "LOG=%LOG_DIR%\backfill.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

if not exist "%TOKEN_FILE%" (
  echo [%date% %time%] missing collector token file: "%TOKEN_FILE%" >> "%LOG%"
  exit /b 1
)

set /p TOKEN=<"%TOKEN_FILE%"
if "%TOKEN%"=="" (
  echo [%date% %time%] collector token file is empty >> "%LOG%"
  exit /b 1
)

echo [%date% %time%] starting backfill >> "%LOG%"

curl.exe --silent --show-error --fail --max-time 540 --output "%LATEST%" "http://127.0.0.1:3080/api/backfill?days=180&limit=500&token=%TOKEN%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo [%date% %time%] completed backfill; response: "%LATEST%" >> "%LOG%"
) else (
  echo [%date% %time%] backfill failed with exit code %EXIT_CODE% >> "%LOG%"
)

exit /b %EXIT_CODE%
