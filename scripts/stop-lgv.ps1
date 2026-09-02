param(
  [string]$ProjectDir = (Get-Location).Path,
  [int]$Port = 5177,
  [switch]$Check
)

$ErrorActionPreference = 'Continue'
$baseUrl = "http://127.0.0.1:$Port"
$projectRoot = [System.IO.Path]::GetFullPath($ProjectDir).TrimEnd('\')

function Write-Lgv($message) {
  Write-Host "[LGV] $message"
}

function Get-LgvJobs {
  $requestError = $null
  $response = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/jobs" -TimeoutSec 2 -ErrorAction SilentlyContinue -ErrorVariable requestError
  if ($null -ne $response -and -not $requestError) {
    return $response
  }
  return $null
}

function Test-LgvStopped {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-LgvJobs)) {
      return $true
    }
  }
  return $false
}

Write-Host ''
Write-Host '=========================================='
Write-Host 'LGV - выключение сервиса'
Write-Host '=========================================='
Write-Host "Папка проекта: $projectRoot"
Write-Host "Адрес сервиса: $baseUrl"
Write-Host ''

if ($Check) {
  Write-Lgv 'Проверка батника выключения пройдена.'
  exit 0
}

$jobsResponse = Get-LgvJobs
if (-not $jobsResponse) {
  Write-Lgv 'Сервис LGV не отвечает. Возможно, он уже выключен.'
  exit 0
}

if (-not ($jobsResponse.PSObject.Properties.Name -contains 'jobs')) {
  Write-Lgv 'На этом адресе отвечает не LGV. Выключение отменено.'
  exit 2
}

$jobs = @($jobsResponse.jobs)
$activeJobs = @($jobs | Where-Object { $_.status -eq 'queued' -or $_.status -eq 'running' })

if ($activeJobs.Count -gt 0) {
  Write-Lgv 'Сейчас есть активные задачи. Сервис не будет выключен.'
foreach ($job in $activeJobs) {
    $label = $job.status
    if ($job.stage) {
      $label = $job.stage
    }
    Write-Host "  - $($job.id): $label"
  }
  exit 3
}

Write-Lgv 'Отправляю запрос на мягкое выключение...'
$shutdownError = $null
$shutdownResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/shutdown" -TimeoutSec 3 -ErrorAction SilentlyContinue -ErrorVariable shutdownError
if ($shutdownError -or $null -eq $shutdownResponse) {
  Write-Lgv 'Этот запущенный сервер еще не поддерживает мягкое выключение.'
  Write-Lgv 'Запустите обновленный LGV, затем используйте Stop-LGV.bat.'
  exit 4
}

if (Test-LgvStopped) {
  Write-Lgv 'Сервис выключен.'
  exit 0
}

Write-Lgv 'Не удалось подтвердить выключение сервиса.'
exit 5
