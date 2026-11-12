/* 보드 재고관리 PWA
 * - 데이터: 이 기기(localStorage) 또는 Google 시트(Apps Script 웹 앱)
 * - 입력: 스마트폰/PC 카메라 바코드 스캔, USB·블루투스 바코드리더기(키보드 입력), 직접 입력
 * - 대장 구조는 '보드재고관리 문서/ledger.csv' · Google 시트 '재고대장'과 같다.
 */
'use strict';

const APP_VERSION = '1.1.0';
const OUT_TYPES = ['팀내', '타팀', '외부', '증정'];
const STATUSES = ['재고', '분출'];
const CSV_HEADERS = ['관리번호', 'PUID', 'LOT', 'DATE', '수량', '상태', '분출구분', '수령자', '소속/팀', '분출일', '비고', '물류라벨 일시', '물류라벨 번호'];
const CSV_KEYS = ['id', 'puid', 'lot', 'date', 'qty', 'status', 'outType', 'recipient', 'team', 'outDate', 'note', 'labelTime', 'labelNo'];
const DEFAULT_SETTINGS = {
  user: '', mode: 'local', url: '', token: '',
  dModel: 'FRDM-MCXN947', dMaker: 'NXP', dCodeno: '935455837598', dPrefix: 'MCXN',
};
const LS = { boards: 'inv.boards', history: 'inv.history', outbox: 'inv.outbox', settings: 'inv.settings', audit: 'inv.audit', sync: 'inv.lastSync' };

/* ------------------------------------------------------------------ 유틸 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowStr = () => { const d = new Date(); return `${today()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const up = (s) => String(s ?? '').trim().toUpperCase();

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { toast('기기 저장 공간 오류: ' + e.message, 'err'); }
}

/** 숫자는 파란색, 영문은 기본색 (시트 표기 규칙과 동일) */
function mono(s) {
  if (!s) return '';
  return '<span class="mono">' + esc(s).replace(/(\d+)/g, '<span class="d">$1</span>') + '</span>';
}

/* PUID = 앞 2글자 + "CN" + LOT, LOT 의 5~8번째 글자 = DATE(YYWW) */
function derive(puid) {
  const p = up(puid);
  const m = p.match(/^([A-Z0-9]{2})CN([A-Z0-9]{6,})$/);
  if (!m) return null;
  const lot = m[2];
  const date = /^\d{4}$/.test(lot.slice(4, 8)) ? lot.slice(4, 8) : '';
  return { lot, date };
}
function puidCheck(b) {
  if (!b.puid) return '';
  return up(b.puid).slice(2) === 'CN' + up(b.lot) ? 'OK' : '확인';
}
function mfgOf(date) {
  const d = String(date || '');
  if (!/^\d{4}$/.test(d)) return '';
  return `20${d.slice(0, 2)}년 ${parseInt(d.slice(2), 10)}주차`;
}
/** 0/O, 1/I 혼동을 무시한 비교용 */
const loose = (s) => up(s).replace(/O/g, '0').replace(/I/g, '1');

/* ------------------------------------------------------------------ 상태 */
const S = {
  boards: load(LS.boards, []),
  history: load(LS.history, []),
  outbox: load(LS.outbox, []),
  settings: Object.assign({}, DEFAULT_SETTINGS, load(LS.settings, {})),
  audit: load(LS.audit, []),
  lastSync: load(LS.sync, ''),
  syncState: 'idle', // idle | busy | ok | offline | error
  syncMsg: '',
  view: 'dash',
  scanMode: 'lookup',
  listFilter: 'all',
};
const persist = () => { save(LS.boards, S.boards); save(LS.history, S.history); save(LS.outbox, S.outbox); };
const isSheet = () => S.settings.mode === 'sheet' && S.settings.url && S.settings.token;
const byId = (id) => S.boards.find((b) => up(b.id) === up(id));
const sortBoards = () => S.boards.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

function normBoard(b) {
  const s = S.settings;
  return {
    id: up(b.id), model: (b.model || s.dModel || '').trim(), maker: (b.maker || s.dMaker || '').trim(),
    codeno: String(b.codeno || s.dCodeno || '').trim(), puid: up(b.puid), lot: up(b.lot), date: String(b.date || '').trim(),
    qty: Math.max(1, parseInt(b.qty, 10) || 1), status: STATUSES.includes(b.status) ? b.status : '재고',
    outType: (b.outType || '').trim(), recipient: (b.recipient || '').trim(), team: (b.team || '').trim(),
    outDate: (b.outDate || '').trim(), note: (b.note || '').trim(), labelTime: (b.labelTime || '').trim(), labelNo: (b.labelNo || '').trim(),
  };
}

function nextId() {
  const prefix = up(S.settings.dPrefix || 'BRD');
  let max = 0;
  for (const b of S.boards) {
    const m = b.id.match(new RegExp('^' + prefix.replace(/[^A-Z0-9]/g, '') + '-(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ 작업(op) 처리
 * 모든 변경은 op 로 표현한다. 로컬에 즉시 반영하고, 시트 모드면 outbox 에 넣어 순서대로 전송한다.
 * op: { opId, type:'add'|'update'|'log', id, board?, fields?, expect?, action, detail, user, ts }
 */
function applyLocal(op) {
  if (op.type === 'add') {
    S.boards.push(normBoard(op.board));
    sortBoards();
  } else if (op.type === 'update') {
    const b = byId(op.id);
    if (b) Object.assign(b, op.fields);
  }
  S.history.unshift({ ts: op.ts, action: op.action, id: op.id, detail: op.detail, user: op.user });
  if (S.history.length > 500) S.history.length = 500;
}

function commit(op) {
  op.opId = uid();
  op.ts = nowStr();
  op.user = S.settings.user || '(미지정)';
  applyLocal(op);
  if (isSheet()) S.outbox.push(op);
  persist();
  renderAll();
  if (isSheet()) flush();
}

/* ------------------------------------------------------------------ Google 시트 연동 (Apps Script) */
const Api = {
  async call(payload, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // text/plain 으로 보내야 CORS preflight 없이 Apps Script 에 도달한다.
      const res = await fetch(S.settings.url, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: S.settings.token, client: 'pwa/' + APP_VERSION }, payload)),
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw Object.assign(new Error('응답이 JSON 이 아님 (URL·배포 권한 확인)'), { kind: 'server' }); }
      return j;
    } catch (e) {
      if (e.kind) throw e;
      throw Object.assign(new Error(e.name === 'AbortError' ? '응답 시간 초과' : '네트워크 연결 실패'), { kind: 'network' });
    } finally { clearTimeout(t); }
  },
};

let flushing = false;
async function flush() {
  if (!isSheet() || flushing) return;
  flushing = true;
  setSync('busy');
  let needRefresh = false;
  try {
    while (S.outbox.length) {
      const op = S.outbox[0];
      let r;
      try {
        r = await Api.call({ action: op.type, opId: op.opId, id: op.id, board: op.board, fields: op.fields, expect: op.expect, act: op.action, detail: op.detail, user: op.user });
      } catch (e) {
        setSync(e.kind === 'network' ? 'offline' : 'error', e.message);
        return;
      }
      if (r.ok) {
        S.outbox.shift();
        if (r.board) mergeBoard(r.board);
        persist();
        continue;
      }
      if (r.error === 'auth') { setSync('error', '토큰이 맞지 않습니다 (설정 확인)'); return; }
      // 충돌·중복 등: 이 작업은 버리고 시트 기준으로 다시 맞춘다.
      S.outbox.shift();
      persist();
      needRefresh = true;
      const msg = { conflict: '다른 사람이 먼저 변경한 보드입니다', duplicate: '이미 시트에 있는 관리번호/PUID 입니다', not_found: '시트에 없는 관리번호입니다' }[r.error] || r.message || r.error;
      toast(`${op.id} ${op.action} 반영 실패: ${msg}`, 'err', 6000);
    }
  } finally {
    flushing = false;
  }
  await pull(needRefresh);
}

