'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const PYTHON_DEPS_DIR = path.join(ROOT_DIR, '.deps', 'python');
const PYSCENEDETECT_SCRIPT = path.join(__dirname, 'pyscenedetect_runner.py');
const OPENCLIP_SCRIPT = path.join(__dirname, 'openclip_runner.py');
const PROJECT_PYTHON = path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe');
const PORT = Number(process.env.LGV_PORT || 5177);
const SHORTS_MAX_CLIP_SECONDS = 59.5;
const DEFAULT_CLIP_PADDING_SECONDS = 2;

const TOOLS = {
  python: process.env.LGV_PYTHON || (fs.existsSync(PROJECT_PYTHON) ? PROJECT_PYTHON : 'C:\\Users\\User\\AppData\\Local\\Programs\\Python\\Python310\\python.exe'),
  pySceneDetect: process.env.LGV_PYSCENEDETECT || path.join(PYTHON_DEPS_DIR, 'scenedetect'),
  ffmpeg: process.env.LGV_FFMPEG || 'E:\\AI\\Tools\\ffmpeg-release-essentials\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe',
  ffprobe: process.env.LGV_FFPROBE || 'E:\\AI\\Tools\\ffmpeg-release-essentials\\ffmpeg-9.0.1-essentials_build\\bin\\ffprobe.exe',
  whisper: process.env.LGV_WHISPER || 'E:\\AI\\Tools\\whisper-cublas-12.4.0-bin-x64\\Release\\whisper-cli.exe',
  whisperModel: process.env.LGV_WHISPER_MODEL || 'E:\\AI\\Models\\ggml-large-v3-turbo.bin',
};

const OPENCLIP_MODELS = [
  {
    key: 'vit_b_32',
    label: 'OpenCLIP ViT-B-32',
    modelName: 'ViT-B-32',
    path: process.env.LGV_OPENCLIP_MODEL || 'E:\\AI\\Models\\OpenCLIP\\ViT-B-32-laion2B-s34B-b79K\\open_clip_pytorch_model.bin',
  },
  {
    key: 'vit_l_14',
    label: 'OpenCLIP ViT-L-14',
    modelName: 'ViT-L-14',
    path: process.env.LGV_OPENCLIP_MODEL_L14 || 'E:\\AI\\Models\\OpenCLIP\\ViT-L-14-DataComp.XL-s13B-b90K\\open_clip_pytorch_model.bin',
  },
  {
    key: 'vit_l_14_download_duplicate',
    label: 'OpenCLIP ViT-L-14',
    modelName: 'ViT-L-14',
    path: process.env.LGV_OPENCLIP_MODEL_L14_ALT || 'E:\\AI\\Models\\OpenCLIP\\ViT-L-14-DataComp.XL-s13B-b90K\\open_clip_pytorch_model (1).bin',
  },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

const MODES = new Set(['balanced', 'action', 'dialog', 'emotion', 'comedy']);
const jobs = new Map();

const TOOL_LABELS = {
  python: 'Python',
  pySceneDetect: 'PySceneDetect',
  ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe',
  whisper: 'Whisper',
  whisperModel: 'модель Whisper',
  openClipModel: 'модель OpenCLIP',
  openClipPython: 'Python-пакеты OpenCLIP',
};

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function safeResolve(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Небезопасный путь к файлу.');
  }
  return target;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Слишком большой запрос.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicJob(job) {
  return serializeJob(job, 30);
}

function serializeJob(job, logLimit = 200) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    input: job.input,
    settings: job.settings,
    duration: job.duration,
    segments: job.segments || [],
    clips: job.clips,
    exports: job.exports,
    error: job.error,
    logs: job.logs.slice(-logLimit),
  };
}

function logJob(job, message) {
  job.logs.push({ at: new Date().toISOString(), message });
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
  job.updatedAt = new Date().toISOString();
}

async function persistJob(job) {
  try {
    const jobDir = path.join(JOBS_DIR, job.id);
    await fsp.mkdir(jobDir, { recursive: true });
    const target = path.join(jobDir, 'job.json');
    const temp = path.join(jobDir, 'job.tmp.json');
    await fsp.writeFile(temp, JSON.stringify(serializeJob(job), null, 2), 'utf8');
    await fsp.rename(temp, target);
  } catch (error) {
    console.error(`Не удалось сохранить задачу ${job.id}: ${error.message}`);
  }
}

