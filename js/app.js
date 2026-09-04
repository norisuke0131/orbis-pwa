// app.js
// アプリのエントリポイント。走行画面の統括。
// 地図表示/現在地取得/速度表示（Phase 0）に加え、行動ログ記録、
// オービス地点の3段階音声警報、地点の自己登録、駐車位置、GPX再生を接続する。

import { GeoTracker } from './geo.js';
import { TripRecorder } from './recorder.js';
import { initHistory, refreshHistoryList } from './history.js';
import { initSettings, refreshStorageInfo } from './settings.js';
import { getSetting, setSetting } from './config.js';
import { deleteTripsBefore, addParking, getAllParking, deleteParking, putSpots, clearSpots } from './db.js';
import { getAllSpots, addSpotWithDedup, makeSpot, TYPE_LABELS } from './spots.js';
import { AlertEngine } from './alerts.js';
import { speak, unlockSpeech, setMuted, isMuted } from './speech.js';
import { MockTracker, buildSampleTrack, sampleSpots, parseGPX } from './replay.js';
import { formatDistance } from './analysis.js';

// --- 三条市周辺を初期表示中心にする（要件のサンプル地域） ---
const INITIAL_CENTER = [37.6, 139.0];
const INITIAL_ZOOM = 13;
const FOLLOW_ZOOM = 16; // 現在地取得後の追従ズーム

/** アプリ全体の状態 */
const state = {
  map: null,
  selfMarker: null, // 自車位置マーカー
  accuracyCircle: null, // 位置精度の円
  tracker: new GeoTracker(),
  recorder: new TripRecorder(), // 行動ログ記録係
  firstFix: true, // 最初の測位で地図を寄せるためのフラグ
  headingUp: true, // true=進行方向アップ / false=北アップ
  appliedRotation: 0, // #map に適用中の回転角（連続値・度）
  lastMovingAt: 0, // 最後に「移動中」と判定した時刻（自動停止用）
  autoStopTimer: null, // 停車自動停止の監視タイマー
  spots: [], // 読み込み済みの地点(SpotRecord)
  spotLayer: null, // 地点マーカーのレイヤ
  parkingMarker: null, // 最新の駐車位置マーカー
  alertEngine: new AlertEngine(), // 警報エンジン
  lastFix: null, // 直近の fix（駐車位置保存などに使用）
  replay: null, // 再生中の MockTracker
  replayMode: false, // GPX再生中か
  bannerTimer: null, // 警報バナーの自動消去タイマー
  spotFormLatLng: null, // 地点登録フォームの対象座標
  wakeLock: null, // 画面消灯防止(Screen Wake Lock)
};

// DOM 参照
const el = {
  mapViewport: document.getElementById('map-viewport'),
  map: document.getElementById('map'),
  speed: document.getElementById('speed-value'),
  status: document.getElementById('status'),
  startBtn: document.getElementById('start-btn'),
  headingInfo: document.getElementById('heading-info'),
  rotateBtn: document.getElementById('rotate-btn'),
  screenDrive: document.getElementById('screen-drive'),
  alertBanner: document.getElementById('alert-banner'),
  nextSpot: document.getElementById('next-spot'),
  muteBtn: document.getElementById('mute-btn'),
  parkBtn: document.getElementById('park-btn'),
  replayChip: document.getElementById('replay-chip'),
  replayChipLabel: document.getElementById('replay-chip-label'),
  replayStop: document.getElementById('replay-stop'),
  alertLog: document.getElementById('alert-log'),
  parkPrompt: document.getElementById('park-prompt'),
  // 地点登録モーダル
  spotModal: document.getElementById('spot-modal'),
  spotTypeBtns: document.getElementById('spot-type-btns'),
  spotName: document.getElementById('spot-name'),
  spotLimit: document.getElementById('spot-limit'),
  spotLatlng: document.getElementById('spot-latlng'),
  spotSave: document.getElementById('spot-save'),
  spotCancel: document.getElementById('spot-cancel'),
};

