@echo off
setlocal EnableExtensions
chcp 65001 >nul
title LGV - Local Generation Video

cd /d "%~dp0"

set "LGV_CHECK=0"
set "LGV_AUTO_OPEN=1"

if "%LGV_PORT%"=="" set "LGV_PORT=5177"

if /I "%~1"=="--check" set "LGV_CHECK=1"
if /I "%~1"=="--no-browser" set "LGV_AUTO_OPEN=0"
if /I "%~2"=="--no-browser" set "LGV_AUTO_OPEN=0"

if not "%~1"=="" (
  if /I not "%~1"=="--check" (
    if /I not "%~1"=="--no-browser" (
      set "LGV_PORT=%~1"
    )
  )
)

set "LGV_URL=http://127.0.0.1:%LGV_PORT%"
set "LGV_PROJECT_DIR=%CD%"
set "LGV_LOG_DIR=%~dp0data\logs"
set "LGV_STDOUT_LOG=%LGV_LOG_DIR%\server.log"
set "LGV_STDERR_LOG=%LGV_LOG_DIR%\server-error.log"

echo.
echo ==========================================
echo LGV - локальная генерация видео
echo ==========================================
echo Папка проекта: %CD%
echo Адрес сервиса: %LGV_URL%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден в PATH.
  echo Установите Node.js 18 или новее, затем запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0src\server.js" (
  echo [ОШИБКА] Не найден файл src\server.js.
  echo Запускайте батник из папки проекта LGV.
  echo.
  pause
  exit /b 1
)

if "%LGV_CHECK%"=="1" (
  echo [LGV] Проверка батника пройдена.
  exit /b 0
)

echo [LGV] Проверяю, не запущен ли сервис уже...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri ($env:LGV_URL + '/api/jobs') -TimeoutSec 2 | Out-Null; exit 10 } catch { exit 0 }"

if "%ERRORLEVEL%"=="10" (
  echo [LGV] Сервис уже запущен. Второй сервер не стартую.
  if "%LGV_AUTO_OPEN%"=="1" start "" "%LGV_URL%"
  exit /b 0
)

if not exist "%LGV_LOG_DIR%" mkdir "%LGV_LOG_DIR%" >nul 2>nul

echo [LGV] Запускаю сервер в фоне...
echo [LGV] Окно закроется автоматически.
echo [LGV] Консольный лог: %LGV_STDOUT_LOG%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$node = (Get-Command node -ErrorAction Stop).Source; Start-Process -FilePath $node -ArgumentList @('src/server.js') -WorkingDirectory $env:LGV_PROJECT_DIR -WindowStyle Hidden -RedirectStandardOutput $env:LGV_STDOUT_LOG -RedirectStandardError $env:LGV_STDERR_LOG"
if errorlevel 1 (
  echo [ОШИБКА] Не удалось запустить сервер LGV.
  echo Подробности могут быть в файле: %LGV_STDERR_LOG%
  echo.
  pause
  exit /b 1
)

if "%LGV_AUTO_OPEN%"=="1" start "" "%LGV_URL%"
exit /b 0
