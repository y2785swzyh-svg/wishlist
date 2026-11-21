// FaceMask – dimostratore web. Stessa logica del prototipo Android:
//  1. un fotogramma viene mostrato solo dopo essere stato analizzato e mascherato;
//  2. i fotogrammi sono trattenuti per LOOKAHEAD passi, così un volto rilevato in
//     ritardo viene coperto anche nei fotogrammi precedenti;
//  3. se il telefono ruota troppo in fretta si copre l'intero fotogramma.
import { FaceDetector, FilesetResolver } from './vendor/vision_bundle.js';

const LOOKAHEAD = 2;          // fotogrammi trattenuti prima della visualizzazione
const MARGIN = 0.30;          // margine attorno al riquadro del volto
const HOLD_MS = 700;          // tenuta della maschera su un volto perso
const GHOST_GROWTH = 0.6;     // crescita della maschera di un volto perso, per secondo
const MATCH_IOU = 0.10;
const SMALL_EXTRA = 0.20;     // margine aggiuntivo per i volti piccoli
const SMALL_FRAC = 0.12;
const RETRO_MARGIN = 0.45;    // margine della copertura retroattiva
const RETRO_GROWTH = 0.25;
const GRID = 10;              // campioni di colore che sopravvivono per lato del volto
const FULL = 20;              // idem per la copertura dell'intero fotogramma
const MOTION_DEG = 57;        // gradi al secondo oltre i quali si copre tutto
const MOTION_HOLD_MS = 350;
const MAX_SIDE = 1280;
const TILE_FRACTION = 2 / 3;   // lato dei riquadri di analisi, rispetto al lato corto
const TILE_STRIDE = 0.6;      // passo tra riquadri, in frazione del lato (sovrapposizione 40%)

const $ = (id) => document.getElementById(id);
const video = $('cam'), view = $('view'), vctx = view.getContext('2d');
const hud = $('hud'), err = $('err');

// ---------- geometria ----------
const W = (b) => Math.max(0, b.r - b.l), H = (b) => Math.max(0, b.b - b.t);
const empty = (b) => W(b) <= 0 || H(b) <= 0;
const expand = (b, f) => ({ l: b.l - W(b) * f, t: b.t - H(b) * f, r: b.r + W(b) * f, b: b.b + H(b) * f });
const clamp = (b, w, h) => ({
  l: Math.min(Math.max(b.l, 0), w), t: Math.min(Math.max(b.t, 0), h),
  r: Math.min(Math.max(b.r, 0), w), b: Math.min(Math.max(b.b, 0), h),
});
const contains = (o, i) => o.l <= i.l && o.t <= i.t && o.r >= i.r && o.b >= i.b;
function iou(a, b) {
  const iw = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
  const ih = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const inter = iw * ih, uni = W(a) * H(a) + W(b) * H(b) - inter;
  return uni <= 0 ? 0 : inter / uni;
}

// ---------- tracciamento: "nel dubbio, la maschera resta" ----------
let tracks = [];
function trackerUpdate(dets, now, fw, fh) {
  const unmatched = tracks.slice(), next = [];
  for (const d of dets) {
    let best = null, bestIou = 0;
    for (const t of unmatched) { const v = iou(t.box, d); if (v > bestIou) { bestIou = v; best = t; } }
    if (best && bestIou >= MATCH_IOU) unmatched.splice(unmatched.indexOf(best), 1);
    next.push({ box: d, seen: now });
  }
  for (const t of unmatched) if (now - t.seen <= HOLD_MS) next.push(t);
  tracks = next;
  const out = [];
  for (const t of tracks) {
    const lost = now - t.seen;
    const small = SMALL_EXTRA * (1 - Math.min(1, (W(t.box) / fw) / SMALL_FRAC));
    const box = clamp(expand(t.box, MARGIN + small + GHOST_GROWTH * lost / 1000), fw, fh);
    if (!empty(box)) out.push(box);
  }
  return out;
}

// ---------- copertura retroattiva ----------
const queue = [];
function plannerSubmit(frame, dets, now, fw, fh, forceFull) {
  const boxes = (dets || []).filter((b) => !empty(b));
  let distance = 1;
  for (let i = queue.length - 1; i >= 0; i--, distance++) {
    const e = queue[i];
    if (e.full) continue;
    for (const b of boxes) {
      if (e.regions.some((r) => contains(r, b))) continue;
      const g = clamp(expand(b, RETRO_MARGIN + RETRO_GROWTH * (distance - 1)), fw, fh);
      if (!empty(g)) e.regions.push(g);
    }
  }
  const regions = dets === null ? [] : trackerUpdate(boxes, now, fw, fh);
  queue.push({ frame, regions, full: forceFull || dets === null });
  return queue.length > LOOKAHEAD ? queue.shift() : null;
}

