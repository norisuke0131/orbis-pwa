// app.js
// アプリのエントリポイント（Phase 0）。
// この段階では「地図表示」「現在地取得」「現在速度の表示」までを行う。
// Phase 1 以降でデータ層・警報ロジック・GPX再生などをここに接続していく。

import { GeoTracker } from './geo.js';
import { TripRecorder } from './recorder.js';
import { initHistory, refreshHistoryList } from './history.js';
import { initSettings, refreshStorageInfo } from './settings.js';
import { getSetting, setSetting } from './config.js';
import { deleteTripsBefore } from './db.js';

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
  renderSelf(fix);
  renderHud(fix);
  updateMapRotation(fix.heading);
  state.recorder.onFix(fix); // 走行点を保存（約1秒間隔）
  // 自動停止用: 一定速度以上で動いた時刻を記録
  if (fix.speedKmh >= MOVING_THRESHOLD_KMH) state.lastMovingAt = Date.now();
}

/** 測位・ログ記録を開始する。 */
function startTracking() {
  if (state.tracker.isRunning) return;
  el.status.textContent = '測位を開始しています…';
  state.firstFix = true;
  state.lastMovingAt = Date.now();
  state.recorder.start(); // 行動ログの記録を開始（測位中は自動記録）
  state.tracker.start(onFix, (err) => renderError(err));
  el.startBtn.textContent = '測位停止';
  el.startBtn.classList.add('active');
  startAutoStopWatch();
}

/**
 * 測位・ログ記録を停止する。
 * @param {string} [message] 状態表示に出すメッセージ
 */
function stopTracking(message) {
  state.tracker.stop();
  state.recorder.stop(); // 行動ログを確定保存
  stopAutoStopWatch();
  el.startBtn.textContent = '測位開始';
  el.startBtn.classList.remove('active');
  el.status.textContent = message || '停止中（ログを保存しました）';
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

/** 起動処理。 */
function main() {
  initMap();

  // 地図の既定向きを設定から反映
  state.headingUp = getSetting('headingUp');
  el.rotateBtn.textContent = state.headingUp ? '⬆ 進行方向' : '🧭 北アップ';

  el.startBtn.addEventListener('click', toggleTracking);
  el.rotateBtn.addEventListener('click', toggleRotate);

  // 履歴・設定画面の初期化
  initHistory();
  initSettings();

  // タブ切替
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchScreen(tab.dataset.screen);
  });

  runAutoDelete();

  el.status.textContent = 'HTTPS または localhost で「測位開始」を押してください。';

  // 起動時の自動測位開始（ショートカット自動化から開いた時などに有効）
  if (getSetting('autoStartOnLaunch')) {
    // 位置情報の許可済みならそのまま開始。未許可なら許可ダイアログが出る。
    startTracking();
  }
}

main();