/** 地図を初期化する。 */
function initMap() {
  // 回転する #map の中に既定コントロールがあると一緒に回ってしまうため無効化。
  // ズームボタンとOSM出典は地図の外（回転しない領域）で扱う。
  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
  }).setView(INITIAL_CENTER, INITIAL_ZOOM);

  // OpenStreetMap タイル（出典は .osm-attrib で常時表示・ODbL準拠）。
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(state.map);

  // 地点マーカー用レイヤ
  state.spotLayer = L.layerGroup().addTo(state.map);

  // 地図の長押し（モバイル）/右クリック（PC）で地点登録
  state.map.on('contextmenu', (e) => openSpotForm(e.latlng.lat, e.latlng.lng));

  // 回転で四隅が欠けないよう、地図を画面より大きめに描画して中央に配置する。
  sizeMap();
  window.addEventListener('resize', sizeMap);
  window.addEventListener('orientationchange', () => setTimeout(sizeMap, 300));
}

/**
 * #map をビューポートの対角線を包含する正方形にし、中央へ配置する。
 * これにより任意角度に回転しても空白の四隅が出ない。
 */
function sizeMap() {
  const w = el.mapViewport.clientWidth;
  const h = el.mapViewport.clientHeight;
  // 対角線＋余白（追従アニメの遊び分）
  const side = Math.ceil(Math.hypot(w, h)) + 8;
  el.map.style.width = side + 'px';
  el.map.style.height = side + 'px';
  el.map.style.left = Math.round((w - side) / 2) + 'px';
  el.map.style.top = Math.round((h - side) / 2) + 'px';
  if (state.map) state.map.invalidateSize({ animate: false });
}

/** 2つの角度間の最短差（-180〜180度）。回転を近道で回すために使う。 */
function shortestAngleDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * 進行方向アップ時、地図を -heading だけ回転させて進行方向を画面上向きにする。
 * 連続値で最短回転させ、北アップ時は 0 に戻す。
 * @param {number|null} heading
 */
function updateMapRotation(heading) {
  if (!state.headingUp || heading === null || isNaN(heading)) return;
  const target = -heading; // 地図を進行方向の逆に回すと、進行方向が上になる
  const delta = shortestAngleDelta(state.appliedRotation, target);
  state.appliedRotation += delta;
  el.map.style.transform = `rotate(${state.appliedRotation}deg)`;
}

/** 進行方向アップ / 北アップ を切り替える。 */
function toggleRotate() {
  state.headingUp = !state.headingUp;
  setSetting('headingUp', state.headingUp); // 選択を記憶
  if (state.headingUp) {
    el.rotateBtn.textContent = '⬆ 進行方向';
  } else {
    el.rotateBtn.textContent = '🧭 北アップ';
    // 北アップ: 回転を解除
    state.appliedRotation = 0;
    el.map.style.transform = 'rotate(0deg)';
  }
}

/**
 * 自車位置を地図に反映する。
 * @param {import('./geo.js').GeoFix} fix
 */
function renderSelf(fix) {
  const latlng = [fix.lat, fix.lng];

  // 自車マーカー（矢印風の DivIcon。進行方向があれば回転させる）
  if (!state.selfMarker) {
    state.selfMarker = L.marker(latlng, {
      icon: makeSelfIcon(fix.heading),
    }).addTo(state.map);
  } else {
    state.selfMarker.setLatLng(latlng);
    state.selfMarker.setIcon(makeSelfIcon(fix.heading));
  }

  // 精度円
  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latlng, {
      radius: fix.accuracy,
      color: '#4da3ff',
      weight: 1,
      fillColor: '#4da3ff',
      fillOpacity: 0.12,
    }).addTo(state.map);
  } else {
    state.accuracyCircle.setLatLng(latlng);
    state.accuracyCircle.setRadius(fix.accuracy);
  }

  // 初回測位時のみ地図を現在地へ寄せる（以降はユーザー操作を尊重して追従のみ）
  if (state.firstFix) {
    state.map.setView(latlng, FOLLOW_ZOOM);
    state.firstFix = false;
  } else {
    state.map.panTo(latlng, { animate: true });
  }
}