// ---------- mascheramento ----------
function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const cDown = mk(40, 40), cGrid = mk(GRID, GRID), cUp1 = mk(40, 40), cUp2 = mk(160, 160), cOval = mk(160, 160);
const cFull = mk(FULL, FULL), cFullUp = mk(FULL * 4, FULL * 4);
const x = (c) => { const k = c.getContext('2d'); k.imageSmoothingEnabled = true; k.imageSmoothingQuality = 'high'; return k; };
const xDown = x(cDown), xGrid = x(cGrid), xUp1 = x(cUp1), xUp2 = x(cUp2), xOval = x(cOval);
const xFull = x(cFull), xFullUp = x(cFullUp);
const feather = xOval.createRadialGradient(80, 80, 80 * 0.84, 80, 80, 80);
feather.addColorStop(0, 'rgba(0,0,0,1)'); feather.addColorStop(1, 'rgba(0,0,0,0)');

// La regione è ridotta a GRID x GRID campioni (qui si distrugge l'informazione),
// poi ingrandita per gradi e disegnata in un ovale dal bordo sfumato.
function maskFace(canvas, ctx, box) {
  const sx = Math.floor(box.l), sy = Math.floor(box.t);
  const sw = Math.ceil(box.r) - sx, sh = Math.ceil(box.b) - sy;
  if (sw <= 0 || sh <= 0) return;
  xDown.drawImage(canvas, sx, sy, sw, sh, 0, 0, 40, 40);
  xGrid.drawImage(cDown, 0, 0, 40, 40, 0, 0, GRID, GRID);
  xUp1.drawImage(cGrid, 0, 0, GRID, GRID, 0, 0, 40, 40);
  xUp2.drawImage(cUp1, 0, 0, 40, 40, 0, 0, 160, 160);
  xOval.globalCompositeOperation = 'copy';
  xOval.drawImage(cUp2, 0, 0);
  xOval.globalCompositeOperation = 'destination-in';
  xOval.fillStyle = feather;
  xOval.fillRect(0, 0, 160, 160);
  ctx.drawImage(cOval, sx, sy, sw, sh);
}
function maskAll(canvas, ctx) {
  xDown.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 40, 40);
  xFull.drawImage(cDown, 0, 0, 40, 40, 0, 0, FULL, FULL);
  xFullUp.drawImage(cFull, 0, 0, FULL, FULL, 0, 0, FULL * 4, FULL * 4);
  ctx.drawImage(cFullUp, 0, 0, canvas.width, canvas.height);
}

// ---------- rilevamento a più scale ----------
// Il modello riconosce solo volti grandi rispetto all'immagine che riceve. Per
// trovare anche quelli lontani, oltre al fotogramma intero si analizzano dei
// riquadri sovrapposti, ciascuno ingrandito: un volto piccolo nel fotogramma
// diventa grande nel suo riquadro.
const cDet = mk(256, 256), xDet = x(cDet);
function positions(len, side) {
  if (len <= side) return [0];
  const n = Math.ceil((len - side) / (side * TILE_STRIDE)) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((len - side) * i / (n - 1)));
}
function detectRegion(canvas, rx, ry, rw, rh, out) {
  xDet.drawImage(canvas, rx, ry, rw, rh, 0, 0, 256, 256);
  for (const d of detector.detect(cDet).detections) {
    const b = d.boundingBox;
    if (!b) continue;
    out.push({
      l: rx + b.originX * rw / 256, t: ry + b.originY * rh / 256,
      r: rx + (b.originX + b.width) * rw / 256, b: ry + (b.originY + b.height) * rh / 256,
    });
  }
}
function detectAll(canvas, fw, fh) {
  const raw = [];
  detectRegion(canvas, 0, 0, fw, fh, raw);
  const side = Math.round(Math.min(fw, fh) * TILE_FRACTION);
  for (const ty of positions(fh, side)) for (const tx of positions(fw, side)) {
    detectRegion(canvas, tx, ty, side, side, raw);
  }
  // Lo stesso volto può essere trovato in più riquadri: si uniscono i rettangoli sovrapposti.
  const merged = [];
  for (const b of raw) {
    const m = merged.find((o) => iou(o, b) > 0.3 || contains(o, b) || contains(b, o));
    if (m) { m.l = Math.min(m.l, b.l); m.t = Math.min(m.t, b.t); m.r = Math.max(m.r, b.r); m.b = Math.max(m.b, b.b); }
    else merged.push({ ...b });
  }
  return merged;
}

// ---------- fotocamera ----------
let detector = null, stream = null, front = false, running = false;
let pool = [], rot = 0, lastFast = -1e9, hasGyro = false;
const stats = { fps: 0, detect: 0, faces: 0, full: 0, frames: 0, shown: 0, errors: 0, last: 0 };
window.__stats = stats;
window.__lastDets = [];

async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: front ? 'user' : 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
  // Cambio fotocamera: si scartano i fotogrammi in attesa e le posizioni note.
  for (const e of queue) pool.push(e.frame);
  queue.length = 0; tracks = [];
  view.classList.toggle('mirror', front);
}

