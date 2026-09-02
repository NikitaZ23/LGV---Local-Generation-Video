const state = {
  currentJobId: null,
  pollTimer: null,
};

const JOB_STORAGE_KEY = 'lgv.currentJobId';
const ACTIVE_STATUSES = new Set(['queued', 'running']);

const form = document.querySelector('#jobForm');
const startButton = document.querySelector('#startButton');
const pickVideoButton = document.querySelector('#pickVideoButton');
const refreshButton = document.querySelector('#refreshButton');
const toolStatus = document.querySelector('#toolStatus');
const statusTitle = document.querySelector('#statusTitle');
const progressBar = document.querySelector('#progressBar');
const progressPercent = document.querySelector('#progressPercent');
const elapsedTime = document.querySelector('#elapsedTime');
const remainingTime = document.querySelector('#remainingTime');
const finishTime = document.querySelector('#finishTime');
const summary = document.querySelector('#summary');
const clips = document.querySelector('#clips');
const segmentCount = document.querySelector('#segmentCount');
const movieSegments = document.querySelector('#movieSegments');
const logs = document.querySelector('#logs');
const videoPathInput = document.querySelector('#videoPath');
const openSourceButton = document.querySelector('#openSourceButton');
const showSourceButton = document.querySelector('#showSourceButton');
const clipCountInput = document.querySelector('#clipCount');
const clipMinutesInput = document.querySelector('#clipMinutes');
const clipPaddingSecondsInput = document.querySelector('#clipPaddingSeconds');
const analyzeWholeMovieInput = document.querySelector('#analyzeWholeMovie');

const MODE_LABELS = {
  balanced: 'Баланс',
  action: 'Экшен',
  dialog: 'Диалог',
  emotion: 'Эмоции',
  comedy: 'Юмор',
};

const SCENE_QUALITY_LABELS = {
  precise: 'Точнее',
  fast: 'Быстрее',
};