function loadPersistedJobs() {
  if (!fs.existsSync(JOBS_DIR)) return;
  for (const entry of fs.readdirSync(JOBS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(JOBS_DIR, entry.name, 'job.json');
    if (!fs.existsSync(jobPath)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      if (!parsed.id) continue;
      jobs.set(parsed.id, {
        id: parsed.id,
        status: parsed.status || 'done',
        stage: parsed.stage || 'Готово',
        progress: Number(parsed.progress) || 100,
        createdAt: parsed.createdAt || new Date().toISOString(),
        updatedAt: parsed.updatedAt || parsed.createdAt || new Date().toISOString(),
        input: parsed.input || { videoPath: '' },
        settings: parsed.settings || {},
        duration: parsed.duration || null,
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        clips: Array.isArray(parsed.clips) ? parsed.clips : [],
        exports: Array.isArray(parsed.exports) ? parsed.exports : [],
        error: parsed.error || null,
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      });
    } catch (error) {
      console.error(`Не удалось загрузить задачу из ${jobPath}: ${error.message}`);
    }
  }
}

function hasActiveJobs() {
  return Array.from(jobs.values()).some((job) => job.status === 'queued' || job.status === 'running');
}

function activeJobLabels() {
  return Array.from(jobs.values())
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .map((job) => `${job.id.slice(0, 8)}: ${job.stage}`);
}

function setStage(job, stage, progress) {
  job.stage = stage;
  job.progress = progress;
  job.updatedAt = new Date().toISOString();
}

function cleanInputPath(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function positiveInt(value, min, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.round(num));
}

function clipPaddingSecondsForJob(job) {
  return clampNumber(job.settings?.clipPaddingSeconds, 0, 15, DEFAULT_CLIP_PADDING_SECONDS);
}

function maxClipSecondsForJob(job) {
  const requestedSeconds = (Number(job.settings?.clipMinutes) || 1) * 60;
  return clampNumber(requestedSeconds, 1, SHORTS_MAX_CLIP_SECONDS, SHORTS_MAX_CLIP_SECONDS);
}

function sourceSecondsForShortsClip(job) {
  const maxSeconds = maxClipSecondsForJob(job);
  const padding = clipPaddingSecondsForJob(job);
  return Math.max(1, maxSeconds - padding * 2);
}

function formatSeconds(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatCountRu(count, one, few, many) {
  const value = Math.abs(Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const word = mod100 >= 11 && mod100 <= 14
    ? many
    : mod10 === 1
      ? one
      : mod10 >= 2 && mod10 <= 4
        ? few
        : many;
  return `${count} ${word}`;
}

function filenameTime(seconds) {
  return formatSeconds(seconds).replaceAll(':', '-');
}

function sanitizeFilename(value) {
  return String(value || 'video')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'video';
}

function commandLineForLog(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
}

function runProcess(job, label, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const maxBuffer = options.maxBuffer || 120_000;
    let stdout = '';
    let stderr = '';

    logJob(job, `${label}: ${commandLineForLog(command, args)}`);

    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout = (stdout + text).slice(-maxBuffer);
      if (options.onStdout) options.onStdout(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-maxBuffer);
      if (options.onStderr) options.onStderr(text);
    });

    child.on('error', (error) => {
      reject(new Error(`${label}: не удалось запустить процесс: ${error.message}`));
    });

    child.on('close', (code) => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0) {
        logJob(job, `${label}: завершено за ${seconds} с`);
        resolve({ stdout, stderr });
      } else {
        const tail = (stderr || stdout).split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
        reject(new Error(`${label}: процесс завершился с кодом ${code}${tail ? `\n${tail}` : ''}`));
      }
    });
  });
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runSilentProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const maxBuffer = options.maxBuffer || 60_000;
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
    });

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-maxBuffer);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-maxBuffer);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function pythonPathForProject() {
  return [PYTHON_DEPS_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

async function checkPythonModules(modules) {
  if (!(await fileExists(TOOLS.python))) {
    return { ok: false, missing: modules, modules: Object.fromEntries(modules.map((name) => [name, false])) };
  }

  const script = [
    'import importlib.util, json',
    `mods = ${JSON.stringify(modules)}`,
    'missing = [m for m in mods if importlib.util.find_spec(m) is None]',
    'print(json.dumps({"ok": not missing, "missing": missing, "modules": {m: m not in missing for m in mods}}, ensure_ascii=False))',
  ].join('; ');

  try {
    const result = await runSilentProcess(TOOLS.python, ['-c', script], {
      env: {
        PYTHONPATH: pythonPathForProject(),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, missing: modules, modules: Object.fromEntries(modules.map((name) => [name, false])) };
  }
}

async function findOpenClipModel() {
  for (const model of OPENCLIP_MODELS) {
    if (await fileExists(model.path)) return model;
  }
  return null;
}

async function getToolStatus() {
  const entries = await Promise.all(
    Object.entries(TOOLS).map(async ([name, toolPath]) => ({
      name,
      path: toolPath,
      exists: await fileExists(toolPath),
    })),
  );
  const status = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  const pySceneDetectDeps = await checkPythonModules(['scenedetect']);
  if (status.pySceneDetect && !status.pySceneDetect.exists && pySceneDetectDeps.ok) {
    status.pySceneDetect = {
      name: 'pySceneDetect',
      path: 'Python import: scenedetect',
      exists: true,
    };
  }
  const openClipModel = await findOpenClipModel();
  const openClipDeps = await checkPythonModules(['torch', 'open_clip', 'PIL', 'numpy', 'cv2']);
  status.openClipModel = {
    name: 'openClipModel',
    path: openClipModel?.path || OPENCLIP_MODELS[0].path,
    exists: Boolean(openClipModel),
    label: openClipModel?.label || 'OpenCLIP',
  };
  status.openClipPython = {
    name: 'openClipPython',
    path: openClipDeps.ok ? 'torch, open_clip, PIL, numpy, cv2' : `не хватает: ${openClipDeps.missing.join(', ')}`,
    exists: openClipDeps.ok,
    missing: openClipDeps.missing,
  };
  return status;
}

function runPowerShellPicker(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: false });

    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Окно выбора было открыто слишком долго.'));
    }, 10 * 60 * 1000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? 'PowerShell не найден.' : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Окно выбора завершилось с кодом ${code}.`));
        return;
      }

      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

function videoFilePickerScript(initialDirectory = '') {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Write-Utf8([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
}
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Выберите видеофайл'
$dialog.Filter = 'Видео файлы|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.wmv;*.m4v;*.mpeg;*.mpg;*.mts;*.m2ts;*.ts;*.flv;*.3gp;*.3g2|Все файлы|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.AutoUpgradeEnabled = $true
$dialog.RestoreDirectory = $true
$initialDirectory = ${powerShellString(initialDirectory)}
if ($initialDirectory -and [System.IO.Directory]::Exists($initialDirectory)) {
  $dialog.InitialDirectory = $initialDirectory
}
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Utf8 $dialog.FileName
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;
}

function powerShellString(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

async function pickLocalVideoFile(initialPath) {
  const initialDirectory = await pickerInitialDirectory(initialPath);
  const selectedPath = await runPowerShellPicker(videoFilePickerScript(initialDirectory));
  if (!selectedPath) return { path: '' };

  const cleanPath = cleanInputPath(selectedPath);
  const stat = await fsp.stat(cleanPath);
  if (!stat.isFile()) throw new Error(`Это не файл: ${cleanPath}`);
  return { path: cleanPath };
}

async function resolveExportFilePath(rawPath) {
  const cleanPath = cleanInputPath(rawPath);
  if (!cleanPath) throw new Error('Путь к MP4 не указан.');

  const exportRoot = path.resolve(EXPORTS_DIR);
  const resolved = path.resolve(cleanPath);
  const normalizedRoot = exportRoot.toLowerCase();
  const normalizedResolved = resolved.toLowerCase();
  if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Можно открывать только файлы из папки экспорта LGV.');
  }

  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('MP4-файл не найден.');
  return resolved;
}

async function resolveLocalFilePath(rawPath, missingMessage = 'Файл не найден.') {
  const cleanPath = cleanInputPath(rawPath);
  if (!cleanPath) throw new Error('Путь к файлу не указан.');

  const resolved = path.resolve(cleanPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error(missingMessage);
  return resolved;
}

async function openWindowsFile(filePath, action) {
  const script = action === 'folder'
    ? `
$file = ${powerShellString(filePath)}
Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $file + '"')
`
    : `
$file = ${powerShellString(filePath)}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $file
$psi.UseShellExecute = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null
`;

  await runPowerShellPicker(script);
  return { ok: true };
}

async function openExportFile(rawPath, action) {
  const filePath = await resolveExportFilePath(rawPath);
  return openWindowsFile(filePath, action);
}

async function openLocalFile(rawPath, action) {
  const filePath = await resolveLocalFilePath(rawPath, 'Исходный видеофайл не найден.');
  return openWindowsFile(filePath, action);
}

async function pickerInitialDirectory(initialPath) {
  const cleanPath = cleanInputPath(initialPath);
  if (!cleanPath) return '';

  try {
    const stat = await fsp.stat(cleanPath);
    if (stat.isDirectory()) return cleanPath;
    if (stat.isFile()) return path.dirname(cleanPath);
  } catch {
    const parent = path.dirname(cleanPath);
    try {
      if ((await fsp.stat(parent)).isDirectory()) return parent;
    } catch {
      return '';
    }
  }

  return '';
}

async function assertRequiredTools(job, settings) {
  const status = await getToolStatus();
  const required = ['python', 'pySceneDetect', 'ffmpeg', 'ffprobe'];
  if (settings.useWhisper) required.push('whisper', 'whisperModel');
  const missing = required.filter((name) => !status[name].exists);
  if (missing.length) {
    const names = missing.map((name) => TOOL_LABELS[name] || name).join(', ');
    throw new Error(`Не найдены необходимые инструменты или модели: ${names}.`);
  }
}

async function getDuration(job, videoPath) {
  const result = await runProcess(job, 'Чтение длительности', TOOLS.ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Не удалось определить длительность видео.');
  }
  return duration;
}

async function extractAudio(job, videoPath, audioPath) {
  await runProcess(job, 'Извлечение аудио', TOOLS.ffmpeg, [
    '-y',
    '-hide_banner',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    audioPath,
  ], { maxBuffer: 40_000 });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mergeSceneMarkers(markers, minGapSeconds, duration) {
  const minTime = 0.5;
  const maxTime = Number.isFinite(duration) ? Math.max(minTime, duration - 0.5) : Infinity;
  const sorted = markers
    .filter((marker) => Number.isFinite(marker.time) && marker.time >= minTime && marker.time <= maxTime)
    .sort((a, b) => a.time - b.time);

  const merged = [];
  for (const marker of sorted) {
    const last = merged[merged.length - 1];
    if (!last || marker.time - last.time >= minGapSeconds) {
      merged.push({
        time: marker.time,
        score: marker.score || 0,
        sources: [marker.source],
      });
      continue;
    }

    last.score = Math.max(last.score, marker.score || 0);
    if (!last.sources.includes(marker.source)) last.sources.push(marker.source);
  }

  return merged;
}

function pythonPathForPySceneDetect() {
  return pythonPathForProject();
}

function parsePySceneDetectOutput(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error('PySceneDetect не вернул результат.');
  const payload = JSON.parse(text);
  if (!payload.ok) {
    throw new Error(payload.error || 'PySceneDetect не смог выполнить поиск сцен.');
  }
  return payload;
}

function normalizeSceneRanges(scenes, duration) {
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((scene) => ({
      start: clamp(Number(scene.start), 0, duration),
      end: clamp(Number(scene.end), 0, duration),
    }))
    .filter((scene) => (
      Number.isFinite(scene.start)
      && Number.isFinite(scene.end)
      && scene.end - scene.start >= 0.25
    ))
    .sort((a, b) => a.start - b.start);
}

async function scanSceneChanges(job, videoPath, settings, duration) {
  const minGapSeconds = clamp(settings.minSceneGapSeconds || 1.25, 0.5, 8);
  const sceneQuality = settings.sceneQuality === 'fast' ? 'fast' : 'precise';
  const sceneMode = settings.sceneMode === 'manual' ? 'manual' : 'auto';

  setStage(job, 'Ищу сцены через PySceneDetect', 30);
  const result = await runProcess(job, 'Поиск сцен PySceneDetect', TOOLS.python, [
    PYSCENEDETECT_SCRIPT,
    '--video', videoPath,
    '--quality', sceneQuality,
    '--scene-mode', sceneMode,
    '--scene-threshold', String(settings.sceneThreshold || 0.35),
    '--min-gap', String(minGapSeconds),
  ], {
    env: {
      PYTHONPATH: pythonPathForPySceneDetect(),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    maxBuffer: 240_000,
  });

  const payload = parsePySceneDetectOutput(result.stdout);
  const markers = mergeSceneMarkers(
    payload.times.map((time) => ({ time: Number(time), score: 1, source: 'PySceneDetect' })),
    minGapSeconds,
    duration,
  );

  return {
    times: markers.map((marker) => marker.time),
    markers,
    scenes: normalizeSceneRanges(payload.scenes, duration),
    modeLabel: sceneMode === 'manual' ? 'ручной' : 'авто',
    boundaryCount: payload.boundaryCount || markers.length,
    detectorLabel: (payload.detectors || []).join(', ') || 'PySceneDetect',
    thresholdLabel: payload.thresholds
      ? `контент ${payload.thresholds.content}, адаптивный ${payload.thresholds.adaptive}, яркость ${payload.thresholds.fade}`
      : 'по умолчанию',
    fps: payload.fps,
    minSceneLenFrames: payload.minSceneLenFrames,
    minGapSeconds,
    qualityLabel: sceneQuality === 'fast' ? 'быстрее' : 'точнее',
  };
}

function parseOpenClipOutput(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error('OpenCLIP не вернул результат.');
  const payload = JSON.parse(text);
  if (!payload.ok) {
    throw new Error(payload.error || 'OpenCLIP не смог выполнить анализ кадров.');
  }
  return payload;
}

async function analyzeOpenClip(job, videoPath, jobDir) {
  if (!(await fileExists(OPENCLIP_SCRIPT))) {
    throw new Error('скрипт OpenCLIP не найден.');
  }

  const model = await findOpenClipModel();
  if (!model) {
    throw new Error('модель OpenCLIP не найдена в E:\\AI\\Models\\OpenCLIP.');
  }

  const deps = await checkPythonModules(['torch', 'open_clip', 'PIL', 'numpy', 'cv2']);
  if (!deps.ok) {
    throw new Error(`не установлены Python-пакеты: ${deps.missing.join(', ')}.`);
  }

  const result = await runProcess(job, 'Нейроанализ кадров OpenCLIP', TOOLS.python, [
    OPENCLIP_SCRIPT,
    '--video', videoPath,
    '--model-path', model.path,
    '--model-name', process.env.LGV_OPENCLIP_MODEL_NAME || model.modelName,
    '--duration', String(job.duration || 0),
    '--sample-step', String(job.settings.openClipSampleStep || 8),
    '--max-frames', String(job.settings.openClipMaxFrames || 900),
    '--batch-size', String(job.settings.openClipBatchSize || 32),
    '--device', process.env.LGV_OPENCLIP_DEVICE || 'auto',
  ], {
    cwd: jobDir,
    env: {
      PYTHONPATH: pythonPathForProject(),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    maxBuffer: 2_000_000,
  });

  const payload = parseOpenClipOutput(result.stdout);
  payload.modelLabel = model.label;
  return payload;
}

async function analyzeEnergy(job, audioPath, jobDir) {
  const energyFile = path.join(jobDir, 'energy.txt');
  await runProcess(job, 'Анализ громкости', TOOLS.ffmpeg, [
    '-y',
    '-hide_banner',
    '-nostats',
    '-i', audioPath,
    '-af', 'asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=energy.txt',
    '-f', 'null',
    '-',
  ], { cwd: jobDir, maxBuffer: 30_000 });

  if (!(await fileExists(energyFile))) return [];

  const text = await fsp.readFile(energyFile, 'utf8');
  const points = [];
  let currentTime = 0;
  for (const line of text.split(/\r?\n/)) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) {
      currentTime = Number(timeMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=([-0-9.inf]+)/);
    if (rmsMatch) {
      const raw = rmsMatch[1];
      const rmsDb = raw === '-inf' ? -90 : Number(raw);
      if (Number.isFinite(currentTime) && Number.isFinite(rmsDb)) {
        points.push({ time: currentTime, rmsDb });
      }
    }
  }
  return points;
}

async function transcribe(job, audioPath, jobDir, settings) {
  const outBase = path.join(jobDir, 'transcript');
  await runProcess(job, 'Распознавание речи Whisper', TOOLS.whisper, [
    '-m', TOOLS.whisperModel,
    '-f', audioPath,
    '-l', settings.language,
    '-oj',
    '-of', outBase,
    '-np',
  ], { maxBuffer: 60_000 });

  const jsonPath = `${outBase}.json`;
  if (!(await fileExists(jsonPath))) {
    logJob(job, 'Распознавание речи Whisper: JSON-файл не найден, продолжаю без текста.');
    return [];
  }

  const parsed = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  return normalizeTranscript(parsed, job.duration);
}

function normalizeTranscript(parsed, duration) {
  const rawSegments = [];
  const source = Array.isArray(parsed.transcription)
    ? parsed.transcription
    : Array.isArray(parsed.segments)
      ? parsed.segments
      : [];

  for (const segment of source) {
    const text = String(segment.text || '').trim();
    const offsets = segment.offsets || {};
    let start = segment.start ?? segment.t0 ?? offsets.from;
    let end = segment.end ?? segment.t1 ?? offsets.to;

    if ((start === undefined || end === undefined) && typeof segment.timestamps === 'string') {
      const times = segment.timestamps.match(/[0-9:.]+/g) || [];
      if (times.length >= 2) {
        start = timecodeToSeconds(times[0]);
        end = timecodeToSeconds(times[1]);
      }
    }

    if (text && Number.isFinite(Number(start)) && Number.isFinite(Number(end))) {
      rawSegments.push({ start: Number(start), end: Number(end), text });
    }
  }

  if (!rawSegments.length) return [];
  const maxOffset = Math.max(...rawSegments.map((segment) => segment.end));
  const scale = maxOffset > duration * 1.5 ? 0.001 : 1;

  return rawSegments
    .map((segment) => ({
      start: Math.max(0, segment.start * scale),
      end: Math.max(0, segment.end * scale),
      text: segment.text,
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

function timecodeToSeconds(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function wordsOf(text) {
  return String(text).toLowerCase().match(/[a-zа-яё0-9]+/giu) || [];
}

const KEYWORDS = {
  action: [
    'fight', 'run', 'shoot', 'shot', 'kill', 'danger', 'crash', 'attack', 'escape', 'battle',
    'драка', 'беги', 'бежать', 'стреля', 'выстрел', 'убить', 'опасно', 'авария', 'атака', 'побег',
  ],
  emotion: [
    'love', 'hate', 'sorry', 'forgive', 'cry', 'death', 'truth', 'alone', 'afraid', 'please',
    'люблю', 'ненавижу', 'прости', 'прощай', 'плак', 'смерт', 'правда', 'один', 'страшно', 'пожалуйста',
  ],
  comedy: [
    'laugh', 'joke', 'funny', 'ridiculous', 'crazy', 'ха', 'смешно', 'шутк', 'дурак', 'безум',
  ],
  dialog: [
    'why', 'what', 'who', 'when', 'where', 'secret', 'because', 'remember',
    'почему', 'что', 'кто', 'когда', 'где', 'секрет', 'потому', 'помни',
  ],
};

const OPENCLIP_LABELS = {
  action: 'нейро: экшен',
  dialog: 'нейро: диалог',
  emotion: 'нейро: эмоции',
  comedy: 'нейро: юмор',
  visual: 'нейро: визуальный интерес',
  suspense: 'нейро: напряжение',
  calm: 'нейро: спокойный участок',
};

function countKeywordHits(words, mode) {
  const bags = mode === 'balanced'
    ? [...KEYWORDS.action, ...KEYWORDS.emotion, ...KEYWORDS.comedy, ...KEYWORDS.dialog]
    : [...(KEYWORDS[mode] || []), ...KEYWORDS.emotion];
  return countKeywordHitsForBag(words, bags);
}

function countKeywordHitsForBag(words, keywords) {
  return words.reduce(
    (count, word) => count + (keywords.some((keyword) => word.includes(keyword)) ? 1 : 0),
    0,
  );
}

function getOverlappingTranscript(segments, start, end) {
  return segments.filter((segment) => segment.start < end && segment.end > start);
}

function getWindowEnergy(points, start, end) {
  const windowPoints = points.filter((point) => point.time >= start && point.time < end);
  if (!windowPoints.length) return { avg: 0, peak: 0, spread: 0 };

  const values = windowPoints.map((point) => Math.max(0, Math.min(1, (point.rmsDb + 60) / 60)));
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const peak = Math.max(...values);
  const min = Math.min(...values);
  return { avg, peak, spread: peak - min };
}

function getWindowVisual(points, start, end) {
  const windowPoints = (points || []).filter((point) => point.time >= start && point.time < end);
  const keys = ['action', 'dialog', 'emotion', 'comedy', 'visual', 'suspense', 'calm'];
  const scores = Object.fromEntries(keys.map((key) => [key, 0]));
  if (!windowPoints.length) {
    return { scores, top: '', confidence: 0, count: 0 };
  }

  for (const point of windowPoints) {
    for (const key of keys) {
      scores[key] += Number(point.scores?.[key]) || 0;
    }
  }
  for (const key of keys) {
    scores[key] /= windowPoints.length;
  }

  const top = keys.reduce((best, key) => (scores[key] > scores[best] ? key : best), keys[0]);
  return {
    scores,
    top,
    confidence: scores[top] || 0,
    count: windowPoints.length,
  };
}

function normalizeCandidates(candidates, key) {
  const values = candidates.map((candidate) => candidate.raw[key]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    for (const candidate of candidates) candidate.features[key] = max > 0 ? 1 : 0;
    return;
  }
  for (const candidate of candidates) {
    candidate.features[key] = (candidate.raw[key] - min) / (max - min);
  }
}

function weightsForMode(mode) {
  const table = {
    balanced: { audio: 0.20, scene: 0.18, words: 0.20, emotion: 0.12, keyword: 0.08, visualInterest: 0.14, visualSuspense: 0.08 },
    action: { audio: 0.28, scene: 0.27, words: 0.04, emotion: 0.04, keyword: 0.04, visualAction: 0.22, visualMotion: 0.11 },
    dialog: { audio: 0.05, scene: 0.06, words: 0.48, emotion: 0.10, keyword: 0.12, visualDialog: 0.19 },
    emotion: { audio: 0.16, scene: 0.06, words: 0.18, emotion: 0.25, keyword: 0.12, visualEmotion: 0.17, visualSuspense: 0.06 },
    comedy: { audio: 0.10, scene: 0.06, words: 0.14, emotion: 0.08, keyword: 0.38, visualComedy: 0.24 },
  };
  return table[mode] || table.balanced;
}

function createSceneBoundaries(sceneTimes, duration) {
  const values = [0, duration, ...sceneTimes]
    .map(Number)
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= duration)
    .sort((a, b) => a - b);

  const unique = [];
  for (const time of values) {
    const last = unique[unique.length - 1];
    if (last === undefined || Math.abs(time - last) >= 0.25) unique.push(time);
  }
  if (unique[0] !== 0) unique.unshift(0);
  if (unique[unique.length - 1] !== duration) unique.push(duration);
  return unique;
}

function splitLongRange(range, targetSeconds) {
  const maxChunk = targetSeconds * 1.55;
  if (range.end - range.start <= maxChunk) return [range];

  const parts = [];
  for (let start = range.start; start < range.end - 0.01; start += targetSeconds) {
    parts.push({ start, end: Math.min(range.end, start + targetSeconds) });
  }

  const minTail = Math.min(90, targetSeconds * 0.35);
  const tail = parts[parts.length - 1];
  if (parts.length > 1 && tail.end - tail.start < minTail) {
    parts[parts.length - 2].end = tail.end;
    parts.pop();
  }
  return parts;
}

function splitRangeForShorts(range, sourceSeconds) {
  const duration = range.end - range.start;
  const safeSeconds = Math.max(1, Number(sourceSeconds) || SHORTS_MAX_CLIP_SECONDS);
  if (duration <= safeSeconds) return [range];

  const parts = [];
  for (let start = range.start; start < range.end - 0.01; start += safeSeconds) {
    parts.push({ start, end: Math.min(range.end, start + safeSeconds) });
  }

  return parts;
}

function splitRangesForShorts(ranges, sourceSeconds) {
  return ranges.flatMap((range) => splitRangeForShorts(range, sourceSeconds));
}

function buildMovieChunkRanges(duration, sceneTimes, targetSeconds) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (duration <= targetSeconds) return [{ start: 0, end: duration }];

  const boundaries = createSceneBoundaries(sceneTimes, duration);
  const ranges = [];
  let start = 0;

  for (let index = 1; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary - start >= targetSeconds || index === boundaries.length - 1) {
      ranges.push({ start, end: boundary });
      start = boundary;
    }
  }

  const split = ranges.flatMap((range) => splitLongRange(range, targetSeconds));
  const minChunk = Math.min(120, targetSeconds * 0.45);
  const last = split[split.length - 1];
  if (split.length > 1 && last.end - last.start < minChunk) {
    split[split.length - 2].end = last.end;
    split.pop();
  }

  return split.filter((range) => range.end - range.start >= 1);
}

function automaticSegmentLimits(duration) {
  if (duration >= 5400) return { minSeconds: 70, maxSeconds: 360 };
  if (duration >= 1800) return { minSeconds: 45, maxSeconds: 260 };
  if (duration >= 600) return { minSeconds: 30, maxSeconds: 190 };
  return { minSeconds: 12, maxSeconds: 95 };
}

function splitOversizedRange(range, maxSeconds) {
  const duration = range.end - range.start;
  if (duration <= maxSeconds) return [range];

  const count = Math.ceil(duration / maxSeconds);
  const step = duration / count;
  return Array.from({ length: count }, (_, index) => ({
    start: range.start + step * index,
    end: index === count - 1 ? range.end : range.start + step * (index + 1),
  }));
}

function baseSceneRangesFromAnalysis(duration, sceneAnalysis) {
  const sceneRanges = normalizeSceneRanges(sceneAnalysis.scenes, duration);
  if (sceneRanges.length) return sceneRanges;

  const boundaries = createSceneBoundaries(sceneAnalysis.times || [], duration);
  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1],
  }));
}

function buildWholeMovieBaseRanges(duration, sceneAnalysis) {
  const { maxSeconds } = automaticSegmentLimits(duration);
  const ranges = baseSceneRangesFromAnalysis(duration, sceneAnalysis);
  if (!ranges.length) return [{ start: 0, end: duration }];
  return ranges
    .flatMap((range) => splitOversizedRange(range, maxSeconds))
    .filter((range) => range.end - range.start >= 0.5);
}

function mergeWholeMovieCandidates(baseCandidates, duration) {
  const { minSeconds, maxSeconds } = automaticSegmentLimits(duration);
  const merged = [];
  let current = null;

  for (const candidate of baseCandidates) {
    if (!current) {
      current = {
        start: candidate.start,
        end: candidate.end,
        interestKey: candidate.interest.key,
      };
      continue;
    }

    const nextEnd = candidate.end;
    const currentDuration = current.end - current.start;
    const mergedDuration = nextEnd - current.start;
    const sameInterest = candidate.interest.key === current.interestKey;
    const quietPair = candidate.interest.key === 'calm' && current.interestKey === 'calm';

    if (currentDuration < minSeconds || ((sameInterest || quietPair) && mergedDuration <= maxSeconds)) {
      current.end = nextEnd;
      if (!sameInterest) current.interestKey = 'mixed';
      continue;
    }

    merged.push({ start: current.start, end: current.end });
    current = {
      start: candidate.start,
      end: candidate.end,
      interestKey: candidate.interest.key,
    };
  }

  if (current) {
    const currentDuration = current.end - current.start;
    const previous = merged[merged.length - 1];
    if (previous && currentDuration < minSeconds) {
      previous.end = current.end;
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged.filter((range) => range.end - range.start >= 1);
}

function buildWholeMovieChunkRanges(job, sceneAnalysis, energyPoints, transcriptSegments, visualPoints) {
  const baseRanges = buildWholeMovieBaseRanges(job.duration, sceneAnalysis);
  const baseCandidates = baseRanges.map((range) => (
    measureWindow(job, sceneAnalysis.times || [], energyPoints, transcriptSegments, visualPoints, range.start, range.end)
  ));

  if (!baseCandidates.length) return [{ start: 0, end: job.duration }];

  scoreCandidates(job, baseCandidates);
  const mergedRanges = mergeWholeMovieCandidates(baseCandidates, job.duration);
  return mergedRanges.length ? mergedRanges : [{ start: 0, end: job.duration }];
}

function measureWindow(job, sceneTimes, energyPoints, transcriptSegments, visualPoints, start, end) {
  const transcript = getOverlappingTranscript(transcriptSegments, start, end);
  const text = transcript.map((segment) => segment.text).join(' ');
  const words = wordsOf(text);
  const sceneCount = sceneTimes.filter((time) => time >= start && time < end).length;
  const energy = getWindowEnergy(energyPoints, start, end);
  const visual = getWindowVisual(visualPoints, start, end);
  const punctuation = (text.match(/[!?]/g) || []).length;

  return {
    start,
    end,
    raw: {
      audio: energy.avg * 0.65 + energy.peak * 0.20 + energy.spread * 0.15,
      scene: sceneCount,
      words: words.length,
      emotion: punctuation,
      keyword: countKeywordHits(words, job.settings.mode),
      actionKeyword: countKeywordHitsForBag(words, KEYWORDS.action),
      dialogKeyword: countKeywordHitsForBag(words, KEYWORDS.dialog),
      emotionKeyword: countKeywordHitsForBag(words, KEYWORDS.emotion),
      comedyKeyword: countKeywordHitsForBag(words, KEYWORDS.comedy),
      visualAction: visual.scores.action,
      visualDialog: visual.scores.dialog,
      visualEmotion: visual.scores.emotion,
      visualComedy: visual.scores.comedy,
      visualMotion: visual.scores.visual,
      visualSuspense: visual.scores.suspense,
      visualCalm: visual.scores.calm,
      visualInterest: Math.max(
        visual.scores.action,
        visual.scores.dialog,
        visual.scores.emotion,
        visual.scores.comedy,
        visual.scores.visual,
        visual.scores.suspense,
      ),
    },
    visual: {
      top: visual.top,
      label: OPENCLIP_LABELS[visual.top] || '',
      confidence: visual.confidence,
      frameCount: visual.count,
    },
    features: {},
    text,
  };
}

function classifyInterest(candidate) {
  const f = candidate.features;
  const scores = [
    { key: 'action', label: 'Экшен', value: f.audio * 0.26 + f.scene * 0.24 + f.actionKeyword * 0.18 + f.visualAction * 0.22 + f.visualMotion * 0.10 },
    { key: 'dialog', label: 'Диалог', value: f.words * 0.42 + f.dialogKeyword * 0.18 + f.emotion * 0.12 + f.visualDialog * 0.28 },
    { key: 'emotion', label: 'Эмоции', value: f.emotion * 0.32 + f.emotionKeyword * 0.20 + f.words * 0.12 + f.audio * 0.08 + f.visualEmotion * 0.20 + f.visualSuspense * 0.08 },
    { key: 'comedy', label: 'Юмор', value: f.comedyKeyword * 0.42 + f.words * 0.12 + f.emotion * 0.08 + f.audio * 0.06 + f.visualComedy * 0.32 },
    { key: 'visual', label: 'Визуальная динамика', value: f.scene * 0.46 + f.audio * 0.12 + f.actionKeyword * 0.08 + f.visualMotion * 0.22 + f.visualInterest * 0.12 },
    { key: 'sound', label: 'Звук/напряжение', value: f.audio * 0.48 + f.scene * 0.10 + f.emotion * 0.08 + f.emotionKeyword * 0.06 + f.visualSuspense * 0.28 },
  ].sort((a, b) => b.value - a.value);

  const best = scores[0];
  const next = scores[1];
  if (!best || best.value < 0.18) return { key: 'calm', label: 'Спокойный участок', score: 0 };
  if (next && best.value >= 0.35 && best.value - next.value <= 0.08) {
    return { key: 'mixed', label: 'Смешанный интерес', score: best.value };
  }
  return { key: best.key, label: best.label, score: best.value };
}

function tagsForCandidate(candidate) {
  const f = candidate.features;
  const tags = [];
  if (f.scene >= 0.65) tags.push('много смен сцен');
  if (f.audio >= 0.65) tags.push('динамичный звук');
  if (f.words >= 0.65) tags.push('плотная речь');
  if (f.emotion >= 0.55) tags.push('эмоции');
  if (f.actionKeyword >= 0.55) tags.push('слова действия');
  if (f.dialogKeyword >= 0.55) tags.push('вопросы/диалог');
  if (f.comedyKeyword >= 0.55) tags.push('юмор');
  if (f.visualAction >= 0.65) tags.push('OpenCLIP: экшен');
  if (f.visualDialog >= 0.65) tags.push('OpenCLIP: диалог');
  if (f.visualEmotion >= 0.65) tags.push('OpenCLIP: эмоции');
  if (f.visualComedy >= 0.65) tags.push('OpenCLIP: юмор');
  if (f.visualSuspense >= 0.65) tags.push('OpenCLIP: напряжение');
  if (!tags.length && candidate.interest?.key && candidate.interest.key !== 'calm') {
    tags.push(candidate.interest.label.toLowerCase());
  }
  if (!tags.length) tags.push('низкая активность');
  return tags.slice(0, 4);
}

function scoreCandidates(job, candidates) {
  for (const key of [
    'audio',
    'scene',
    'words',
    'emotion',
    'keyword',
    'actionKeyword',
    'dialogKeyword',
    'emotionKeyword',
    'comedyKeyword',
    'visualAction',
    'visualDialog',
    'visualEmotion',
    'visualComedy',
    'visualMotion',
    'visualSuspense',
    'visualCalm',
    'visualInterest',
  ]) {
    normalizeCandidates(candidates, key);
  }

  const weights = weightsForMode(job.settings.mode);
  for (const candidate of candidates) {
    candidate.score = Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + candidate.features[key] * weight,
      0,
    );
    if (candidate.raw.words === 0 && candidate.raw.scene === 0 && candidate.raw.audio === 0) {
      candidate.score = 0.01;
    }
    candidate.interest = classifyInterest(candidate);
    candidate.tags = tagsForCandidate(candidate);
  }
}

function interestOrderForMode(mode) {
  const table = {
    balanced: ['action', 'dialog', 'emotion', 'visual', 'sound', 'comedy', 'mixed', 'calm'],
    action: ['action', 'visual', 'sound', 'emotion', 'dialog', 'mixed', 'comedy', 'calm'],
    dialog: ['dialog', 'emotion', 'comedy', 'sound', 'action', 'visual', 'mixed', 'calm'],
    emotion: ['emotion', 'dialog', 'sound', 'action', 'comedy', 'visual', 'mixed', 'calm'],
    comedy: ['comedy', 'dialog', 'emotion', 'action', 'sound', 'visual', 'mixed', 'calm'],
  };
  return table[mode] || table.balanced;
}

function selectDiverseCandidates(job, candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected = [];
  const seen = new Set();

  for (const interest of interestOrderForMode(job.settings.mode)) {
    const candidate = sorted.find((item) => item.interest.key === interest && !seen.has(item));
    if (!candidate) continue;
    selected.push(candidate);
    seen.add(candidate);
    if (selected.length >= job.settings.clipCount) return selected;
  }

  for (const candidate of sorted) {
    if (seen.has(candidate)) continue;
    selected.push(candidate);
    seen.add(candidate);
    if (selected.length >= job.settings.clipCount) break;
  }

  return selected;
}

function publicSegmentFromCandidate(segment, index) {
  return {
    index: index + 1,
    start: segment.start,
    end: segment.end,
    startLabel: formatSeconds(segment.start),
    endLabel: formatSeconds(segment.end),
    durationLabel: formatSeconds(segment.end - segment.start),
    score: Math.round(segment.score * 100),
    interest: segment.interest,
    visual: segment.visual,
    tags: segment.tags,
    reasons: clipReasons(segment),
    transcriptPreview: segment.text.replace(/\s+/g, ' ').slice(0, 260),
  };
}

function clipRangeWithPadding(job, clip) {
  const padding = clipPaddingSecondsForJob(job);
  const duration = Number(job.duration) || clip.end;
  const maxDuration = maxClipSecondsForJob(job);
  const sourceStart = clamp(clip.start, 0, duration);
  const sourceEnd = clamp(clip.end, 0, duration);
  const start = clamp(sourceStart - padding, 0, duration);
  let end = clamp(clip.end + padding, 0, duration);

  if (end <= start) end = Math.min(duration, start + Math.max(1, clip.end - clip.start));
  return {
    start,
    end,
    padding,
    maxDuration,
    splitForShorts: sourceEnd - sourceStart >= sourceSecondsForShortsClip(job) - 0.01,
  };
}

function publicClipFromCandidate(job, clip, index) {
  const padded = clipRangeWithPadding(job, clip);
  return {
    index: index + 1,
    start: padded.start,
    end: padded.end,
    startLabel: formatSeconds(padded.start),
    endLabel: formatSeconds(padded.end),
    durationLabel: formatSeconds(padded.end - padded.start),
    sourceStart: clip.start,
    sourceEnd: clip.end,
    sourceStartLabel: formatSeconds(clip.start),
    sourceEndLabel: formatSeconds(clip.end),
    paddingSeconds: padded.padding,
    maxDurationSeconds: padded.maxDuration,
    splitForShorts: padded.splitForShorts,
    score: Math.round(clip.score * 100),
    interest: clip.interest,
    visual: clip.visual,
    tags: clip.tags,
    reasons: clipReasons(clip),
    transcriptPreview: clip.text.replace(/\s+/g, ' ').slice(0, 420),
    export: null,
  };
}

function summarizeSegmentInterests(segments) {
  const counts = new Map();
  for (const segment of segments) {
    const label = segment.interest?.label || 'Без категории';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${label}: ${count}`)
    .join(', ');
}