function getFrame(w, h) {
  let c = pool.pop();
  if (!c) c = { canvas: mk(w, h) };
  if (c.canvas.width !== w || c.canvas.height !== h) { c.canvas.width = w; c.canvas.height = h; c.ctx = null; }
  if (!c.ctx) c.ctx = c.canvas.getContext('2d');
  return c;
}

function processFrame() {
  if (!running) return;
  schedule();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;
  const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
  const fw = Math.round(vw * scale), fh = Math.round(vh * scale);
  const now = performance.now();

  const f = getFrame(fw, fh);
  f.ctx.drawImage(video, 0, 0, fw, fh);

  let dets = null;
  try {
    dets = detectAll(f.canvas, fw, fh);
  } catch (e) {
    // Nel dubbio la maschera resta: se il rilevatore fallisce si copre tutto.
    console.warn('Rilevamento fallito', e);
    stats.errors++;
  }
  const detectMs = performance.now() - now;
  window.__lastDets = dets;
  const moving = now - lastFast < MOTION_HOLD_MS;

  const ready = plannerSubmit(f, dets, now, fw, fh, moving);
  if (ready) {
    const c = ready.frame;
    if (ready.full) { stats.full++; maskAll(c.canvas, c.ctx); }
    else for (const r of ready.regions) maskFace(c.canvas, c.ctx, r);
    if (view.width !== fw || view.height !== fh) { view.width = fw; view.height = fh; }
    vctx.drawImage(c.canvas, 0, 0);
    stats.shown++;
    pool.push(c);
  }

  if (stats.last) stats.fps = stats.fps ? stats.fps * 0.9 + (1000 / (now - stats.last)) * 0.1 : 1000 / (now - stats.last);
  stats.last = now;
  stats.detect = stats.detect ? stats.detect * 0.9 + detectMs * 0.1 : detectMs;
  stats.faces = dets ? dets.length : 0;
  if (++stats.frames % 5 === 0 && hud.style.display === 'block') {
    hud.textContent =
      `Risoluzione ${fw}x${fh}\nFluidità ${stats.fps.toFixed(1)} fotogrammi/s\n` +
      `Rilevamento ${stats.detect.toFixed(0)} ms\nVolti ${stats.faces}, errori ${stats.errors}\n` +
      `Giroscopio ${hasGyro ? rot.toFixed(0) + ' gradi/s' : 'non disponibile'}\n` +
      `Protezione movimento: ${moving ? 'ATTIVA' : 'no'} (${stats.full} coperti)\n` +
      `Ritardo anteprima: ${LOOKAHEAD} fotogrammi`;
  }
}
function schedule() {
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(processFrame);
  else requestAnimationFrame(processFrame);
}

// ---------- avvio e comandi ----------
$('go').addEventListener('click', async () => {
  $('go').disabled = true; err.textContent = 'Avvio in corso…';
  // Su iPhone il permesso ai sensori di movimento va chiesto subito, dentro il tocco.
  let motion = Promise.resolve('granted');
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    motion = DeviceMotionEvent.requestPermission().catch(() => 'denied');
  }
  try {
    if ((await motion) === 'granted') {
      window.addEventListener('devicemotion', (e) => {
        const r = e.rotationRate;
        if (!r || r.alpha === null) return;
        hasGyro = true;
        rot = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
        if (rot > MOTION_DEG) lastFast = performance.now();
      });
    }
    const files = await FilesetResolver.forVisionTasks('./vendor/wasm');
    detector = await FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: './vendor/blaze_face_short_range.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    await openCamera();
    $('start').style.display = 'none';
    document.querySelectorAll('.ui').forEach((el) => { el.style.display = el.id === 'bar' ? 'block' : 'flex'; });
    running = true;
    schedule();
  } catch (e) {
    console.error(e);
    err.textContent = e && e.name === 'NotAllowedError'
      ? 'Permesso della fotocamera negato: abilitalo nelle impostazioni del browser e riprova.'
      : 'Avvio non riuscito: ' + (e && e.message ? e.message : e);
    $('go').disabled = false;
  }
});

$('info').addEventListener('click', () => { hud.style.display = hud.style.display === 'block' ? 'none' : 'block'; });

$('switch').addEventListener('click', async () => {
  front = !front;
  try { await openCamera(); } catch (e) { front = !front; console.error(e); }
});

$('shot').addEventListener('click', () => {
  if (!stats.shown) return;
  const flash = $('flash');
  flash.style.transition = 'none'; flash.style.opacity = '0.7';
  requestAnimationFrame(() => { flash.style.transition = 'opacity .25s'; flash.style.opacity = '0'; });
  // La foto è presa dall'immagine a schermo, quindi è già mascherata.
  view.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], `facemask_${Date.now()}.jpg`, { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/jpeg', 0.92);
});
