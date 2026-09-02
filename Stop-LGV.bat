@echo off
setlocal EnableExtensions
chcp 65001 >nul
title LGV - выключение

cd /d "%~dp0"

set "LGV_STOP_CHECK=0"
if "%LGV_PORT%"=="" set "LGV_PORT=5177"

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--check" (
  set "LGV_STOP_CHECK=1"
  shift
  goto parse_args
)
set "LGV_PORT=%~1"
shift
goto parse_args

:args_done
set "LGV_STOP_SCRIPT=%~dp0scripts\stop-lgv.ps1"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] PowerShell не найден в PATH.
  echo.
  pause
  exit /b 1
)

if not exist "%LGV_STOP_SCRIPT%" (
  echo [ОШИБКА] Не найден файл scripts\stop-lgv.ps1.
  echo Запускайте батник из папки проекта LGV.
  echo.
  pause
  exit /b 1
)

if "%LGV_STOP_CHECK%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%LGV_STOP_SCRIPT%" -ProjectDir "%CD%" -Port %LGV_PORT% -Check
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%LGV_STOP_SCRIPT%" -ProjectDir "%CD%" -Port %LGV_PORT%
)

set "LGV_STOP_EXIT=%ERRORLEVEL%"
if not "%LGV_STOP_EXIT%"=="0" (
  echo.
  pause
)
exit /b %LGV_STOP_EXIT%