function scoreVideo(job, sceneAnalysis, energyPoints, transcriptSegments, visualPoints) {
  const analysis = Array.isArray(sceneAnalysis)
    ? { times: sceneAnalysis, scenes: [] }
    : { times: [], scenes: [], ...(sceneAnalysis || {}) };
  const sceneTimes = analysis.times || [];
  const sourceClipSeconds = sourceSecondsForShortsClip(job);
  const ranges = job.settings.analyzeWholeMovie
    ? buildWholeMovieChunkRanges(job, analysis, energyPoints, transcriptSegments, visualPoints)
    : buildMovieChunkRanges(job.duration, sceneTimes, sourceClipSeconds);
  const candidates = ranges.map((range) => (
    measureWindow(job, sceneTimes, energyPoints, transcriptSegments, visualPoints, range.start, range.end)
  ));

  if (!candidates.length) {
    const fallbackEnd = job.settings.analyzeWholeMovie ? job.duration : Math.min(job.duration, sourceClipSeconds);
    candidates.push(measureWindow(job, sceneTimes, energyPoints, transcriptSegments, visualPoints, 0, fallbackEnd));
  }

  scoreCandidates(job, candidates);
  job.segments = candidates
    .sort((a, b) => a.start - b.start)
    .map(publicSegmentFromCandidate);

  const clipRanges = splitRangesForShorts(ranges.length ? ranges : [{ start: 0, end: job.duration }], sourceClipSeconds);
  const clipCandidates = clipRanges.map((range) => (
    measureWindow(job, sceneTimes, energyPoints, transcriptSegments, visualPoints, range.start, range.end)
  ));

  if (!clipCandidates.length) {
    const fallbackEnd = Math.min(job.duration, sourceClipSeconds);
    clipCandidates.push(measureWindow(job, sceneTimes, energyPoints, transcriptSegments, visualPoints, 0, fallbackEnd));
  }

  scoreCandidates(job, clipCandidates);

  if (job.settings.analyzeWholeMovie) {
    return clipCandidates
      .sort((a, b) => a.start - b.start)
      .map((clip, index) => publicClipFromCandidate(job, clip, index));
  }

  return selectDiverseCandidates(job, clipCandidates)
    .sort((a, b) => a.start - b.start)
    .map((clip, index) => publicClipFromCandidate(job, clip, index));
}