function mergeBoard(sb) {
  const nb = normBoard(sb);
  const i = S.boards.findIndex((b) => b.id === nb.id);
  if (i >= 0) S.boards[i] = nb; else S.boards.push(nb);
  sortBoards();
}

async function pull() {
  if (!isSheet()) return;
  if (S.outbox.length) return flush();
  setSync('busy');
  let r;
  try { r = await Api.call({ action: 'list' }); } catch (e) { setSync(e.kind === 'network' ? 'offline' : 'error', e.message); return; }
  if (!r.ok) { setSync('error', r.error === 'auth' ? '토큰이 맞지 않습니다 (설정 확인)' : (r.message || r.error)); return; }
  if (S.outbox.length) return flush(); // 받는 사이 새 작업이 생김
  S.boards = (r.boards || []).map(normBoard);
  sortBoards();
  S.history = r.history || [];
  S.lastSync = nowStr();
  save(LS.sync, S.lastSync);
  persist();
  setSync('ok');
  renderAll();
}

function setSync(state, msg = '') {
  S.syncState = state; S.syncMsg = msg;
  const el = $('#sync-badge');
  el.className = 'sync-badge';
  if (!isSheet()) { el.textContent = '로컬'; el.title = '이 기기에만 저장 중 (설정에서 Google 시트 연동)'; return; }
  const pend = S.outbox.length ? ` · 대기 ${S.outbox.length}` : '';
  if (state === 'busy') { el.textContent = '동기화…' + pend; }
  else if (state === 'ok') { el.textContent = '시트 연동' + pend; el.classList.add(S.outbox.length ? 'warn' : 'ok'); el.title = '마지막 동기화 ' + S.lastSync; }
  else if (state === 'offline') { el.textContent = '오프라인' + pend; el.classList.add('warn'); el.title = msg + ' — 연결되면 자동 전송'; }
  else if (state === 'error') { el.textContent = '연동 오류' + pend; el.classList.add('err'); el.title = msg; if (msg) toast(msg, 'err', 5000); }
  else { el.textContent = '시트' + pend; }
}

/* ------------------------------------------------------------------ 스캔 해석 */
// ANSI MH10.8.2 데이터 식별자 (물류 라벨에 흔한 것)
const DI = [['1T', 'lot'], ['10D', 'date'], ['9D', 'date'], ['30P', 'part'], ['1P', 'part'], ['P', 'part'], ['Q', 'qty'], ['4L', 'origin'], ['1S', 'serial'], ['S', 'serial'], ['K', 'order'], ['33T', 'serial2']];

function parseScan(raw) {
  let s = String(raw || '').replace(/\r|\n/g, '').trim();
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, ''); // AIM 심볼 식별자
  s = s.replace(/^\[\)>[\x1e]?\d\d[\x1d]?/, ''); // ISO 15434 헤더
  const segs = s.split(/[\x1d\x1e\x04|]/).map((t) => t.trim()).filter(Boolean);
  const tokens = new Set([up(s)]);
  const fields = {};
  for (const seg of segs) {
    tokens.add(up(seg));
    for (const [pre, key] of DI) {
      if (up(seg).startsWith(pre) && seg.length > pre.length) {
        const v = up(seg.slice(pre.length));
        tokens.add(v);
        if (!fields[key]) fields[key] = v;
        break;
      }
    }
    // 앞에 데이터 식별자가 붙은 PUID (예: 3S2WCNAOTR240303)
    const m = up(seg).match(/^\d{0,3}[A-Z](.{8,})$/);
    if (m && !derive(up(seg)) && derive(m[1])) tokens.add(m[1]);
  }
  return { raw: s, tokens: [...tokens].filter((t) => t.length >= 2), fields };
}

/** 스캔 결과 → { kind, boards, token, warn } */
function lookup(raw) {
  const p = parseScan(raw);
  for (const t of p.tokens) { const b = byId(t); if (b) return { kind: 'id', boards: [b], token: t, p }; }
  for (const t of p.tokens) { const b = S.boards.find((x) => x.puid && x.puid === t); if (b) return { kind: 'puid', boards: [b], token: t, p }; }
  for (const t of p.tokens) {
    const b = S.boards.find((x) => x.puid && loose(x.puid) === loose(t));
    if (b) return { kind: 'puid', boards: [b], token: t, p, warn: `스캔값 ${t} 과 대장 PUID ${b.puid} 가 0/O 또는 1/I 만 다릅니다. 대장 표기를 확인하세요.` };
  }
  for (const t of p.tokens) {
    const list = S.boards.filter((x) => x.lot && (x.lot === t || loose(x.lot) === loose(t)));
    if (list.length) return { kind: 'lot', boards: list, token: t, p };
  }
  for (const t of p.tokens) {
    if (S.boards.some((x) => x.codeno && x.codeno === t)) return { kind: 'codeno', boards: [], token: t, p };
  }
  const puidTok = p.tokens.find((t) => derive(t));
  return { kind: 'none', boards: [], token: puidTok || p.tokens[0] || '', p, newPuid: puidTok };
}

/* ------------------------------------------------------------------ 카메라 */
const Cam = {
  inst: null, elId: null, onCode: null, last: '', lastAt: 0,
  formats() {
    const F = window.Html5QrcodeSupportedFormats;
    return F ? [F.QR_CODE, F.DATA_MATRIX, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.ITF, F.PDF_417] : undefined;
  },
  async start(elId, onCode) {
    await this.stop();
    if (!window.Html5Qrcode) throw new Error('스캐너 라이브러리를 불러오지 못했습니다');
    if (!window.isSecureContext) throw new Error('카메라는 HTTPS 또는 localhost 에서만 켜집니다. "사진으로 스캔"을 쓰거나 HTTPS 주소로 접속하세요.');
    this.elId = elId; this.onCode = onCode;
    this.inst = new Html5Qrcode(elId, { formatsToSupport: this.formats(), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
    const box = (w, h) => ({ width: Math.max(160, Math.floor(w * 0.86)), height: Math.max(100, Math.floor(Math.min(h * 0.6, w * 0.55))) });
    try {
      await this.inst.start({ facingMode: 'environment' }, { fps: 12, qrbox: box, aspectRatio: 1.333 }, (text) => this.hit(text), () => {});
    } catch (e) {
      this.inst = null;
      const m = String(e && (e.message || e));
      if (/NotAllowed|Permission/i.test(m)) throw new Error('카메라 권한이 거부되었습니다. 브라우저/앱 설정에서 카메라를 허용하세요.');
      if (/NotFound|Requested device not found|no camera/i.test(m)) throw new Error('카메라를 찾을 수 없습니다. 바코드리더기나 직접 입력을 사용하세요.');
      throw new Error('카메라 시작 실패: ' + m);
    }
  },
  hit(text) {
    const n = performance.now();
    if (text === this.last && n - this.lastAt < 2500) return; // 같은 코드 연속 인식 방지
    this.last = text; this.lastAt = n;
    if (navigator.vibrate) navigator.vibrate(60);
    beep();
    this.onCode && this.onCode(text, 'camera');
  },
  async stop() {
    if (this.inst) {
      try { await this.inst.stop(); } catch { /* 이미 정지 */ }
      try { this.inst.clear(); } catch { /* */ }
    }
    this.inst = null;
  },
  get running() { return !!this.inst; },
};

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1760; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.08);
  } catch { /* 소리 없음 */ }
}

/** html5-qrcode 로 사진 1장에서 바코드 1개만 읽는다 (zxing-wasm 을 못 쓸 때의 대체 경로) */
async function scanFileLegacy(file) {
  if (!window.Html5Qrcode) throw new Error('스캐너 라이브러리를 불러오지 못했습니다');
  const tmpId = 'scan-file-tmp';
  let el = document.getElementById(tmpId);
  if (!el) { el = document.createElement('div'); el.id = tmpId; el.hidden = true; document.body.appendChild(el); }
  const inst = new Html5Qrcode(tmpId, { formatsToSupport: Cam.formats(), verbose: false });
  try { return await inst.scanFile(file, false); } finally { try { inst.clear(); } catch { /* */ } }
}

