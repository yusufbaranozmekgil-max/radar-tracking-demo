import createRadar from './radar.js';

const VIEW_RANGE_M = 34000;
const DETECTION_LIFETIME = 6;
const DEAD_TRACK_LIFETIME = 10;
const MAX_SCANS = 200;
const PRE_ROLL_SCANS = 24;
const CLUTTER_STEPS = [0, 5, 50, 100, 200, 500];
const SPEEDS = [1, 2, 4];
const BASE_SCAN_MS = 450;
const TWO_SIGMA = 2;
const RING_EXAGGERATION = 20;
const PREDICTION_SECONDS = 60;

const COLOR = {
  etch: [146, 214, 188],
  label: '#9dc4b4',
  detection: '#d6e4da',
  pencil: '#f4c430',
  pencilDim: '#c9a53a',
  truth: '#f2f6ee',
  ring: 'rgba(244, 196, 48, 0.55)',
  sheetLit: '#1c5442',
  sheet: '#0f3027',
  sheetFar: '#0b271f',
  edge: '#6fe3c8',
};

const PRESETS = {
  clear: { pd: 1, clutter: 1 },
  busy: { pd: 0.9, clutter: 2 },
  clutter: { pd: 0.9, clutter: 5 },
  weak: { pd: 0.55, clutter: 2 },
};

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const context = canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ui = { paused: false, speed: 0, showTruth: false, seed: 1 };
let radar = null;
let session = null;
let plot = null;
let timer = 0;
let pixelRatio = 1;
let sheet = null;
let waxPattern = null;