function clipReasons(clip) {
  const reasons = [];
  if (clip.features.scene >= 0.65) reasons.push('много смен сцен');
  if (clip.features.audio >= 0.65) reasons.push('выраженная аудиодинамика');
  if (clip.features.words >= 0.65) reasons.push('плотный диалог');
  if (clip.features.emotion >= 0.55) reasons.push('эмоциональные реплики');
  if (clip.features.keyword >= 0.55) reasons.push('ключевые слова режима');
  if (clip.features.visualInterest >= 0.65) reasons.push('визуальный интерес OpenCLIP');
  if (clip.features.visualSuspense >= 0.65) reasons.push('напряжение по кадрам OpenCLIP');
  if (!reasons.length) reasons.push('лучший доступный участок по текущим признакам');
  return reasons;
}

async function exportClips(job, videoPath) {
  const exportDir = path.join(EXPORTS_DIR, job.id);
  await fsp.mkdir(exportDir, { recursive: true });
  const baseName = sanitizeFilename(path.basename(videoPath, path.extname(videoPath)));

  for (const clip of job.clips) {
    setStage(job, `Экспорт фрагмента ${clip.index}/${job.clips.length}`, 82 + Math.round((clip.index / job.clips.length) * 16));
    const filename = `fragment_${String(clip.index).padStart(2, '0')}_${filenameTime(clip.start)}_${baseName}.mp4`;
    const outputPath = path.join(exportDir, filename);
    await exportClip(job, videoPath, outputPath, clip.start, clip.end - clip.start);
    clip.export = {
      path: outputPath,
      url: `/exports/${job.id}/${encodeURIComponent(filename)}`,
    };
  }

  job.exports = job.clips.filter((clip) => clip.export).map((clip) => clip.export);
}