/**
 * 自車アイコン（進行方向へ回転する矢印）を生成する。
 * heading が null（不定）のときは丸い点で表示。
 * @param {number|null} heading
 */
function makeSelfIcon(heading) {
  const hasDir = heading !== null && !isNaN(heading);
  const rotation = hasDir ? heading : 0;
  const html = hasDir
    ? `<div class="self-arrow" style="transform: rotate(${rotation}deg)"></div>`
    : `<div class="self-dot"></div>`;
  return L.divIcon({
    className: 'self-icon',
    html,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/**
 * 速度・状態表示を更新する。
 * @param {import('./geo.js').GeoFix} fix
 */
function renderHud(fix) {
  el.speed.textContent = Math.round(fix.speedKmh).toString();

  const dir =
    fix.heading === null
      ? '進行方向: 取得待ち（低速/静止）'
      : `進行方向: ${Math.round(fix.heading)}° (${fix.headingSource === 'gps' ? 'GPS' : '2点計算'})`;
  el.headingInfo.textContent = dir;

  el.status.textContent = `測位中 ・ 精度±${Math.round(fix.accuracy)}m`;
  el.status.classList.remove('error');
}

/** 位置情報エラー時の表示。 */
function renderError(err) {
  let msg = '位置情報の取得に失敗しました。';
  if (err && typeof err.code === 'number') {
    if (err.code === 1) msg = '位置情報が許可されていません。ブラウザの設定で許可してください。';
    else if (err.code === 2) msg = '位置を特定できません（電波状況を確認してください）。';
    else if (err.code === 3) msg = '位置情報の取得がタイムアウトしました。';
  } else if (err && err.message) {
    msg = err.message;
  }
  el.status.textContent = msg;
  el.status.classList.add('error');
}

/** 「移動中」とみなす最低速度（km/h）。GPSジッターでの誤リセットを避けるため 5。 */
const MOVING_THRESHOLD_KMH = 5;

/** 位置更新1件の処理。 */
function onFix(fix) {
  state.lastFix = fix;
  renderSelf(fix);
  renderHud(fix);
  updateMapRotation(fix.heading);
  // 走行点の記録（実測位のみ。GPX再生中は保存しない）
  if (!state.replayMode) state.recorder.onFix(fix);
  // 自動停止用: 一定速度以上で動いた時刻を記録
  if (fix.speedKmh >= MOVING_THRESHOLD_KMH) state.lastMovingAt = Date.now();
  // 警報評価
  evaluateAlerts(fix);
}

/** 現在の fix に対して警報を評価し、発火・表示・読み上げを行う。 */
function evaluateAlerts(fix) {
  const { events, nearest } = state.alertEngine.evaluate(fix, state.spots);
  for (const ev of events) handleAlertEvent(ev);
  updateNextSpot(nearest);
  // 200m以内で画面全体を警告色に
  setDanger(!!nearest && nearest.distance <= 200);
}

/** 警報1件を処理（読み上げ＋バナー＋ログ）。 */
function handleAlertEvent(ev) {
  speak(ev.message, { interrupt: true });
  showBanner(ev);
  appendAlertLog(ev);
}

/** 警報バナーを表示する（段階で色を変える）。 */
function showBanner(ev) {
  el.alertBanner.textContent = ev.message;
  el.alertBanner.className = 'alert-banner stage-' + ev.stage;
  el.alertBanner.hidden = false;
  if (state.bannerTimer) clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => {
    el.alertBanner.hidden = true;
  }, ev.stage === 200 ? 5000 : 4000);
}

/** 「次の地点まで」HUDを更新する。 */
function updateNextSpot(nearest) {
  if (!nearest) {
    el.nextSpot.hidden = true;
    return;
  }
  const label = TYPE_LABELS[nearest.spot.type] || '地点';
  el.nextSpot.textContent = `次: ${label} ${formatDistance(nearest.distance)}`;
  el.nextSpot.hidden = false;
}

/** 画面全体の警告色を切替。 */
function setDanger(on) {
  el.screenDrive.classList.toggle('danger', on);
}

/** GPX再生時などに、発火した警報をログ表示へ追記する。 */
function appendAlertLog(ev) {
  if (!state.replayMode) return;
  const line = document.createElement('div');
  const t = new Date(ev.spot ? Date.now() : Date.now());
  line.textContent = `${ev.stage}m ・ ${TYPE_LABELS[ev.spot.type] || ''} ・ ${Math.round(ev.distance)}m地点で発火`;
  el.alertLog.appendChild(line);
  el.alertLog.scrollTop = el.alertLog.scrollHeight;
}

/** 測位・ログ記録を開始する。 */
function startTracking() {
  if (state.tracker.isRunning || state.replayMode) return;
  unlockSpeech(); // iOSの音声制限解除（ユーザー操作の中で呼ぶ）
  el.status.textContent = '測位を開始しています…';
  state.firstFix = true;
  state.lastMovingAt = Date.now();
  state.alertEngine.reset();
  loadSpots(); // 最新の地点を読み込み
  state.recorder.start(); // 行動ログの記録を開始（測位中は自動記録）
  state.tracker.start(onFix, (err) => renderError(err));
  el.startBtn.textContent = '測位停止';
  el.startBtn.classList.add('active');
  startAutoStopWatch();
  requestWakeLock(); // 画面消灯防止
}

/**
 * 測位・ログ記録を停止する。
 * @param {string} [message] 状態表示に出すメッセージ
 */
function stopTracking(message) {
  const hadFix = !!state.lastFix;
  state.tracker.stop();
  state.recorder.stop(); // 行動ログを確定保存
  stopAutoStopWatch();
  setDanger(false);
  el.nextSpot.hidden = true;
  el.startBtn.textContent = '測位開始';
  el.startBtn.classList.remove('active');
  el.status.textContent = message || '停止中（ログを保存しました）';
  releaseWakeLock();
  // 停止時に駐車位置の保存を提案
  if (hadFix) el.parkPrompt.hidden = false;
}

/** 測位を開始/停止するトグル（ボタン用）。 */
function toggleTracking() {
  if (state.tracker.isRunning) stopTracking();
  else startTracking();
}

/** 停車自動停止の監視を開始する（15秒ごとに経過をチェック）。 */
function startAutoStopWatch() {
  stopAutoStopWatch();
  state.autoStopTimer = setInterval(checkAutoStop, 15000);
}

/** 停車自動停止の監視を止める。 */
function stopAutoStopWatch() {
  if (state.autoStopTimer) {
    clearInterval(state.autoStopTimer);
    state.autoStopTimer = null;
  }
}

/** 停車が設定時間つづいたら自動停止する。 */
function checkAutoStop() {
  if (!state.tracker.isRunning) return;
  const min = getSetting('autoStopMinutes');
  if (!min || min <= 0) return;
  const idleMs = Date.now() - state.lastMovingAt;
  if (idleMs >= min * 60000) {
    stopTracking(`${min}分間停車したため自動停止しました（ログ保存済み）`);
  }
}

// ===== 画面消灯防止(Wake Lock) =====

/** 画面消灯を防ぐ。走行中/再生中に画面が消えないようにする。 */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (e) {
    // 低電力モード等で失敗することがある。致命的ではない。
    console.warn('Wake Lock 取得失敗:', e && e.message);
  }
}

/** Wake Lock を解放する。 */
async function releaseWakeLock() {
  try {
    if (state.wakeLock) await state.wakeLock.release();
  } catch (e) { /* noop */ }
  state.wakeLock = null;
}

/** 画面が再表示された時、測位/再生中なら Wake Lock を取り直す。 */
function handleVisibility() {
  if (document.visibilityState === 'visible' && (state.tracker.isRunning || state.replayMode)) {
    requestWakeLock();
  }
}

// ===== 地点(spots) =====

/** DBから地点を読み込み、マーカーを描画する。 */
async function loadSpots() {
  try {
    state.spots = await getAllSpots();
  } catch (e) {
    state.spots = [];
  }
  renderSpotMarkers();
}

/** 地点の色（種別ごと）。 */
function spotColor(type) {
  return { fixed: '#f85149', n_system: '#a371f7', mobile: '#d29922', checkpoint: '#db6d28', user: '#2f81f7' }[type] || '#2f81f7';
}

/** 地点マーカーを描き直す。 */
function renderSpotMarkers() {
  if (!state.spotLayer) return;
  state.spotLayer.clearLayers();
  for (const s of state.spots) {
    const m = L.circleMarker([s.lat, s.lng], {
      radius: 7, color: '#fff', weight: 2, fillColor: spotColor(s.type), fillOpacity: 1,
    });
    const limit = s.speedLimit ? ` / 制限${s.speedLimit}km` : '';
    m.bindPopup(
      `<b>${TYPE_LABELS[s.type] || '地点'}</b>${limit}<br>${s.label || ''}<br>` +
      `<small>出典: ${s.source}</small><br>` +
      `<button data-del-spot="${s.id}">この地点を削除</button>`
    );
    m.on('popupopen', (ev) => {
      const btn = ev.popup.getElement().querySelector('[data-del-spot]');
      if (btn) btn.addEventListener('click', async () => {
        const { deleteSpot } = await import('./db.js');
        await deleteSpot(s.id);
        await loadSpots();
        state.map.closePopup();
      });
    });
    m.addTo(state.spotLayer);
  }
}

/** 地点登録フォームを開く。 */
function openSpotForm(lat, lng) {
  state.spotFormLatLng = { lat, lng };
  el.spotName.value = '';
  el.spotLimit.value = '';
  el.spotTypeBtns.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
  el.spotTypeBtns.querySelector('[data-type="fixed"]').classList.add('selected');
  el.spotLatlng.textContent = `緯度 ${lat.toFixed(5)}, 経度 ${lng.toFixed(5)}`;
  el.spotModal.hidden = false;
}

/** 地点登録フォームを閉じる。 */
function closeSpotForm() {
  el.spotModal.hidden = true;
  state.spotFormLatLng = null;
}

/** フォーム内容から地点を保存する。 */
async function saveSpotFromForm() {
  if (!state.spotFormLatLng) return;
  const typeBtn = el.spotTypeBtns.querySelector('button.selected');
  const type = typeBtn ? typeBtn.dataset.type : 'user';
  const spot = makeSpot({
    lat: state.spotFormLatLng.lat,
    lng: state.spotFormLatLng.lng,
    type,
    label: el.spotName.value.trim() || TYPE_LABELS[type],
    speedLimit: el.spotLimit.value ? Number(el.spotLimit.value) : null,
    source: 'self',
    confidence: 'high',
  });
  const res = await addSpotWithDedup(spot);
  closeSpotForm();
  await loadSpots();
  const msg = res.action === 'added' ? '地点を登録しました' : res.action === 'merged' ? '既存地点を更新しました' : '近くに同種の地点が既にあります';
  flashStatus(msg);
}

// ===== 取り込み(import: OSM / CSV / GeoJSON) =====

/** 取り込んだ地点を重複判定して保存し、内訳を返す。 */
async function saveImportedSpots(spots) {
  let added = 0, merged = 0, kept = 0;
  for (const s of spots) {
    const r = await addSpotWithDedup(s);
    if (r.action === 'added') added++;
    else if (r.action === 'merged') merged++;
    else kept++;
  }
  await loadSpots();
  await refreshSpotInfo();
  return { added, merged, kept };
}

/** アダプタA: OSM(Overpass)から現在地/地図中心周辺を取得。 */
async function runOverpass() {
  const out = document.getElementById('import-result');
  const center = state.lastFix
    ? { lat: state.lastFix.lat, lng: state.lastFix.lng }
    : state.map.getCenter();
  const { overpassCacheStatus, fetchOverpass } = await import('./import.js');
  const cache = overpassCacheStatus(center.lat, center.lng);
  if (cache.blocked) {
    out.textContent = `このエリアは24時間以内に取得済みです（あと約${cache.remainingMin}分）。手動登録やCSVもご利用ください。`;
    return;
  }
  out.textContent = 'OSMから取得中…（数秒かかることがあります）';
  try {
    const { spots } = await fetchOverpass(center.lat, center.lng);
    if (spots.length === 0) {
      out.textContent = 'このエリアのOSMデータは未整備です。手動登録またはCSVインポートを使ってください。';
      return;
    }
    const r = await saveImportedSpots(spots);
    let msg = `OSMから${spots.length}件取得（新規${r.added}/更新${r.merged}/既存${r.kept}）。出典: OpenStreetMap contributors (ODbL)`;
    if (spots.length < 3) msg += ' ※このエリアはOSM登録が少ないようです。手動登録も併用してください。';
    out.textContent = msg;
  } catch (e) {
    out.textContent = '取得に失敗しました: ' + e.message;
  }
}

/** 取り込み結果(spots/errors)を保存して結果表示する。 */
async function applyImportResult(res, out) {
  if (res.spots.length === 0) {
    out.textContent = res.errors.length
      ? '取り込めた地点がありません。' + res.errors.slice(0, 3).map((e) => `行${e.line}:${e.reason}`).join(' / ')
      : '取り込める地点がありませんでした。';
    return;
  }
  const r = await saveImportedSpots(res.spots);
  let msg = `取り込み: ${res.spots.length}件（新規${r.added}/更新${r.merged}/既存${r.kept}）`;
  if (res.errors.length) msg += ` ・ 不正 ${res.errors.length}行（例 行${res.errors[0].line}: ${res.errors[0].reason}）`;
  out.textContent = msg;
}

/** アダプタB: 貼り付けテキストを取り込む（CSV/GeoJSON自動判定）。 */
async function doImportText(text) {
  const out = document.getElementById('import-result');
  if (!text.trim()) { out.textContent = 'テキストが空です'; return; }
  const { importCSV, importGeoJSON } = await import('./import.js');
  const t = text.trim();
  const res = (t.startsWith('{') || t.startsWith('[')) ? importGeoJSON(text) : importCSV(text);
  await applyImportResult(res, out);
}

/** アダプタB: 選択ファイルを取り込む（拡張子で判定）。 */
async function onImportFile(file) {
  if (!file) return;
  const out = document.getElementById('import-result');
  const text = await file.text();
  const { importCSV, importGeoJSON } = await import('./import.js');
  const res = /\.(geojson|json)$/i.test(file.name) ? importGeoJSON(text) : importCSV(text);
  await applyImportResult(res, out);
}

// ===== 駐車位置(parking) =====

/** 現在地（直近fix）を駐車位置として保存する。 */
async function saveCurrentParking() {
  const fix = state.lastFix;
  if (!fix) {
    flashStatus('現在地が未取得です（先に測位してください）');
    return;
  }
  await addParking({ lat: fix.lat, lng: fix.lng, savedAt: Date.now(), note: '' });
  el.parkPrompt.hidden = true;
  await renderParking();
  flashStatus('駐車位置を保存しました🅿️');
}

/** 最新の駐車位置をマーカー表示する。 */
async function renderParking() {
  const list = await getAllParking();
  if (state.parkingMarker) {
    state.map.removeLayer(state.parkingMarker);
    state.parkingMarker = null;
  }
  if (list.length === 0) return;
  const p = list[0];
  const icon = L.divIcon({ className: 'park-icon', html: '<div class="park-pin">🅿️</div>', iconSize: [30, 30], iconAnchor: [15, 30] });
  state.parkingMarker = L.marker([p.lat, p.lng], { icon })
    .addTo(state.map)
    .bindPopup(
      `駐車位置<br><small>${new Date(p.savedAt).toLocaleString('ja-JP')}</small><br>` +
      `<button id="pk-maps">地図アプリで開く</button>`
    );
  state.parkingMarker.on('popupopen', () => {
    const b = document.getElementById('pk-maps');
    if (b) b.addEventListener('click', () => openParkingMaps(p.lat, p.lng));
  });
}

/** 駐車位置を地図アプリ（徒歩ルート）で開く。 */
function openParkingMaps(lat, lng) {
  // iOSは Apple Maps、その他は Google Maps を開く
  const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const url = isiOS
    ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
  window.open(url, '_blank');
}

// ===== ミュート =====

/** 音声ミュートを切り替える（視覚警報は継続）。 */
function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  el.muteBtn.textContent = next ? '🔇' : '🔊';
  el.muteBtn.classList.toggle('muted', next);
}