/* ------------------------------------------------------------------ 사진 인식 (바코드 여러 개)
 * 박스 라벨에는 CODENO·PUID·LOT·DATE 바코드가 함께 있다. 바코드 1개만 읽는 방식은 PUID 가 아닌
 * 바코드를 먼저 잡기 쉬워서, 한 장에 있는 바코드를 모두 읽은 뒤 PUID 를 골라낸다.
 * 엔진: zxing-wasm(zxing-cpp). 해상도를 바꿔 가며, 그래도 없으면 사진을 조각내어 다시 찾는다.
 */
const ZX_FORMATS = ['Code128', 'DataMatrix', 'QRCode', 'Code39', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'ITF', 'PDF417', 'MicroQRCode'];
let zxPrepared = false;
function zxLib() {
  const Z = window.ZXingWASM;
  if (!Z) return null;
  if (!zxPrepared) {
    Z.prepareZXingModule({ overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? new URL('vendor/' + p, location.href).href : prefix + p) } });
    zxPrepared = true;
  }
  return Z;
}
async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 아래 방식으로 */ }
  }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
/** 이미지(또는 그 일부)를 긴 변 maxSide 픽셀로 맞춘 ImageData */
function pixels(src, maxSide, c, allowUp = false) {
  c = c || { x: 0, y: 0, w: src.width, h: src.height };
  let k = maxSide / Math.max(c.w, c.h);
  if (!allowUp) k = Math.min(1, k);
  const w = Math.max(1, Math.round(c.w * k)), h = Math.max(1, Math.round(c.h * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
/** 찾던 값(PUID 형식 또는 등록된 관리번호·PUID)이 읽혔는가 */
function hasKeyCode(texts) {
  return texts.some((t) => parseScan(t).tokens.some((k) => derive(k) || byId(k) || S.boards.some((b) => b.puid === k)));
}
/** 사진 → [{ text, format }] (중복 제거). 진행 상황은 onStep(설명) 으로 알린다. */
async function readPhotoCodes(file, onStep = () => {}) {
  const Z = zxLib();
  if (!Z) return [{ text: await scanFileLegacy(file), format: '' }];
  const img = await loadImage(file);
  const found = new Map();
  const texts = () => [...found.keys()];
  const run = async (data, opts = {}) => {
    const rs = await Z.readBarcodes(data, { formats: ZX_FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 32, ...opts });
    for (const r of rs) if (r.isValid && r.text && !found.has(r.text)) found.set(r.text, r.format);
  };
  try {
    if ('BarcodeDetector' in window) { // 안드로이드 Chrome 의 기본 인식기 (있으면 함께 사용)
      try { for (const r of await new window.BarcodeDetector().detect(img)) if (r.rawValue && !found.has(r.rawValue)) found.set(r.rawValue, r.format); } catch { /* 없음 */ }
    }
    onStep('사진 인식 중…');
    await run(pixels(img, 2000));
    if (!hasKeyCode(texts())) { onStep('원본 해상도로 다시 찾는 중…'); await run(pixels(img, 4096)); }
    if (!hasKeyCode(texts())) { // 작은 바코드: 사진을 겹치게 9조각 내어 확대
      onStep('사진을 나누어 찾는 중…');
      const W = img.width, H = img.height;
      outer: for (const fy of [0, 0.25, 0.5]) for (const fx of [0, 0.25, 0.5]) {
        await run(pixels(img, 2400, { x: fx * W, y: fy * H, w: W / 2, h: H / 2 }, true));
        if (hasKeyCode(texts())) break outer;
      }
    }
    if (!hasKeyCode(texts())) await run(pixels(img, 2000), { binarizer: 'GlobalHistogram' });
  } finally { if (img.close) img.close(); }
  return [...found].map(([text, format]) => ({ text, format }));
}

/** 읽은 값이 무엇인지 (화면 표시용) */
function codeKind(text) {
  const p = parseScan(text);
  for (const t of p.tokens) if (byId(t)) return '관리번호';
  if (p.tokens.some((t) => derive(t))) return 'PUID';
  if (p.fields.lot || p.tokens.some(isLotLike)) return 'LOT';
  if (p.tokens.some((t) => t === up(S.settings.dCodeno) || S.boards.some((b) => b.codeno === t))) return 'CODENO';
  if (/^\d{4}$/.test(p.tokens[0] || '')) return 'DATE?';
  return '기타';
}
const isLotLike = (t) => /^[A-Z0-9]{4}\d{4,}$/.test(t) && /[A-Z]/.test(t);
function codesListHtml(codes) {
  if (!codes.length) return '';
  return `<details class="more photo-codes"><summary>사진에서 읽은 바코드 ${codes.length}개</summary><ul>${codes.map((c) => `<li><span class="tag">${esc(codeKind(c.text))}</span>${mono(up(c.text).replace(/[\x00-\x1f]/g, ' '))}</li>`).join('')}</ul></details>`;
}
const PHOTO_FAIL = '사진에서 바코드를 찾지 못했습니다. 라벨이 화면에 크게, 흔들림 없이, 빛 반사 없이 나오게 다시 찍어 보세요.';

/* ------------------------------------------------------------------ 바코드리더기 (키보드 웨지)
 * 입력칸 밖에서 빠르게 연속 입력되고 Enter/Tab 으로 끝나면 스캔으로 처리한다.
 */
const Wedge = { buf: '', last: 0 };
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select, [contenteditable]')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const n = performance.now();
  if (n - Wedge.last > 100) Wedge.buf = '';
  Wedge.last = n;
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (Wedge.buf.length >= 3) { e.preventDefault(); const code = Wedge.buf; Wedge.buf = ''; onGlobalScan(code); }
    Wedge.buf = '';
    return;
  }
  if (e.key && e.key.length === 1) Wedge.buf += e.key;
});

function onGlobalScan(code) {
  if (!$('#modal').hidden) { toast('창을 닫은 뒤 스캔하세요'); return; }
  if (S.view === 'add') { fillAddFromScan(code); return; }
  if (S.view !== 'scan') show('scan');
  handleScan(code, 'reader');
}

/* ------------------------------------------------------------------ 화면 전환 */
function show(view) {
  S.view = view;
  $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view !== 'scan' && Cam.running && Cam.elId === 'cam-scan') stopScanCam();
  if (view === 'add') prepAddForm();
  if (view === 'settings') fillSettings();
  window.scrollTo(0, 0);
}

function renderAll() {
  renderDash();
  renderList();
  renderAudit();
  setSync(S.syncState, '');
}

/* ------------------------------------------------------------------ 현황 */
function counts(list) {
  let all = 0, stock = 0, out = 0;
  for (const b of list) { all += b.qty; if (b.status === '분출') out += b.qty; else stock += b.qty; }
  return { all, stock, out };
}
function renderDash() {
  const c = counts(S.boards);
  $('#st-all').textContent = c.all; $('#st-stock').textContent = c.stock; $('#st-out').textContent = c.out;
  const chk = $('#st-check');
  const diff = c.all - c.stock - c.out;
  chk.textContent = `검증 (입고 − 재고 − 분출) = ${diff} ${diff === 0 ? '정상' : '확인'}` + (S.lastSync && isSheet() ? ` · 동기화 ${S.lastSync}` : '');
  chk.classList.toggle('bad', diff !== 0);

  const tb1 = $('#tbl-outtype tbody');
  let sum = 0;
  const rows = OUT_TYPES.map((t) => {
    const n = S.boards.filter((b) => b.status === '분출' && b.outType === t).reduce((a, b) => a + b.qty, 0);
    sum += n;
    return `<tr><td>${t}</td><td>${n}</td></tr>`;
  });
  const etc = c.out - sum;
  if (etc) rows.push(`<tr><td>(미지정)</td><td>${etc}</td></tr>`);
  rows.push(`<tr class="sum"><td>합계</td><td>${c.out}</td></tr>`);
  tb1.innerHTML = rows.join('');

  const lots = [...new Set(S.boards.map((b) => b.lot).filter(Boolean))].sort();
  const tb2 = $('#tbl-lot tbody');
  const lr = lots.map((l) => {
    const k = counts(S.boards.filter((b) => b.lot === l));
    const d = l.slice(4, 8);
    return `<tr><td>${mono(l)}</td><td>${k.all}</td><td>${k.stock}</td><td>${k.out}</td><td>${mfgOf(d)}</td></tr>`;
  });
  lr.push(`<tr class="sum"><td>합계</td><td>${c.all}</td><td>${c.stock}</td><td>${c.out}</td><td></td></tr>`);
  tb2.innerHTML = lr.join('');

  $('#dash-history').innerHTML = historyHtml(S.history.slice(0, 12)) || '<li class="muted">이력이 없습니다</li>';
}
function historyHtml(list) {
  return list.map((h) => `<li><div class="h-top"><span><span class="h-act ${esc(h.action)}">${esc(h.action)}</span> · <b>${esc(h.id)}</b></span><span class="muted">${esc(h.ts)}</span></div>
    <div>${esc(h.detail)}</div><div class="muted small">${esc(h.user)}</div></li>`).join('');
}