function noise(index) {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function newPlot() {
  return { scan: 0, detections: [], tracks: new Map(), truth: new Map(), current: [] };
}

function settings() {
  const [hits, confirmWindow] = document.querySelector('input[name="rule"]:checked').value.split(',').map(Number);
  return {
    pd: Number($('pd').value),
    clutter: CLUTTER_STEPS[Number($('clutter').value)],
    hits,
    confirmWindow,
  };
}

function startRun(preRoll = 0) {
  session?.delete();
  const { pd, clutter, hits, confirmWindow } = settings();
  session = new radar.DemoSession(pd, clutter, hits, confirmWindow, ui.seed);
  plot = newPlot();
  for (let i = 0; i < preRoll; i += 1) {
    advance(false);
  }
  draw();
}

function wipeBoard() {
  if (reducedMotion) return;
  canvas.classList.remove('wipe');
  void canvas.offsetWidth;
  canvas.classList.add('wipe');
}

function advance(render = true) {
  if (plot.scan >= MAX_SCANS) {
    ui.seed += 1;
    startRun();
    return;
  }

  const started = performance.now();
  const scan = JSON.parse(session.step());
  const elapsed = performance.now() - started;

  plot.scan += 1;
  plot.detections = plot.detections.filter((d) => plot.scan - d.scan < DETECTION_LIFETIME);
  for (const [x, y] of scan.detections) {
    plot.detections.push({ x, y, scan: plot.scan });
  }

  for (const [id, x, y] of scan.truth) {
    if (!plot.truth.has(id)) plot.truth.set(id, []);
    plot.truth.get(id).push([x, y]);
  }

  const seen = new Set();
  plot.current = scan.tracks.map(([id, confirmed, x, y, vx, vy, pxx, pxy, pyy]) => {
    seen.add(id);
    if (!plot.tracks.has(id)) plot.tracks.set(id, { points: [], confirmedAt: -1, lastSeen: plot.scan });
    const record = plot.tracks.get(id);
    record.points.push([x, y]);
    record.lastSeen = plot.scan;
    if (confirmed && record.confirmedAt < 0) record.confirmedAt = record.points.length - 1;
    return { id, confirmed, x, y, vx, vy, pxx, pxy, pyy };
  });
  for (const [id, record] of plot.tracks) {
    const gone = plot.scan - record.lastSeen;
    if (gone > (record.confirmedAt < 0 ? 0 : DEAD_TRACK_LIFETIME)) plot.tracks.delete(id);
  }

  writeReadout(elapsed);
  writeScore(scan.score);
  if (render) draw();
}

function writeReadout(elapsed) {
  const confirmed = plot.current.filter((t) => t.confirmed).length;
  $('scan').textContent = plot.scan;
  $('confirmed').textContent = confirmed;
  $('tentative').textContent = plot.current.length - confirmed;
  $('scan-time').textContent = `${elapsed.toFixed(1)} ms`;
}

function writeScore(score) {
  $('followed').textContent = `${(score.followed * 100).toFixed(1)}%`;
  $('rmse').textContent = `${score.rmse.toFixed(0)} m`;
  $('false-tracks').textContent = score.falseTracks.toFixed(2);
  $('switches').textContent = score.switches;
}

function mapper() {
  const width = canvas.width;
  const height = canvas.height;
  const scale = (Math.min(width, height) / 2) * 0.97 / VIEW_RANGE_M;
  return {
    width,
    height,
    scale,
    x: (metres) => width / 2 + metres * scale,
    y: (metres) => height / 2 - metres * scale,
  };
}

// Wax leaves pigment unevenly: a tile of random opacity gives every stroke the same grain.
function buildWaxPattern() {
  const size = 96;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const tileContext = tile.getContext('2d');
  const image = tileContext.createImageData(size, size);
  for (let i = 0; i < size * size; i += 1) {
    const offset = i * 4;
    const grain = noise(i + 1);
    image.data[offset] = 244;
    image.data[offset + 1] = 196;
    image.data[offset + 2] = 48;
    image.data[offset + 3] = grain < 0.16 ? 70 : 185 + grain * 70;
  }
  tileContext.putImageData(image, 0, 0);
  return context.createPattern(tile, 'repeat');
}

// The sheet is lit from its top edge: light falls off down the acrylic and catches engraved lines.
function buildSheet(view) {
  const layer = document.createElement('canvas');
  layer.width = view.width;
  layer.height = view.height;
  const paint = layer.getContext('2d');

  const fall = paint.createLinearGradient(0, 0, 0, view.height);
  fall.addColorStop(0, COLOR.sheetLit);
  fall.addColorStop(0.45, COLOR.sheet);
  fall.addColorStop(1, COLOR.sheetFar);
  paint.fillStyle = fall;
  paint.fillRect(0, 0, view.width, view.height);
  paint.fillStyle = COLOR.edge;
  paint.fillRect(0, 0, view.width, pixelRatio);

  const centerX = view.width / 2;
  const centerY = view.height / 2;
  const [r, g, b] = COLOR.etch;
  const etch = paint.createLinearGradient(0, 0, 0, view.height);
  etch.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.62)`);
  etch.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.14)`);
  paint.strokeStyle = etch;
  paint.lineWidth = pixelRatio;

  for (const km of [10, 20, 30]) {
    paint.beginPath();
    paint.arc(centerX, centerY, km * 1000 * view.scale, 0, Math.PI * 2);
    paint.stroke();
  }

  const reach = 30000 * view.scale;
  for (let degrees = 0; degrees < 360; degrees += 10) {
    const angle = (degrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const major = degrees % 30 === 0;
    const inner = major ? 0 : reach * 0.975;
    const outer = major ? reach * 1.025 : reach;
    paint.beginPath();
    paint.moveTo(centerX + cos * inner, centerY - sin * inner);
    paint.lineTo(centerX + cos * outer, centerY - sin * outer);
    paint.stroke();
  }

  paint.fillStyle = COLOR.label;
  paint.font = `${11 * pixelRatio}px 'B612 Mono', monospace`;
  paint.textBaseline = 'bottom';
  for (const km of [10, 20, 30]) {
    paint.fillText(`${km} km`, centerX + 5 * pixelRatio, centerY - km * 1000 * view.scale - 2 * pixelRatio);
  }
  return layer;
}

function resize() {
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const box = canvas.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return;
  canvas.width = Math.round(box.width * pixelRatio);
  canvas.height = Math.round(box.height * pixelRatio);
  sheet = buildSheet(mapper());
  waxPattern = buildWaxPattern();
  draw();
}