// ===== GPX再生 =====

/** サンプル走行を再生する。 */
function playSample() {
  const track = buildSampleTrack();
  // サンプル地点を（保存せず）評価対象に加える
  startReplay(track, sampleSpots());
}

/** GPXファイルを読み込んで再生する。 */
async function onGpxFile(file) {
  if (!file) return;
  const text = await file.text();
  const track = parseGPX(text);
  if (track.length === 0) {
    flashStatus('GPXから座標を読み取れませんでした');
    return;
  }
  startReplay(track, null); // ユーザーの実地点で評価
}

/**
 * 再生を開始する。
 * @param {Array} track
 * @param {Array|null} extraSpots サンプル地点など（nullなら実地点のみ）
 */
async function startReplay(track, extraSpots) {
  if (state.tracker.isRunning) stopTracking();
  if (state.replay) state.replay.stop();
  unlockSpeech();
  await loadSpots();
  if (extraSpots) {
    state.spots = [...state.spots, ...extraSpots];
    renderSpotMarkers();
  }
  state.alertEngine.reset();
  state.replayMode = true;
  state.firstFix = true;
  el.alertLog.innerHTML = '';
  el.alertLog.hidden = false;
  const speed = Number(getSetting('replaySpeed') || 5);
  el.replayChipLabel.textContent = `▶ 再生 ${speed}x`;
  el.replayChip.hidden = false;
  switchScreen('drive');

  state.replay = new MockTracker(track, speed);
  state.replay.start(onFix, () => stopReplay('再生が終了しました'));
  requestWakeLock();
}