/* ------------------------------------------------------------------ 대장 */
function filteredBoards() {
  const q = up($('#list-q').value);
  return S.boards.filter((b) => {
    if (S.listFilter !== 'all' && b.status !== S.listFilter) return false;
    if (!q) return true;
    return [b.id, b.puid, b.lot, b.recipient, b.team, b.note, b.outType].some((v) => up(v).includes(q)) || loose(b.puid).includes(loose(q));
  });
}
function boardItem(b) {
  const sub = b.status === '분출'
    ? `${esc(b.outType)} · ${esc(b.recipient)} · ${esc(b.team)} · ${esc(b.outDate)}`
    : `LOT ${esc(b.lot)} · ${mfgOf(b.date)}`;
  return `<li class="board ${b.status === '분출' ? 'is-out' : ''}" data-id="${esc(b.id)}">
    <div><div class="b-id">${esc(b.id)}</div><div class="b-puid">${mono(b.puid)}</div></div>
    <span class="badge ${esc(b.status)}">${esc(b.status)}</span>
    <div class="b-sub">${sub}</div></li>`;
}
function renderList() {
  const list = filteredBoards();
  const c = counts(list);
  $('#list-count').textContent = `${list.length}건 (재고 ${c.stock} / 분출 ${c.out})`;
  $('#board-list').innerHTML = list.map(boardItem).join('') || '<li class="muted">보드가 없습니다. 입고 탭에서 등록하거나 설정에서 CSV 를 가져오세요.</li>';
}

/* ------------------------------------------------------------------ 상세 / 분출 / 반납 / 수정 */
function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  if (Cam.running && Cam.elId === 'cam-modal') Cam.stop();
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
  document.body.style.overflow = '';
}

function detailHtml(b) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v || '<span class="muted">-</span>'}</dd>`;
  const chk = puidCheck(b);
  return `<dl class="kv">
    ${row('품명(모델)', esc(b.model))}${row('제조사', esc(b.maker))}${row('CODENO', mono(b.codeno))}
    ${row('PUID', mono(b.puid) + (chk ? ` <span class="${chk === 'OK' ? 'hint ok' : 'hint bad'}">검증 ${chk}</span>` : ''))}
    ${row('LOT', mono(b.lot))}${row('DATE', mono(b.date) + (b.date ? ` <span class="muted">(${mfgOf(b.date)})</span>` : ''))}
    ${row('수량', b.qty)}${row('상태', `<span class="badge ${esc(b.status)}">${esc(b.status)}</span>`)}
    ${b.status === '분출' ? row('분출구분', esc(b.outType)) + row('수령자', esc(b.recipient)) + row('소속/팀', esc(b.team)) + row('분출일', esc(b.outDate)) : ''}
    ${row('비고', esc(b.note))}
    ${b.labelTime || b.labelNo ? row('물류라벨', esc(b.labelTime) + ' ' + mono(b.labelNo)) : ''}
  </dl>`;
}

function actionButtons(b) {
  return `<div class="btn-row">
    ${b.status === '재고' ? `<button type="button" class="btn out wide" data-act="out" data-id="${esc(b.id)}">분출</button>` : `<button type="button" class="btn ret wide" data-act="return" data-id="${esc(b.id)}">반납 (재고로)</button>`}
    <button type="button" class="btn" data-act="edit" data-id="${esc(b.id)}">수정</button>
    <button type="button" class="btn" data-act="label" data-id="${esc(b.id)}">라벨</button>
  </div>`;
}

function openDetail(id) {
  const b = byId(id);
  if (!b) return toast('보드를 찾을 수 없습니다', 'err');
  const hist = S.history.filter((h) => up(h.id) === b.id).slice(0, 10);
  openModal(`<h2>${esc(b.id)}</h2>${detailHtml(b)}${actionButtons(b)}
    ${hist.length ? `<h3>이력</h3><ul class="history">${historyHtml(hist)}</ul>` : ''}`);
}

function openOut(id) {
  const b = byId(id);
  if (!b) return;
  if (b.status === '분출') return toast(`${b.id} 은(는) 이미 분출 상태입니다`, 'err');
  const recent = [...new Set(S.boards.filter((x) => x.team).map((x) => x.team))];
  openModal(`<h2>분출 — ${esc(b.id)}</h2>
    <div class="mono-preview">${mono(b.puid)}</div>
    <form id="out-form" class="form" autocomplete="off">
      <label>분출구분 <select name="outType" required>${OUT_TYPES.map((t) => `<option ${t === '타팀' ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>수령자 <span class="req">*</span><input name="recipient" required></label>
      <label>소속/팀 <input name="team" list="team-list"><datalist id="team-list">${recent.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
      <label>분출일 <input name="outDate" type="date" value="${today()}" required></label>
      <label>비고 <input name="note" value="${esc(b.note)}"></label>
      <div class="btn-row"><button class="btn out wide" type="submit">분출 처리</button></div>
    </form>`);
  $('#out-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const fields = { status: '분출', outType: f.outType, recipient: f.recipient.trim(), team: f.team.trim(), outDate: f.outDate, note: f.note.trim() };
    commit({ type: 'update', id: b.id, fields, expect: { status: '재고' }, action: '분출', detail: `${f.outType} / ${fields.recipient} / ${fields.team} / ${f.outDate}` });
    closeModal();
    toast(`${b.id} 분출 처리됨`, 'ok');
    afterScanAction();
  });
  setTimeout(() => $('#out-form [name=recipient]').focus(), 50);
}

function openReturn(id) {
  const b = byId(id);
  if (!b) return;
  if (b.status !== '분출') return toast(`${b.id} 은(는) 재고 상태입니다`, 'err');
  openModal(`<h2>반납 — ${esc(b.id)}</h2>
    <p>${esc(b.recipient)} (${esc(b.team)}, ${esc(b.outDate)} 분출) 에게서 반납받아 <b>재고</b>로 돌립니다.</p>
    <form id="ret-form" class="form" autocomplete="off">
      <label>반납 메모 (이력에 기록) <input name="memo" placeholder="예: 정상 동작 확인"></label>
      <div class="btn-row"><button class="btn ret wide" type="submit">반납 처리</button></div>
    </form>`);
  $('#ret-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const memo = new FormData(e.target).get('memo').trim();
    const fields = { status: '재고', outType: '', recipient: '', team: '', outDate: '' };
    commit({ type: 'update', id: b.id, fields, expect: { status: '분출' }, action: '반납', detail: `${b.outType} / ${b.recipient} / ${b.team} / ${b.outDate} 분출분 반납${memo ? ' — ' + memo : ''}` });
    closeModal();
    toast(`${b.id} 반납 처리됨`, 'ok');
    afterScanAction();
  });
}