function drawDetections(view) {
  context.strokeStyle = COLOR.detection;
  context.lineWidth = pixelRatio;
  const arm = 2.2 * pixelRatio;
  for (const detection of plot.detections) {
    const x = view.x(detection.x);
    const y = view.y(detection.y);
    context.globalAlpha = 0.85 * (1 - (plot.scan - detection.scan) / DETECTION_LIFETIME);
    context.beginPath();
    context.moveTo(x - arm, y - arm);
    context.lineTo(x + arm, y + arm);
    context.moveTo(x + arm, y - arm);
    context.lineTo(x - arm, y + arm);
    context.stroke();
  }
  context.globalAlpha = 1;
}

// One segment at a time, so pressure can change along the line.
function drawGreaseStroke(view, points, from, seed, opacity) {
  context.strokeStyle = waxPattern;
  context.lineCap = 'round';
  context.globalAlpha = opacity;
  let previousX = null;
  let previousY = null;
  for (let i = from; i < points.length; i += 1) {
    const x = view.x(points[i][0]) + (noise(seed + i) - 0.5) * pixelRatio;
    const y = view.y(points[i][1]) + (noise(seed + i + 31) - 0.5) * pixelRatio;
    if (previousX !== null) {
      context.lineWidth = (2.1 + noise(seed + i + 57) * 1.5) * pixelRatio;
      context.beginPath();
      context.moveTo(previousX, previousY);
      context.lineTo(x, y);
      context.stroke();
    }
    previousX = x;
    previousY = y;
  }
  context.globalAlpha = 1;
}

function drawHistory(view) {
  for (const [id, record] of plot.tracks) {
    if (record.confirmedAt < 0) continue;
    const opacity = 1 - (plot.scan - record.lastSeen) / (DEAD_TRACK_LIFETIME + 1);
    drawGreaseStroke(view, record.points, record.confirmedAt, id * 101, opacity);
  }
}

function drawTruth(view) {
  context.strokeStyle = COLOR.truth;
  context.lineWidth = 1.1 * pixelRatio;
  for (const points of plot.truth.values()) {
    context.beginPath();
    points.forEach(([x, y], i) => {
      if (i === 0) context.moveTo(view.x(x), view.y(y));
      else context.lineTo(view.x(x), view.y(y));
    });
    context.stroke();
  }
}

// The filter's 2 sigma position ellipse, drawn larger than life so it can be seen.
function drawUncertainty(view, track) {
  const { pxx, pxy, pyy } = track;
  const middle = (pxx + pyy) / 2;
  const offset = Math.hypot((pxx - pyy) / 2, pxy);
  const stretch = TWO_SIGMA * RING_EXAGGERATION * view.scale;
  const major = Math.sqrt(Math.max(middle + offset, 0)) * stretch;
  const minor = Math.sqrt(Math.max(middle - offset, 0)) * stretch;
  const angle = 0.5 * Math.atan2(2 * pxy, pxx - pyy);

  context.strokeStyle = COLOR.ring;
  context.lineWidth = pixelRatio;
  context.beginPath();
  context.ellipse(view.x(track.x), view.y(track.y), major, minor, -angle, 0, Math.PI * 2);
  context.stroke();
}

function drawPrediction(view, track) {
  context.strokeStyle = COLOR.pencilDim;
  context.lineWidth = pixelRatio;
  context.setLineDash([5 * pixelRatio, 5 * pixelRatio]);
  context.beginPath();
  context.moveTo(view.x(track.x), view.y(track.y));
  context.lineTo(
    view.x(track.x + track.vx * PREDICTION_SECONDS),
    view.y(track.y + track.vy * PREDICTION_SECONDS),
  );
  context.stroke();
  context.setLineDash([]);
}

// Labels sit to the side of travel, written slightly off level like a plotter's hand.
function drawLabel(view, track) {
  const speed = Math.hypot(track.vx, track.vy) || 1;
  const sideX = track.vy / speed;
  const sideY = track.vx / speed;
  const distance = 20 * pixelRatio;
  const x = view.x(track.x) + sideX * distance;
  const y = view.y(track.y) + sideY * distance;

  context.save();
  context.translate(x, y);
  context.rotate((noise(track.id * 13) - 0.5) * 0.14);
  context.fillStyle = COLOR.pencil;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `700 ${12 * pixelRatio}px 'B612 Mono', monospace`;
  context.fillText(`T${track.id}`, 0, 0);
  context.restore();
}