/** 再生を停止する。 */
async function stopReplay(message) {
  if (state.replay) { state.replay.stop(); state.replay = null; }
  state.replayMode = false;
  el.replayChip.hidden = true;
  el.alertLog.hidden = true;
  el.alertBanner.hidden = true;
  setDanger(false);
  el.nextSpot.hidden = true;
  if (message) flashStatus(message);
  releaseWakeLock();
  await loadSpots(); // サンプル地点を消して実地点に戻す
}

/** 状態表示に一時的なメッセージを出す。 */
function flashStatus(msg) {
  el.status.textContent = msg;
  el.status.classList.remove('error');
}

/**
 * 画面（走行/履歴/設定）を切り替える。
 * @param {'drive'|'history'|'settings'} name
 */
function switchScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.hidden = s.id !== `screen-${name}`;
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.screen === name);
  });
  // 画面ごとの再描画/サイズ再計算
  if (name === 'drive') {
    sizeMap();
    if (state.map) setTimeout(() => state.map.invalidateSize(), 0);
  } else if (name === 'history') {
    refreshHistoryList();
  } else if (name === 'settings') {
    refreshStorageInfo();
    refreshSpotInfo();
  }
}

/** 起動時に、設定に応じて古いログを自動削除する。 */
async function runAutoDelete() {
  const days = getSetting('autoDeleteDays');
  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;
    try {
      await deleteTripsBefore(cutoff);
    } catch (e) {
      console.error('自動削除に失敗:', e);
    }
  }
}