async function exportClip(job, videoPath, outputPath, start, duration) {
  const baseArgs = [
    '-y',
    '-hide_banner',
    '-ss', String(Math.max(0, start)),
    '-i', videoPath,
    '-t', String(Math.max(1, duration)),
    '-map', '0:v:0',
    '-map', '0:a:0?',
  ];
  const tailArgs = [
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath,
  ];

  if (job.settings.useNvenc) {
    try {
      await runProcess(job, 'Экспорт фрагмента через NVENC', TOOLS.ffmpeg, [
        ...baseArgs,
        '-c:v', 'h264_nvenc',
        '-preset', 'p5',
        '-cq', '23',
        ...tailArgs,
      ], { maxBuffer: 50_000 });
      return;
    } catch (error) {
      logJob(job, `Экспорт через NVENC не сработал, переключаюсь на libx264: ${error.message.split('\n')[0]}`);
    }
  }

  await runProcess(job, 'Экспорт фрагмента через libx264', TOOLS.ffmpeg, [
    ...baseArgs,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    ...tailArgs,
  ], { maxBuffer: 50_000 });
}

async function processJob(job) {
  try {
    job.status = 'running';
    setStage(job, 'Проверяю инструменты', 2);
    await assertRequiredTools(job, job.settings);

    const stat = await fsp.stat(job.input.videoPath);
    if (!stat.isFile()) throw new Error('Указанный путь не является видеофайлом.');

    const jobDir = path.join(JOBS_DIR, job.id);
    await fsp.mkdir(jobDir, { recursive: true });

    setStage(job, 'Читаю длительность видео', 6);
    job.duration = await getDuration(job, job.input.videoPath);
    logJob(job, `Длительность видео: ${formatSeconds(job.duration)}.`);

    const audioPath = path.join(jobDir, 'audio.wav');
    setStage(job, 'Извлекаю аудио', 14);
    await extractAudio(job, job.input.videoPath, audioPath);

    setStage(job, 'Ищу смены сцен', 30);
    let sceneAnalysis = { times: [], scenes: [] };
    try {
      sceneAnalysis = await scanSceneChanges(job, job.input.videoPath, job.settings, job.duration);
      logJob(
        job,
        `Поиск сцен PySceneDetect: найдено ${sceneAnalysis.times.length}; качество ${sceneAnalysis.qualityLabel}; режим ${sceneAnalysis.modeLabel}; детекторы: ${sceneAnalysis.detectorLabel}; пороги: ${sceneAnalysis.thresholdLabel}; FPS ${sceneAnalysis.fps}; минимальный интервал ${sceneAnalysis.minGapSeconds} сек (${sceneAnalysis.minSceneLenFrames} кадров).`,
      );
    } catch (error) {
      logJob(job, `Поиск смен сцен пропущен: ${error.message.split('\n')[0]}`);
    }

    setStage(job, 'Анализирую громкость', 45);
    let energyPoints = [];
    try {
      energyPoints = await analyzeEnergy(job, audioPath, jobDir);
      logJob(job, `Анализ громкости: получено ${energyPoints.length} измерений.`);
    } catch (error) {
      logJob(job, `Анализ громкости пропущен: ${error.message.split('\n')[0]}`);
    }

    let transcriptSegments = [];
    if (job.settings.useWhisper) {
      setStage(job, 'Распознаю речь', 58);
      try {
        transcriptSegments = await transcribe(job, audioPath, jobDir, job.settings);
        logJob(job, `Распознавание речи Whisper: получено ${transcriptSegments.length} сегментов.`);
      } catch (error) {
        logJob(job, `Распознавание речи Whisper пропущено: ${error.message.split('\n')[0]}`);
      }
    } else {
      logJob(job, 'Распознавание речи Whisper выключено в настройках.');
    }

    let visualPoints = [];
    if (job.settings.useOpenClip) {
      setStage(job, 'Анализирую кадры OpenCLIP', 70);
      try {
        const visualAnalysis = await analyzeOpenClip(job, job.input.videoPath, jobDir);
        visualPoints = Array.isArray(visualAnalysis.points) ? visualAnalysis.points : [];
        logJob(
          job,
          `Нейроанализ OpenCLIP: обработано ${formatCountRu(visualPoints.length, 'кадр', 'кадра', 'кадров')}; модель ${visualAnalysis.modelLabel || visualAnalysis.modelName}; устройство ${visualAnalysis.device}; шаг ${visualAnalysis.sampleStep} сек.`,
        );
      } catch (error) {
        logJob(job, `Нейроанализ OpenCLIP пропущен: ${error.message.split('\n')[0]}`);
      }
    } else {
      logJob(job, 'Нейроанализ OpenCLIP выключен в настройках.');
    }

    setStage(job, 'Оцениваю фрагменты', 78);
    job.clips = scoreVideo(job, sceneAnalysis, energyPoints, transcriptSegments, visualPoints);
    if (job.segments?.length) {
      logJob(job, `Карта фильма: ${formatCountRu(job.segments.length, 'кусок', 'куска', 'кусков')}; ${summarizeSegmentInterests(job.segments)}.`);
    }
    if (job.settings.analyzeWholeMovie) {
      logJob(job, `Выдача фрагментов: подготовлены ролики по карте фильма (${formatCountRu(job.clips.length, 'ролик', 'ролика', 'роликов')}).`);
      if (job.clips.length !== job.segments.length) {
        logJob(job, `Лимит Shorts: ${formatCountRu(job.segments.length, 'кусок карты', 'куска карты', 'кусков карты')} разбиты на ${formatCountRu(job.clips.length, 'ролик', 'ролика', 'роликов')} до 1 минуты.`);
      }
    } else {
      logJob(job, `Оценка фрагментов: выбрано ${job.clips.length}.`);
    }

    if (job.settings.autoExport) {
      await exportClips(job, job.input.videoPath);
    } else {
      logJob(job, 'Автоэкспорт выключен: показываю только найденные таймкоды.');
    }

    job.status = 'done';
    setStage(job, 'Готово', 100);
    await persistJob(job);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    setStage(job, 'Ошибка', job.progress || 0);
    logJob(job, `Ошибка: ${error.message}`);
    await persistJob(job);
  }
}