function openEdit(id) {
  const b = byId(id);
  if (!b) return;
  openModal(`<h2>수정 — ${esc(b.id)}</h2>
    <form id="edit-form" class="form" autocomplete="off">
      <label>상태 <select name="status">${STATUSES.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>분출구분 <select name="outType"><option value=""></option>${OUT_TYPES.map((t) => `<option ${t === b.outType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="grid2"><label>수령자 <input name="recipient" value="${esc(b.recipient)}"></label><label>소속/팀 <input name="team" value="${esc(b.team)}"></label></div>
      <label>분출일 <input name="outDate" type="date" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(b.outDate) ? b.outDate : '')}"></label>
      <label>비고 <input name="note" value="${esc(b.note)}"></label>
      <div class="grid2"><label>물류라벨 일시 <input name="labelTime" value="${esc(b.labelTime)}"></label><label>물류라벨 번호 <input name="labelNo" value="${esc(b.labelNo)}"></label></div>
      <p class="muted small">PUID·LOT 등 식별 정보는 시트에서 직접 고칩니다 (시트 사용안내: 노란 칸만 입력).</p>
      <div class="btn-row"><button class="btn primary wide" type="submit">저장</button></div>
    </form>`);
  $('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const fields = {};
    for (const k of ['status', 'outType', 'recipient', 'team', 'outDate', 'note', 'labelTime', 'labelNo']) {
      const v = String(f[k] ?? '').trim();
      if (v !== (b[k] || '')) fields[k] = v;
    }
    if (!Object.keys(fields).length) { closeModal(); return; }
    const detail = Object.entries(fields).map(([k, v]) => `${FIELD_LABEL[k]}: ${b[k] || '∅'} → ${v || '∅'}`).join(', ');
    commit({ type: 'update', id: b.id, fields, expect: { status: b.status }, action: '수정', detail });
    closeModal();
    toast(`${b.id} 수정됨`, 'ok');
  });
}
const FIELD_LABEL = { status: '상태', outType: '분출구분', recipient: '수령자', team: '소속/팀', outDate: '분출일', note: '비고', labelTime: '물류라벨 일시', labelNo: '물류라벨 번호' };

/* ------------------------------------------------------------------ 스캔 화면 */
async function startScanCam() {
  const btn = $('#btn-cam-toggle');
  btn.disabled = true;
  try {
    await Cam.start('cam-scan', (t, src) => handleScan(t, src));
    $('.cam-box').classList.add('on');
    btn.textContent = '카메라 끄기';
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally { btn.disabled = false; }
}
async function stopScanCam() {
  await Cam.stop();
  $('.cam-box').classList.remove('on');
  $('#btn-cam-toggle').textContent = '카메라 켜기';
}

function handleScan(raw, src = 'manual') {
  const r = lookup(raw);
  if (S.scanMode === 'audit') return auditScan(r);
  const el = $('#scan-result');
  const rawLine = `<div class="raw">${src === 'camera' ? '카메라' : src === 'photo' ? '사진' : src === 'reader' ? '리더기' : '입력'}: ${esc(r.p.raw)}</div>`;
  if (r.kind === 'id' || r.kind === 'puid') {
    const b = r.boards[0];
    el.innerHTML = `<div class="result-card ${r.warn ? 'warn' : ''}">
      <div class="result-title"><span>${esc(b.id)}</span><span class="badge ${esc(b.status)}">${esc(b.status)}</span></div>
      ${r.warn ? `<div class="hint bad">${esc(r.warn)}</div>` : ''}
      ${detailHtml(b)}${actionButtons(b)}${rawLine}</div>`;
  } else if (r.kind === 'lot') {
    el.innerHTML = `<div class="result-card warn"><div class="result-title">LOT ${mono(r.token)} — ${r.boards.length}대</div>
      <p class="muted small">LOT 바코드입니다. 보드를 고르거나 PUID 바코드를 스캔하세요.</p>
      <ul class="board-list">${r.boards.map(boardItem).join('')}</ul>${rawLine}</div>`;
  } else if (r.kind === 'codeno') {
    el.innerHTML = `<div class="result-card warn"><div class="result-title">품목코드(CODENO) ${mono(r.token)}</div>
      <p>모든 보드가 같은 코드입니다. 박스의 <b>PUID</b> 바코드나 관리번호 QR 라벨을 스캔하세요.</p>${rawLine}</div>`;
  } else {
    el.innerHTML = `<div class="result-card err"><div class="result-title">대장에 없음</div>
      <p class="mono-preview">${mono(r.token)}</p>
      ${r.newPuid ? `<div class="btn-row"><button type="button" class="btn primary wide" data-act="new" data-puid="${esc(r.newPuid)}">이 PUID 로 입고 등록</button></div>` : '<p class="muted small">PUID 형식(앞 2글자 + CN + LOT)이 아닙니다.</p>'}
      ${rawLine}</div>`;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function afterScanAction() {
  if (S.view === 'scan') $('#scan-result').innerHTML = '';
}

/* 재고 실사 */
function auditScan(r) {
  const el = $('#scan-result');
  if (r.kind === 'id' || r.kind === 'puid') {
    const b = r.boards[0];
    const dup = S.audit.includes(b.id);
    if (!dup) { S.audit.push(b.id); save(LS.audit, S.audit); }
    el.innerHTML = `<div class="result-card ${b.status === '분출' ? 'err' : ''}"><div class="result-title"><span>${esc(b.id)} ${dup ? '(이미 확인)' : '확인'}</span><span class="badge ${esc(b.status)}">${esc(b.status)}</span></div>
      ${b.status === '분출' ? `<p class="hint bad">대장상 분출(${esc(b.recipient)}, ${esc(b.team)}) 인데 실물이 있습니다. 반납 처리가 필요한지 확인하세요.</p>${actionButtons(b)}` : ''}
      ${r.warn ? `<div class="hint bad">${esc(r.warn)}</div>` : ''}</div>`;
  } else {
    el.innerHTML = `<div class="result-card err"><div class="result-title">확인 불가</div><p class="mono-preview">${mono(r.token)}</p>
      <p class="muted small">${r.kind === 'lot' ? 'LOT 바코드입니다. PUID 를 스캔하세요.' : '대장에 없는 코드입니다.'}</p></div>`;
  }
  renderAudit();
}
function renderAudit() {
  const stock = S.boards.filter((b) => b.status === '재고');
  const found = S.audit.map(byId).filter(Boolean);
  const okN = stock.filter((b) => S.audit.includes(b.id)).length;
  $('#audit-count').textContent = `${okN} / ${stock.length}`;
  $('#audit-bar').style.width = stock.length ? `${(okN / stock.length) * 100}%` : '0';
  const missing = stock.filter((b) => !S.audit.includes(b.id));
  $('#audit-missing-n').textContent = `${missing.length}대`;
  $('#audit-missing').innerHTML = missing.map((b) => `<li><b>${esc(b.id)}</b>${mono(b.puid)}</li>`).join('') || '<li class="muted">없음 — 재고 전부 확인</li>';
  $('#audit-found').innerHTML = found.map((b) => `<li><b>${esc(b.id)}</b><span class="badge ${esc(b.status)}">${esc(b.status)}</span></li>`).join('') || '<li class="muted">아직 없음</li>';
}

/* ------------------------------------------------------------------ 입고 */
function prepAddForm(keepPuid) {
  const f = $('#add-form');
  if (!keepPuid) f.puid.value = '';
  if (!f.id.value || byId(f.id.value)) f.id.value = nextId();
  f.model.value = f.model.value || S.settings.dModel;
  f.maker.value = f.maker.value || S.settings.dMaker;
  f.codeno.value = f.codeno.value || S.settings.dCodeno;
  updateAddCheck();
}
function fillAddFromScan(raw) {
  const p = parseScan(raw);
  const f = $('#add-form');
  const puid = p.tokens.find((t) => derive(t));
  const lot = p.fields.lot || p.tokens.find(isLotLike);
  const kind = codeKind(raw);
  if (puid) {
    f.puid.value = puid;
  } else if (lot) {
    fillLotOnly(lot, p.fields.date);
    toast('LOT 바코드를 읽었습니다. PUID 바코드를 스캔하거나 PUID 앞 2글자를 입력하세요.', '', 5000);
    return;
  } else if (kind === '관리번호') {
    toast(`${up(p.tokens[0])} 은(는) 이미 등록된 보드입니다`, 'err');
    return;
  } else if (kind === 'CODENO') {
    toast('품목코드(CODENO) 바코드입니다. 박스의 PUID 바코드를 스캔하세요.', 'err', 5000);
    return;
  } else {
    f.puid.value = p.tokens[0] || '';
  }
  onPuidChange();
}
/** PUID 는 못 읽고 LOT 만 읽었을 때: PUID = 앞 2글자 + CN + LOT 이므로 뒤쪽을 채워 두고 앞 2글자만 입력받는다 */
function fillLotOnly(lot, date) {
  const f = $('#add-form');
  lot = up(lot);
  f.lot.value = lot;
  f.date.value = date || (/^\d{4}$/.test(lot.slice(4, 8)) ? lot.slice(4, 8) : '');
  const cur = up(f.puid.value);
  if (!derive(cur) || cur.slice(4) !== lot) f.puid.value = 'CN' + lot;
  updateAddCheck();
  if (f.puid.value === 'CN' + lot) { f.puid.focus(); try { f.puid.setSelectionRange(0, 0); } catch { /* */ } }
}
function puidCandidates(codes) {
  const set = new Set();
  for (const c of codes) for (const t of parseScan(c.text).tokens) if (derive(t)) set.add(t);
  return [...set];
}
const isRegisteredPuid = (p) => S.boards.find((b) => b.puid && loose(b.puid) === loose(p));
/** 사진 → 입고 화면 */
async function photoToAdd(file) {
  const f = $('#add-form');
  const box = $('#add-photo-codes');
  box.innerHTML = '<p class="muted small" id="photo-step">사진 인식 중…</p>';
  let codes = [];
  try { codes = await readPhotoCodes(file, (s) => { const el = $('#photo-step'); if (el) el.textContent = s; }); } catch { /* 아래에서 안내 */ }
  box.innerHTML = codesListHtml(codes);
  if (!codes.length) return toast(PHOTO_FAIL, 'err', 7000);
  const cands = puidCandidates(codes);
  const fresh = cands.filter((p) => !isRegisteredPuid(p));
  if (fresh.length > 1) {
    openModal(`<h2>PUID 선택</h2><p class="muted small">사진에 등록 안 된 PUID 가 ${fresh.length}개 있습니다. 이번에 등록할 것을 고르세요.</p>
      <div class="pick-list">${fresh.map((p) => `<button type="button" class="btn wide" data-act="pick-puid" data-puid="${esc(p)}">${mono(p)}</button>`).join('')}</div>
      <div class="btn-row"><button type="button" class="btn" data-close="1">닫기</button></div>`);
    return;
  }
  if (cands.length) {
    f.puid.value = fresh[0] || cands[0];
    onPuidChange();
    toast(fresh.length ? `PUID ${f.puid.value} 인식 (바코드 ${codes.length}개 중)` : `PUID ${f.puid.value} 는 이미 등록된 보드입니다`, fresh.length ? 'ok' : 'err', 4000);
    return;
  }
  const lot = codes.map((c) => parseScan(c.text)).map((p) => p.fields.lot || p.tokens.find(isLotLike)).find(Boolean);
  if (lot) {
    fillLotOnly(lot);
    toast('PUID 바코드는 못 읽고 LOT 만 읽었습니다. PUID 앞 2글자를 입력하거나 PUID 바코드가 크게 나오게 다시 찍어 보세요.', 'err', 7000);
    return;
  }
  toast(`PUID 바코드를 찾지 못했습니다 (읽은 것: ${codes.map((c) => codeKind(c.text)).join(', ')}). PUID 바코드가 크게 나오게 다시 찍어 보세요.`, 'err', 7000);
}
/** 사진 → 스캔 화면 (조회·실사) */
async function photoToScan(file) {
  const el = $('#scan-result');
  el.innerHTML = '<div class="result-card"><p class="muted" id="photo-step">사진 인식 중…</p></div>';
  let codes = [];
  try { codes = await readPhotoCodes(file, (s) => { const p = $('#photo-step'); if (p) p.textContent = s; }); } catch { /* 아래에서 안내 */ }
  if (!codes.length) { el.innerHTML = ''; return toast(PHOTO_FAIL, 'err', 7000); }
  const rs = codes.map((c) => ({ c, r: lookup(c.text) }));
  const boardHits = rs.filter((x) => x.r.kind === 'id' || x.r.kind === 'puid');
  if (S.scanMode === 'audit' && boardHits.length) {
    const seen = new Set();
    for (const x of boardHits) if (!seen.has(x.r.boards[0].id)) { seen.add(x.r.boards[0].id); auditScan(x.r); }
    if (seen.size > 1) toast(`사진에서 보드 ${seen.size}대 확인: ${[...seen].join(', ')}`, 'ok', 5000);
  } else {
    const score = (r) => ({ id: 0, puid: 0, lot: 3, codeno: 4 }[r.kind] ?? (r.newPuid ? 1 : 5));
    rs.sort((a, b) => score(a.r) - score(b.r));
    handleScan(rs[0].c.text, 'photo');
  }
  el.insertAdjacentHTML('beforeend', codesListHtml(codes));
}
function onPuidChange() {
  const f = $('#add-form');
  f.puid.value = up(f.puid.value);
  const d = derive(f.puid.value);
  if (d) { f.lot.value = d.lot; f.date.value = d.date; }
  updateAddCheck();
}
function updateAddCheck() {
  const f = $('#add-form');
  $('#add-puid-preview').innerHTML = mono(up(f.puid.value));
  const hint = $('#add-check');
  const puid = up(f.puid.value), lot = up(f.lot.value);
  hint.className = 'hint';
  if (!puid) { hint.textContent = ''; return; }
  if (lot && puid === 'CN' + lot) { hint.textContent = 'PUID 앞 2글자만 입력하세요 (PUID = 앞 2글자 + CN + LOT). 박스 라벨의 PUID 글자를 보고 0/O, 1/I 를 구분해 입력합니다.'; hint.classList.add('bad'); return; }
  const dupP = S.boards.find((b) => b.puid === puid || loose(b.puid) === loose(puid));
  if (dupP) { hint.textContent = `이미 등록된 PUID 입니다 → ${dupP.id}${dupP.puid !== puid ? ' (0/O·1/I 차이만 있음)' : ''}`; hint.classList.add('bad'); return; }
  if (puid.slice(2) === 'CN' + lot) {
    hint.textContent = `PUID 검증 OK · ${mfgOf(f.date.value)} · 앞 2글자 ${puid.slice(0, 2)} 의 숫자/영문 구분을 확인하세요 (파란색 = 숫자)`;
    hint.classList.add('ok');
  } else {
    hint.textContent = 'PUID 뒤쪽이 CN + LOT 와 다릅니다 — 확인';
    hint.classList.add('bad');
  }
}
function submitAdd(e) {
  e.preventDefault();
  const f = e.target;
  const b = normBoard(Object.fromEntries(new FormData(f)));
  if (!b.id || !b.puid) return toast('관리번호와 PUID 는 필수입니다', 'err');
  if (byId(b.id)) return toast(`관리번호 ${b.id} 이(가) 이미 있습니다`, 'err');
  const dup = S.boards.find((x) => loose(x.puid) === loose(b.puid));
  if (dup) return toast(`이미 등록된 PUID 입니다 (${dup.id})`, 'err');
  if (puidCheck(b) !== 'OK' && !confirm('PUID 뒤쪽이 CN + LOT 와 다릅니다. 그래도 저장할까요?')) return;
  b.status = '재고';
  commit({ type: 'add', id: b.id, board: b, action: '입고', detail: `PUID ${b.puid} / LOT ${b.lot} / ${b.model}` });
  toast(`${b.id} 입고 등록됨`, 'ok');
  const cont = f.cont.checked;
  for (const k of ['puid', 'lot', 'date', 'note', 'labelTime', 'labelNo']) f[k].value = '';
  f.qty.value = 1;
  f.id.value = nextId();
  $('#add-photo-codes').innerHTML = '';
  updateAddCheck();
  if (cont) f.puid.focus(); else show('list');
}

/* 모달 카메라 (입고 PUID 스캔): PUID 가 아닌 바코드(CODENO·LOT 등)는 알려 주기만 하고 계속 찾는다 */
function openCamModal(onCode, accept = () => true, onOther = () => {}) {
  openModal(`<h2>바코드 스캔</h2><div class="cam-box on"><div id="cam-modal" class="cam"></div></div>
    <p class="small" id="cam-modal-msg">박스의 <b>PUID</b> 바코드를 화면 가운데에 맞추세요.</p>
    <p class="muted small">작은 바코드가 안 잡히면 <b>사진 찍어 인식</b>이 더 잘 됩니다 (폰 카메라 앱의 고해상도·초점 사용).</p>
    <div class="btn-row"><label class="btn primary" for="file-add">사진 찍어 인식</label><button type="button" class="btn" data-close="1">닫기</button></div>`);
  Cam.start('cam-modal', (t) => {
    if (accept(t)) { closeModal(); onCode(t); return; }
    onOther(t);
    const m = $('#cam-modal-msg');
    if (m) m.innerHTML = `읽음: ${mono(up(t).replace(/[\x00-\x1f]/g, ' ').slice(0, 40))} <span class="tag">${esc(codeKind(t))}</span><br>이 바코드가 아닙니다. <b>PUID</b> 바코드를 비추세요.`;
  }).catch((e) => { closeModal(); toast(e.message, 'err', 6000); });
}

/* ------------------------------------------------------------------ 설정 */
function fillSettings() {
  const f = $('#settings-form');
  const s = S.settings;
  for (const k of ['user', 'url', 'token', 'dModel', 'dMaker', 'dCodeno', 'dPrefix']) f[k].value = s[k] || '';
  $$('input[name=mode]', f).forEach((r) => { r.checked = r.value === s.mode; });
  $('#sheet-fields').hidden = s.mode !== 'sheet';
  $('#share-qr').hidden = true;
  $('#app-info').textContent = `버전 ${APP_VERSION} · 보드 ${S.boards.length}대 · 대기 작업 ${S.outbox.length}건` + (S.lastSync ? ` · 마지막 동기화 ${S.lastSync}` : '');
}
function readSettingsForm() {
  const f = $('#settings-form');
  const o = Object.fromEntries(new FormData(f));
  o.url = (o.url || '').trim(); o.token = (o.token || '').trim();
  o.dPrefix = up(o.dPrefix) || 'BRD';
  return Object.assign({}, S.settings, o);
}
async function saveSettings(e) {
  e.preventDefault();
  const prev = S.settings;
  const next = readSettingsForm();
  if (next.mode === 'sheet' && (!next.url || !next.token)) return toast('Apps Script URL 과 토큰을 입력하세요', 'err');
  const switching = next.mode === 'sheet' && (prev.mode !== 'sheet' || prev.url !== next.url);
  if (switching && S.boards.length && !confirm('Google 시트 연동으로 바꾸면 이 기기의 대장을 시트 내용으로 바꿉니다.\n(시트에 없는 이 기기 데이터는 먼저 CSV 로 내보내 두세요)\n계속할까요?')) return;
  S.settings = next;
  save(LS.settings, next);
  if (switching) S.outbox = [];
  persist();
  toast('설정 저장됨', 'ok');
  renderAll();
  if (isSheet()) await pull();
  fillSettings();
}
async function testConnection() {
  const next = readSettingsForm();
  if (!next.url || !next.token) return toast('URL 과 토큰을 입력하세요', 'err');
  const keep = S.settings;
  S.settings = Object.assign({}, keep, { url: next.url, token: next.token });
  try {
    const r = await Api.call({ action: 'ping' }, 20000);
    if (r.ok) toast(`연결 성공 — 시트 "${r.sheet}" 보드 ${r.count}대`, 'ok', 5000);
    else toast(r.error === 'auth' ? '토큰이 맞지 않습니다' : `오류: ${r.message || r.error}`, 'err', 5000);
  } catch (e) { toast(e.message, 'err', 5000); }
  finally { S.settings = keep; }
}
function showShareQr() {
  const s = readSettingsForm();
  if (!s.url || !s.token) return toast('URL 과 토큰을 먼저 입력하세요', 'err');
  const payload = b64url(JSON.stringify({ u: s.url, t: s.token }));
  const link = location.origin + location.pathname + '#setup=' + payload;
  const qr = qrcode(0, 'L');
  qr.addData(link);
  qr.make();
  const box = $('#share-qr');
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) +
    `<p class="small">팀원 휴대폰 카메라로 찍으면 앱이 열리고 연동 설정이 채워집니다.<br><b>토큰이 들어 있으니 팀 밖으로 공유하지 마세요.</b></p>
     <button type="button" class="btn small" id="btn-copy-link">링크 복사</button>`;
  box.hidden = false;
  $('#btn-copy-link').onclick = () => navigator.clipboard?.writeText(link).then(() => toast('링크 복사됨', 'ok'), () => toast('복사 실패', 'err'));
}
const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

function checkSetupLink() {
  const m = location.hash.match(/setup=([A-Za-z0-9_-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const o = JSON.parse(unb64url(m[1]));
    if (!o.u || !o.t) throw new Error();
    S.settings = Object.assign({}, S.settings, { mode: 'sheet', url: o.u, token: o.t });
    save(LS.settings, S.settings);
    S.outbox = [];
    persist();
    toast('Google 시트 연동이 설정되었습니다. 설정 탭에서 이름을 입력하세요.', 'ok', 6000);
  } catch { toast('설정 링크가 올바르지 않습니다', 'err'); }
}

/* ------------------------------------------------------------------ CSV */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function csvToBoards(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().split('\n')[0]);
  const idx = CSV_HEADERS.map((h) => head.findIndex((x) => x === h || x.startsWith(h)));
  if (idx[0] < 0) throw new Error('"관리번호" 열이 없습니다');
  const extra = { model: head.indexOf('품명(모델)'), maker: head.indexOf('제조사'), codeno: head.indexOf('CODENO') };
  return rows.slice(1).map((r) => {
    const o = {};
    CSV_KEYS.forEach((k, i) => { o[k] = idx[i] >= 0 ? (r[idx[i]] || '').trim() : ''; });
    for (const [k, i] of Object.entries(extra)) if (i >= 0) o[k] = (r[i] || '').trim();
    if (o.outDate) o.outDate = o.outDate.replace(/\s/g, '').replace(/[./]/g, '-').replace(/-$/, '');
    return normBoard(o);
  }).filter((b) => b.id);
}
function boardsToCsv(list) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [CSV_HEADERS.join(','), ...list.map((b) => CSV_KEYS.map((k) => q(b[k])).join(','))].join('\r\n') + '\r\n';
}
function download(name, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportCsv(list = S.boards) {
  download(`ledger_${today()}.csv`, boardsToCsv(list));
}
async function importCsv(file) {
  let list;
  try { list = csvToBoards(await file.text()); } catch (e) { return toast('CSV 오류: ' + e.message, 'err'); }
  if (!list.length) return toast('가져올 행이 없습니다', 'err');
  const fresh = list.filter((b) => !byId(b.id));
  if (isSheet()) {
    if (!fresh.length) return toast('시트에 없는 새 보드가 없습니다');
    if (!confirm(`CSV ${list.length}행 중 대장에 없는 ${fresh.length}대를 Google 시트에 입고로 추가할까요?\n(이미 있는 관리번호는 건너뜁니다)`)) return;
    for (const b of fresh) commit({ type: 'add', id: b.id, board: b, action: '입고', detail: `CSV 가져오기 / PUID ${b.puid}` });
    return toast(`${fresh.length}대 추가 요청`, 'ok');
  }
  const replace = S.boards.length ? confirm(`CSV ${list.length}행을 가져옵니다.\n[확인] 이 기기 대장을 CSV 로 교체\n[취소] 새 관리번호(${fresh.length}대)만 추가`) : true;
  if (replace) {
    S.boards = list; sortBoards();
    S.history.unshift({ ts: nowStr(), action: '가져오기', id: '-', detail: `CSV ${file.name} ${list.length}행으로 교체`, user: S.settings.user || '(미지정)' });
  } else {
    fresh.forEach((b) => S.boards.push(b)); sortBoards();
    S.history.unshift({ ts: nowStr(), action: '가져오기', id: '-', detail: `CSV ${file.name} 에서 ${fresh.length}대 추가`, user: S.settings.user || '(미지정)' });
  }
  persist(); renderAll();
  toast('가져오기 완료', 'ok');
}

/* ------------------------------------------------------------------ 라벨 인쇄 (관리번호 QR) */
function printLabels(list) {
  if (!list.length) return toast('인쇄할 보드가 없습니다', 'err');
  const area = $('#print-area');
  area.innerHTML = list.map((b) => {
    const qr = qrcode(0, 'M');
    qr.addData(b.id);
    qr.make();
    return `<div class="label">${qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true })}
      <div><div class="l-id">${esc(b.id)}</div><div class="l-sub">${esc(b.model)}</div>
      <div class="l-sub">PUID ${mono(b.puid)}</div><div class="l-sub">LOT ${mono(b.lot)}</div></div></div>`;
  }).join('');
  setTimeout(() => window.print(), 100);
}

/* ------------------------------------------------------------------ 토스트 */
let toastTimer;
function toast(msg, kind = '', ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ 이벤트 연결 */
function bind() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#sync-badge').addEventListener('click', () => (isSheet() ? (S.outbox.length ? flush() : pull()) : show('settings')));

  // 모달 닫기
  $('#modal').addEventListener('click', (e) => { if (e.target.dataset.close) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  // 공통 액션 버튼 (상세·스캔 결과·대장)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const id = a.dataset.id;
      if (a.dataset.act === 'out') openOut(id);
      else if (a.dataset.act === 'return') openReturn(id);
      else if (a.dataset.act === 'edit') openEdit(id);
      else if (a.dataset.act === 'label') { const b = byId(id); if (b) printLabels([b]); }
      else if (a.dataset.act === 'pick-puid') { closeModal(); $('#add-form').puid.value = a.dataset.puid; onPuidChange(); toast(`PUID ${a.dataset.puid} 선택`, 'ok'); }
      else if (a.dataset.act === 'new') { show('add'); $('#add-form').puid.value = a.dataset.puid; onPuidChange(); }
      return;
    }
    const li = e.target.closest('.board[data-id]');
    if (li) openDetail(li.dataset.id);
  });

  // 스캔 화면
  $$('[data-scanmode]').forEach((b) => b.addEventListener('click', () => {
    S.scanMode = b.dataset.scanmode;
    $$('[data-scanmode]').forEach((x) => x.classList.toggle('active', x === b));
    $('#audit-panel').hidden = S.scanMode !== 'audit';
    $('#scan-result').innerHTML = '';
    renderAudit();
  }));
  $('#btn-cam-toggle').addEventListener('click', () => (Cam.running && Cam.elId === 'cam-scan' ? stopScanCam() : startScanCam()));
  $('#file-scan').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    photoToScan(file);
  });
  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#manual-input').value.trim();
    if (!v) return;
    handleScan(v, 'manual');
    $('#manual-input').value = '';
  });
  $('#btn-audit-reset').addEventListener('click', () => {
    if (S.audit.length && !confirm('실사 확인 목록을 비울까요?')) return;
    S.audit = []; save(LS.audit, S.audit); renderAudit(); $('#scan-result').innerHTML = '';
  });
  $('#btn-audit-save').addEventListener('click', () => {
    const stock = S.boards.filter((b) => b.status === '재고');
    const missing = stock.filter((b) => !S.audit.includes(b.id)).map((b) => b.id);
    const outFound = S.audit.map(byId).filter((b) => b && b.status === '분출').map((b) => b.id);
    const detail = `재고 ${stock.length}대 중 ${stock.length - missing.length}대 확인` + (missing.length ? ` / 미확인: ${missing.join(', ')}` : '') + (outFound.length ? ` / 분출인데 실물 있음: ${outFound.join(', ')}` : '');
    if (!confirm(`실사 결과를 이력에 기록할까요?\n\n${detail}`)) return;
    commit({ type: 'log', id: '-', action: '실사', detail });
    toast('실사 결과 기록됨', 'ok');
  });

  // 대장
  $('#list-q').addEventListener('input', renderList);
  $$('#list-filter .chip').forEach((c) => c.addEventListener('click', () => {
    S.listFilter = c.dataset.f;
    $$('#list-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderList();
  }));
  $('#btn-print-list').addEventListener('click', () => printLabels(filteredBoards()));
  $('#btn-export-list').addEventListener('click', () => exportCsv(filteredBoards()));

  // 입고
  const af = $('#add-form');
  af.addEventListener('submit', submitAdd);
  af.puid.addEventListener('input', onPuidChange);
  af.puid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!af.puid.value) return;
      e.preventDefault();
      const v = af.puid.value; fillAddFromScan(v);
      af.note.focus();
    }
  });
  af.lot.addEventListener('input', updateAddCheck);
  af.date.addEventListener('input', updateAddCheck);
  $$('[data-cam-for]').forEach((b) => b.addEventListener('click', () => openCamModal(
    (t) => fillAddFromScan(t),
    (t) => puidCandidates([{ text: t }]).length > 0,
    (t) => { const p = parseScan(t); const lot = p.fields.lot || p.tokens.find(isLotLike); if (lot) fillLotOnly(lot, p.fields.date); },
  )));
  $('#file-add').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!$('#modal').hidden) closeModal();
    if (file) photoToAdd(file);
  });

  // 설정
  $('#settings-form').addEventListener('submit', saveSettings);
  $$('#settings-form input[name=mode]').forEach((r) => r.addEventListener('change', () => { $('#sheet-fields').hidden = r.value !== 'sheet' || !r.checked; }));
  $('#btn-test').addEventListener('click', testConnection);
  $('#btn-share-qr').addEventListener('click', showShareQr);
  $('#file-csv').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importCsv(f); });
  $('#btn-export').addEventListener('click', () => exportCsv());
  $('#btn-print-all').addEventListener('click', () => printLabels(S.boards));
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('이 기기에 저장된 대장·이력·대기 작업을 모두 지웁니다.\n(Google 시트 데이터는 지워지지 않습니다)\n계속할까요?')) return;
    S.boards = []; S.history = []; S.outbox = []; S.audit = [];
    persist(); save(LS.audit, []);
    renderAll(); fillSettings();
    if (isSheet()) pull();
  });

  // 온라인 복귀 / 앱 복귀 시 동기화
  window.addEventListener('online', () => isSheet() && flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSheet()) pull();
    if (document.visibilityState === 'hidden' && Cam.running) { Cam.stop(); $('.cam-box').classList.remove('on'); $('#btn-cam-toggle').textContent = '카메라 켜기'; }
  });
}

/* ------------------------------------------------------------------ 시작 */
function init() {
  checkSetupLink();
  bind();
  renderAll();
  show('dash');
  if (isSheet()) { pull(); setInterval(() => document.visibilityState === 'visible' && pull(), 60000); }
  else if (!S.boards.length) toast('설정 탭에서 Google 시트를 연동하거나 CSV 를 가져오세요', '', 5000);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
