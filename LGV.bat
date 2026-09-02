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
  echo.
  pause
  exit /b 0
)

echo [LGV] Запускаю сервер...
echo [LGV] Не закрывайте это окно, пока идет анализ или экспорт.
echo [LGV] Для остановки сервиса нажмите Ctrl+C в этом окне.
echo.

if "%LGV_AUTO_OPEN%"=="1" start "" "%LGV_URL%"

node "%~dp0src\server.js"
set "LGV_EXIT=%ERRORLEVEL%"

echo.
if not "%LGV_EXIT%"=="0" (
  echo [LGV] Сервер остановился с кодом %LGV_EXIT%.
) else (
  echo [LGV] Сервер остановлен.
)
echo.
pause
exit /b %LGV_EXIT%