/** 設定画面の追加コントロール（地点・再生・駐車）を配線する。 */
function wireSettingsExtras() {
  const addSample = document.getElementById('add-sample-spots');
  const clearBtn = document.getElementById('clear-spots');
  const replaySpeedSel = document.getElementById('replay-speed');
  const playSampleBtn = document.getElementById('play-sample');
  const gpxInput = document.getElementById('gpx-file');
  const openParkBtn = document.getElementById('open-parking-maps');
  const delParkBtn = document.getElementById('delete-parking');

  replaySpeedSel.value = String(getSetting('replaySpeed'));
  replaySpeedSel.addEventListener('change', () => setSetting('replaySpeed', Number(replaySpeedSel.value)));

  addSample.addEventListener('click', async () => {
    await putSpots(sampleSpots());
    await loadSpots();
    await refreshSpotInfo();
    flashStatus('サンプル地点を追加しました');
  });
  clearBtn.addEventListener('click', async () => {
    if (confirm('登録した地点をすべて削除しますか？')) {
      await clearSpots();
      await loadSpots();
      await refreshSpotInfo();
    }
  });
  playSampleBtn.addEventListener('click', playSample);
  gpxInput.addEventListener('change', (e) => onGpxFile(e.target.files[0]));

  // 取り込み（OSM / CSV / GeoJSON）
  document.getElementById('import-osm').addEventListener('click', runOverpass);
  document.getElementById('import-file').addEventListener('change', (e) => onImportFile(e.target.files[0]));
  document.getElementById('import-text-btn').addEventListener('click', () =>
    doImportText(document.getElementById('import-text').value)
  );

  openParkBtn.addEventListener('click', async () => {
    const list = await getAllParking();
    if (list.length === 0) { flashStatus('駐車位置は未保存です'); return; }
    openParkingMaps(list[0].lat, list[0].lng);
  });
  delParkBtn.addEventListener('click', async () => {
    const list = await getAllParking();
    if (list.length === 0) return;
    await deleteParking(list[0].id);
    await renderParking();
    await refreshSpotInfo();
    flashStatus('駐車位置を削除しました');
  });
}