async function createJob(req, res) {
  const body = await readJson(req);
  const videoPath = cleanInputPath(body.videoPath);
  if (!videoPath) {
    sendJson(res, 400, { error: 'Укажите путь к видеофайлу.' });
    return;
  }
  if (!(await fileExists(videoPath))) {
    sendJson(res, 400, { error: 'Видеофайл не найден.' });
    return;
  }

  const mode = MODES.has(body.mode) ? body.mode : 'balanced';
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    stage: 'Ожидает запуска',
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { videoPath },
    settings: {
      clipCount: positiveInt(body.clipCount, 1, 5),
      clipMinutes: clampNumber(body.clipMinutes, 1, 1, 1),
      mode,
      language: ['auto', 'ru', 'en'].includes(body.language) ? body.language : 'auto',
      useWhisper: body.useWhisper !== false,
      useOpenClip: body.useOpenClip !== false,
      autoExport: body.autoExport !== false,
      useNvenc: body.useNvenc !== false,
      analyzeWholeMovie: body.analyzeWholeMovie === true,
      clipPaddingSeconds: clampNumber(body.clipPaddingSeconds, 0, 15, 2),
      sceneThreshold: clampNumber(body.sceneThreshold, 0.15, 0.75, 0.35),
      sceneMode: ['auto', 'manual'].includes(body.sceneMode) ? body.sceneMode : 'auto',
      sceneQuality: ['fast', 'precise'].includes(body.sceneQuality) ? body.sceneQuality : 'precise',
      minSceneGapSeconds: clampNumber(body.minSceneGapSeconds, 0.5, 8, 1.25),
    },
    duration: null,
    segments: [],
    clips: [],
    exports: [],
    error: null,
    logs: [],
  };

  jobs.set(job.id, job);
  logJob(job, 'Задача добавлена в очередь.');
  if (job.settings.analyzeWholeMovie) {
    logJob(job, 'Режим всего фильма включён: поле "Минут" не задаёт длину кусков, карта строится по сценам PySceneDetect.');
  }
  if (job.settings.clipPaddingSeconds > 0) {
    logJob(job, `Запас роликов: добавляю ${job.settings.clipPaddingSeconds} сек до начала и после конца каждого MP4.`);
  }
  logJob(job, 'Лимит Shorts: каждый итоговый MP4 будет не длиннее 1 минуты.');
  processJob(job);
  sendJson(res, 202, { job: publicJob(job) });
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : safeResolve(PUBLIC_DIR, pathname.replace(/^\/+/, ''));

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Не найдено');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, 'Не найдено');
  }
}