const STATUS_LABELS = {
  queued: 'Ожидает запуска',
  running: 'В работе',
  done: 'Готово',
  failed: 'Ошибка',
};

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatCompactDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const rounded = Math.max(0, Math.round(seconds));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) {
    return `${h} ч ${String(m).padStart(2, '0')} мин`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

function formatClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumberRu(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function renderClipPaddingInfo(clip) {
  const padding = Number(clip.paddingSeconds) || 0;
  const maxSeconds = Number(clip.maxDurationSeconds) || 60;
  const parts = [];
  if (padding > 0 && clip.sourceStartLabel && clip.sourceEndLabel) {
    parts.push(`запас до ${formatNumberRu(padding)} сек до и после`);
    parts.push(`исходно ${escapeHtml(clip.sourceStartLabel)} - ${escapeHtml(clip.sourceEndLabel)}`);
  }
  if (clip.splitForShorts || clip.durationCapped) {
    const maxLabel = maxSeconds >= 59 ? 'до 1 мин' : formatDuration(maxSeconds);
    parts.push(`нарезано ${maxLabel} для Shorts`);
  }
  if (!parts.length) return '';
  return `<div class="padding-note">${parts.join(' · ')}</div>`;
}

function renderVisualBadge(item) {
  const visual = item.visual;
  if (!visual?.label || !visual.frameCount) return '';
  const confidence = Number(visual.confidence) || 0;
  return `<span class="reason visual-reason">${escapeHtml(visual.label)} · ${Math.round(confidence * 100)}%</span>`;
}

function setBusy(isBusy) {
  startButton.disabled = isBusy;
  startButton.querySelector('span:last-child').textContent = isBusy ? 'Работаю' : 'Старт';
}

function syncSourceActions() {
  const hasPath = videoPathInput.value.trim().length > 0;
  openSourceButton.disabled = !hasPath;
  showSourceButton.disabled = !hasPath;
}

function isActiveJob(job) {
  return ACTIVE_STATUSES.has(job?.status);
}

function rememberJobId(jobId) {
  try {
    if (jobId) localStorage.setItem(JOB_STORAGE_KEY, jobId);
  } catch {
  }
}

function forgetJobId() {
  try {
    localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {
  }
}

function rememberedJobId() {
  try {
    return localStorage.getItem(JOB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function renderTools(tools) {
  const order = ['pySceneDetect', 'python', 'ffmpeg', 'ffprobe', 'whisper', 'whisperModel', 'openClipModel', 'openClipPython'];
  toolStatus.innerHTML = order.map((name) => {
    const item = tools[name];
    const label = name === 'whisperModel'
      ? 'модель'
      : name === 'pySceneDetect'
        ? 'PySceneDetect'
        : name === 'openClipModel'
          ? 'CLIP-модель'
          : name === 'openClipPython'
            ? 'CLIP-пакеты'
            : name;
    const cls = item?.exists ? 'ok' : 'bad';
    return `<span class="pill ${cls}" title="${item?.path || ''}">${label}</span>`;
  }).join('');
}

function renderJob(job) {
  state.currentJobId = job.id;
  rememberJobId(job.id);
  const sourcePath = job.input?.videoPath || '';
  if (sourcePath) videoPathInput.value = sourcePath;
  syncSourceActions();
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  progressBar.style.width = `${progress}%`;
  renderTiming(job, progress);
  statusTitle.textContent = job.status === 'failed'
    ? 'Ошибка'
    : job.status === 'done'
      ? 'Готово'
      : job.stage || 'В работе';

  const duration = job.duration ? ` · ${formatDuration(job.duration)}` : '';
  const mode = job.settings?.mode ? ` · режим: ${MODE_LABELS[job.settings.mode] || job.settings.mode}` : '';
  const sceneQuality = job.settings?.sceneQuality
    ? ` · сцены: ${SCENE_QUALITY_LABELS[job.settings.sceneQuality] || job.settings.sceneQuality}`
    : '';
  const wholeMovie = job.settings?.analyzeWholeMovie ? ' · карта: весь фильм' : '';
  const openClip = job.settings?.useOpenClip ? ' · нейро: OpenCLIP' : '';
  const shortsLimit = ' · лимит: до 1 мин';
  const padding = Number(job.settings?.clipPaddingSeconds) > 0
    ? ` · запас: до ${formatNumberRu(job.settings.clipPaddingSeconds)} сек`
    : '';
  summary.textContent = job.error
    ? job.error
    : `${job.stage || STATUS_LABELS[job.status] || job.status}${duration}${mode}${sceneQuality}${wholeMovie}${openClip}${shortsLimit}${padding}`;

  clips.innerHTML = (job.clips || []).map((clip) => `
    <article class="clip-card">
      <div>
        <div class="clip-title">
          <strong>#${clip.index} · ${clip.startLabel} - ${clip.endLabel}</strong>
          ${clip.durationLabel ? `<span class="duration-pill">${clip.durationLabel}</span>` : ''}
          <span class="score">${clip.score}/100</span>
        </div>
        ${clip.interest?.label ? `<div class="interest-badge">${escapeHtml(clip.interest.label)}</div>` : ''}
        ${renderClipPaddingInfo(clip)}
        <div class="reasons">
          ${renderVisualBadge(clip)}
          ${clip.reasons.map((reason) => `<span class="reason">${escapeHtml(reason)}</span>`).join('')}
        </div>
        <p class="transcript">${escapeHtml(clip.transcriptPreview || 'Без текстового фрагмента.')}</p>
      </div>
      ${clip.export ? `
        <div class="clip-actions">
          <button class="clip-link" type="button" data-open-export="${escapeHtml(clip.export.path)}">Открыть MP4</button>
          <button class="clip-folder-link" type="button" data-show-export="${escapeHtml(clip.export.path)}">Папка</button>
        </div>
      ` : ''}
    </article>
  `).join('');

  logs.textContent = (job.logs || [])
    .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`)
    .join('\n');
  renderSegments(job.segments || []);

  setBusy(isActiveJob(job));
  if (!isActiveJob(job)) {
    stopPolling();
  }
}

function renderSegments(segments) {
  segmentCount.textContent = segments.length ? formatCountRu(segments.length, 'кусок', 'куска', 'кусков') : '';
  movieSegments.innerHTML = segments.map((segment) => `
    <article class="segment-card">
      <div class="segment-time">
        <strong>#${segment.index}</strong>
        <span>${segment.startLabel} - ${segment.endLabel}</span>
        ${segment.durationLabel ? `<span>${segment.durationLabel}</span>` : ''}
      </div>
      <div class="segment-body">
        <div class="segment-topline">
          <span class="interest-badge">${escapeHtml(segment.interest?.label || 'Без категории')}</span>
          <span class="score">${segment.score}/100</span>
        </div>
        <div class="reasons">
          ${renderVisualBadge(segment)}
          ${(segment.tags || segment.reasons || []).map((tag) => `<span class="reason">${escapeHtml(tag)}</span>`).join('')}
        </div>
      </div>
    </article>
  `).join('');
}

function renderTiming(job, progress) {
  const createdAt = new Date(job.createdAt);
  const now = new Date();
  const elapsedSeconds = Number.isNaN(createdAt.getTime())
    ? 0
    : Math.max(0, (now.getTime() - createdAt.getTime()) / 1000);
  const active = job.status === 'queued' || job.status === 'running';
  const finished = job.status === 'done' || job.status === 'failed';

  progressPercent.textContent = `${Math.round(progress)}%`;
  elapsedTime.textContent = `Прошло: ${formatCompactDuration(elapsedSeconds)}`;

  if (finished) {
    remainingTime.textContent = 'Осталось: 00:00';
    finishTime.textContent = `Окончание: ${formatClock(new Date(job.updatedAt))}`;
    return;
  }

  if (!active || progress < 2) {
    remainingTime.textContent = 'Осталось: считаю';
    finishTime.textContent = 'Окончание: --';
    return;
  }

  const remainingSeconds = elapsedSeconds * ((100 - progress) / progress);
  const eta = new Date(now.getTime() + remainingSeconds * 1000);
  remainingTime.textContent = `Осталось: примерно ${formatCompactDuration(remainingSeconds)}`;
  finishTime.textContent = `Окончание: примерно ${formatClock(eta)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Ошибка HTTP ${response.status}`);
  }
  return payload;
}

async function openSourceVideo(action) {
  const path = videoPathInput.value.trim();
  if (!path) {
    summary.textContent = 'Сначала выбери видеофайл.';
    syncSourceActions();
    return;
  }

  const button = action === 'folder' ? showSourceButton : openSourceButton;
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = 'Открываю';

  try {
    await api('/api/open-file', {
      method: 'POST',
      body: JSON.stringify({ path, action }),
    });
    summary.textContent = action === 'folder' ? 'Папка с фильмом открыта.' : 'Фильм открыт через Windows.';
  } catch (error) {
    summary.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = previousText;
    syncSourceActions();
  }
}

async function loadTools() {
  try {
    const payload = await api('/api/tools');
    renderTools(payload.tools);
  } catch (error) {
    toolStatus.innerHTML = `<span class="pill bad">${escapeHtml(error.message)}</span>`;
  }
}

async function loadJob() {
  if (!state.currentJobId) return;
  try {
    const payload = await api(`/api/jobs/${state.currentJobId}`);
    renderJob(payload.job);
  } catch (error) {
    summary.textContent = error.message;
    forgetJobId();
  }
}

function chooseRestorableJob(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  return jobs.find(isActiveJob) || jobs[0];
}

async function restoreJob() {
  summary.textContent = 'Восстанавливаю последнюю задачу...';
  const storedId = rememberedJobId();

  if (storedId) {
    try {
      const payload = await api(`/api/jobs/${storedId}`);
      renderJob(payload.job);
      if (isActiveJob(payload.job)) startPolling();
      return;
    } catch {
      forgetJobId();
    }
  }

  try {
    const payload = await api('/api/jobs');
    const job = chooseRestorableJob(payload.jobs);
    if (!job) {
      summary.textContent = 'Выбери локальный видеофайл и запусти анализ.';
      return;
    }
    renderJob(job);
    if (isActiveJob(job)) startPolling();
  } catch (error) {
    summary.textContent = error.message;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(loadJob, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function updateWholeMovieMode() {
  const enabled = analyzeWholeMovieInput.checked;
  clipCountInput.disabled = enabled;
  clipCountInput.closest('.field')?.classList.toggle('field-disabled', enabled);
}

analyzeWholeMovieInput.addEventListener('change', updateWholeMovieMode);
updateWholeMovieMode();
videoPathInput.addEventListener('input', syncSourceActions);
openSourceButton.addEventListener('click', () => openSourceVideo('open'));
showSourceButton.addEventListener('click', () => openSourceVideo('folder'));
syncSourceActions();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  clips.innerHTML = '';
  logs.textContent = '';
  movieSegments.innerHTML = '';
  segmentCount.textContent = '';
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  elapsedTime.textContent = 'Прошло: 00:00';
  remainingTime.textContent = 'Осталось: считаю';
  finishTime.textContent = 'Окончание: --';
  statusTitle.textContent = 'Запуск';
  summary.textContent = 'Создаю задачу...';

  const formData = new FormData(form);
  const payload = {
    videoPath: formData.get('videoPath'),
    clipCount: Number(formData.get('clipCount')),
    clipMinutes: Number(clipMinutesInput.value),
    clipPaddingSeconds: Number(clipPaddingSecondsInput.value),
    mode: formData.get('mode'),
    language: formData.get('language'),
    analyzeWholeMovie: analyzeWholeMovieInput.checked,
    sceneThreshold: Number(formData.get('sceneThreshold')),
    sceneMode: 'auto',
    sceneQuality: formData.get('sceneQuality'),
    minSceneGapSeconds: 1.25,
    useWhisper: document.querySelector('#useWhisper').checked,
    useOpenClip: document.querySelector('#useOpenClip').checked,
    autoExport: document.querySelector('#autoExport').checked,
    useNvenc: document.querySelector('#useNvenc').checked,
  };

  try {
    const result = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderJob(result.job);
    startPolling();
  } catch (error) {
    setBusy(false);
    statusTitle.textContent = 'Ошибка';
    summary.textContent = error.message;
  }
});

refreshButton.addEventListener('click', loadJob);

clips.addEventListener('click', async (event) => {
  const openButton = event.target.closest('[data-open-export]');
  const folderButton = event.target.closest('[data-show-export]');
  const button = openButton || folderButton;
  if (!button) return;

  const path = openButton ? button.dataset.openExport : button.dataset.showExport;
  const action = openButton ? 'open' : 'folder';
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = 'Открываю';

  try {
    await api('/api/open-export', {
      method: 'POST',
      body: JSON.stringify({ path, action }),
    });
    summary.textContent = openButton ? 'MP4 открыт через Windows.' : 'Папка с MP4 открыта.';
  } catch (error) {
    summary.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
});

pickVideoButton.addEventListener('click', async () => {
  const previousText = pickVideoButton.textContent;
  pickVideoButton.disabled = true;
  pickVideoButton.textContent = 'Жду';
  summary.textContent = 'Открываю окно выбора видео...';

  try {
    const result = await api('/api/pick-file', {
      method: 'POST',
      body: JSON.stringify({ initialPath: videoPathInput.value.trim() }),
    });
    if (result.path) {
      videoPathInput.value = result.path;
      syncSourceActions();
      summary.textContent = 'Видео выбрано.';
    } else {
      summary.textContent = 'Выбор отменён.';
    }
  } catch (error) {
    summary.textContent = error.message;
  } finally {
    pickVideoButton.disabled = false;
    pickVideoButton.textContent = previousText;
  }
});

loadTools();
restoreJob();