/** 設定画面の地点数・駐車位置の情報表示を更新する。 */
async function refreshSpotInfo() {
  const countEl = document.getElementById('spot-count');
  if (countEl) countEl.textContent = `登録地点: ${state.spots.length} 件`;
  const parkEl = document.getElementById('parking-info');
  if (parkEl) {
    const list = await getAllParking();
    parkEl.textContent = list.length
      ? `駐車位置: ${new Date(list[0].savedAt).toLocaleString('ja-JP')}`
      : '駐車位置: 未保存';
  }
}

/** 起動処理。 */
function main() {
  initMap();

  // 地図の既定向きを設定から反映
  state.headingUp = getSetting('headingUp');
  el.rotateBtn.textContent = state.headingUp ? '⬆ 進行方向' : '🧭 北アップ';

  el.startBtn.addEventListener('click', toggleTracking);
  el.rotateBtn.addEventListener('click', toggleRotate);

  // 走行画面のボタン類
  el.muteBtn.addEventListener('click', toggleMute);
  el.muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  el.parkBtn.addEventListener('click', saveCurrentParking);
  el.replayStop.addEventListener('click', () => stopReplay('再生を停止しました'));

  // 駐車位置の保存提案バナー
  document.getElementById('park-save-yes').addEventListener('click', saveCurrentParking);
  document.getElementById('park-save-no').addEventListener('click', () => { el.parkPrompt.hidden = true; });

  // 地点登録モーダル
  el.spotTypeBtns.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    el.spotTypeBtns.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  el.spotSave.addEventListener('click', saveSpotFromForm);
  el.spotCancel.addEventListener('click', closeSpotForm);

  // 履歴・設定画面の初期化
  initHistory();
  initSettings();
  wireSettingsExtras();

  // タブ切替
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchScreen(tab.dataset.screen);
  });

  // 画面復帰時に Wake Lock を取り直す
  document.addEventListener('visibilitychange', handleVisibility);

  // 履歴リプレイからの地点登録要求（history.js が発火）
  document.addEventListener('orbis:register-spot', (e) => {
    openSpotForm(e.detail.lat, e.detail.lng);
  });

  // 起動時に地点・駐車位置を表示
  loadSpots();
  renderParking();

  runAutoDelete();

  el.status.textContent = 'HTTPS または localhost で「測位開始」を押してください。';

  // 起動時の自動測位開始（ショートカット自動化から開いた時などに有効）
  if (getSetting('autoStartOnLaunch')) {
    // 位置情報の許可済みならそのまま開始。未許可なら許可ダイアログが出る。
    startTracking();
  }
}

main();