async function serveExport(req, res, pathname) {
  const [, , jobId, encodedName] = pathname.split('/');
  if (!jobId || !encodedName) {
    sendText(res, 404, 'Не найдено');
    return;
  }

  try {
    const fileName = decodeURIComponent(encodedName);
    const filePath = safeResolve(EXPORTS_DIR, jobId, fileName);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Не найдено');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${fileName.replace(/"/g, '')}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, 'Не найдено');
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && pathname === '/api/tools') {
      sendJson(res, 200, { tools: await getToolStatus() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      sendJson(res, 200, { jobs: Array.from(jobs.values()).map(publicJob).reverse() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/shutdown') {
      shutdownFromApi(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pick-file') {
      const body = await readJson(req);
      sendJson(res, 200, await pickLocalVideoFile(body.initialPath));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/open-export') {
      const body = await readJson(req);
      sendJson(res, 200, await openExportFile(body.path, body.action));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/open-file') {
      const body = await readJson(req);
      sendJson(res, 200, await openLocalFile(body.path, body.action));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs') {
      await createJob(req, res);
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: 'Задача не найдена.' });
        return;
      }
      sendJson(res, 200, { job: publicJob(job) });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/exports/')) {
      await serveExport(req, res, pathname);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: 'Метод запроса не поддерживается.' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

ensureDirs();
loadPersistedJobs();

const server = http.createServer(route);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`LGV запущен: http://127.0.0.1:${PORT}`);
  console.log(`Папка проекта: ${ROOT_DIR}`);
});

function shutdownFromApi(res) {
  if (hasActiveJobs()) {
    sendJson(res, 409, {
      error: 'Сейчас выполняется задача. LGV не будет выключен.',
      activeJobs: activeJobLabels(),
    });
    return;
  }

  sendJson(res, 200, { ok: true, message: 'LGV завершает работу.' });

  setTimeout(() => {
    console.log('Получен запрос на выключение через API.');
    server.close(() => {
      process.exit(0);
    });
  }, 100).unref();
}

function requestShutdown(signal) {
  if (hasActiveJobs()) {
    console.log(`Остановка по сигналу ${signal} отложена: сейчас выполняется задача.`);
    for (const label of activeJobLabels()) {
      console.log(`Активная задача: ${label}`);
    }
    return;
  }

  console.log(`Получен сигнал ${signal}. Завершаю LGV.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