function drawTentative(view, track) {
  context.strokeStyle = COLOR.pencilDim;
  context.globalAlpha = 0.6;
  context.lineWidth = pixelRatio;
  context.setLineDash([2 * pixelRatio, 3 * pixelRatio]);
  context.beginPath();
  context.arc(view.x(track.x), view.y(track.y), 4 * pixelRatio, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;
}

function drawTracks(view) {
  for (const track of plot.current) {
    if (!track.confirmed) drawTentative(view, track);
  }
  for (const track of plot.current) {
    if (!track.confirmed) continue;
    drawPrediction(view, track);
    drawUncertainty(view, track);
    const size = 3.5 * pixelRatio;
    context.fillStyle = COLOR.pencil;
    context.fillRect(view.x(track.x) - size, view.y(track.y) - size, size * 2, size * 2);
    drawLabel(view, track);
  }
}

function draw() {
  if (!plot || !sheet) return;
  const view = mapper();
  context.drawImage(sheet, 0, 0);
  drawDetections(view);
  drawHistory(view);
  drawTracks(view);
  if (ui.showTruth) drawTruth(view);
}

function scanInterval() {
  const base = reducedMotion ? BASE_SCAN_MS * 3 : BASE_SCAN_MS;
  return base / SPEEDS[ui.speed];
}

function schedule() {
  window.clearTimeout(timer);
  if (ui.paused) return;
  timer = window.setTimeout(() => {
    advance();
    schedule();
  }, scanInterval());
}

function writeLabels() {
  $('pd-value').textContent = `${Math.round(Number($('pd').value) * 100)}%`;
  $('clutter-value').textContent = CLUTTER_STEPS[Number($('clutter').value)];
}

function markPreset(name) {
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === name));
  });
}

function restart() {
  wipeBoard();
  startRun();
  schedule();
}

function settingsChanged() {
  writeLabels();
  markPreset(null);
  startRun();
  schedule();
}

function applyPreset(name) {
  const preset = PRESETS[name];
  $('pd').value = preset.pd;
  $('clutter').value = preset.clutter;
  writeLabels();
  markPreset(name);
  restart();
}

function bindControls() {
  $('pd').addEventListener('input', settingsChanged);
  $('clutter').addEventListener('input', settingsChanged);
  document.querySelectorAll('input[name="rule"]').forEach((input) => {
    input.addEventListener('change', restart);
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  });
  $('controls').addEventListener('submit', (event) => event.preventDefault());

  $('pause').addEventListener('click', () => {
    ui.paused = !ui.paused;
    $('pause').setAttribute('aria-pressed', String(ui.paused));
    $('pause').textContent = ui.paused ? 'Resume' : 'Pause';
    schedule();
  });
  $('speed').addEventListener('click', () => {
    ui.speed = (ui.speed + 1) % SPEEDS.length;
    $('speed').textContent = `Speed ${SPEEDS[ui.speed]}x`;
    schedule();
  });
  $('truth').addEventListener('click', () => {
    ui.showTruth = !ui.showTruth;
    $('truth').setAttribute('aria-pressed', String(ui.showTruth));
    $('truth').textContent = ui.showTruth ? 'Hide truth' : 'Show truth';
    $('truth-key').hidden = !ui.showTruth;
    draw();
  });
  $('restart').addEventListener('click', () => {
    ui.seed += 1;
    restart();
  });

  new ResizeObserver(resize).observe(canvas);
}

async function main() {
  try {
    radar = await createRadar();
    await Promise.all([
      document.fonts.load("11px 'B612 Mono'"),
      document.fonts.load("700 12px 'B612 Mono'"),
    ]);
  } catch {
    $('loading').textContent = 'The tracker could not load. WebAssembly may be blocked in this browser.';
    return;
  }
  $('loading').hidden = true;
  bindControls();
  resize();
  startRun(PRE_ROLL_SCANS);
  schedule();
}

main();
