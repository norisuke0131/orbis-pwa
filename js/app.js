// app.js
// アプリのエントリポイント（Phase 0）。
// この段階では「地図表示」「現在地取得」「現在速度の表示」までを行う。
// Phase 1 以降でデータ層・警報ロジック・GPX再生などをここに接続していく。

import { GeoTracker } from './geo.js';

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
  firstFix: true, // 最初の測位で地図を寄せるためのフラグ
};

// DOM 参照
const el = {
  map: document.getElementById('map'),
  speed: document.getElementById('speed-value'),
  status: document.getElementById('status'),
  startBtn: document.getElementById('start-btn'),
  headingInfo: document.getElementById('heading-info'),
};

/** 地図を初期化する。 */
function initMap() {
  state.map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView(INITIAL_CENTER, INITIAL_ZOOM);

  // OpenStreetMap タイル。ODbL の出典表示を attribution で常時掲出（要件）。
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(state.map);
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

/** 測位を開始/停止するトグル。 */
function toggleTracking() {
  if (state.tracker.isRunning) {
    state.tracker.stop();
    el.startBtn.textContent = '測位開始';
    el.startBtn.classList.remove('active');
    el.status.textContent = '停止中';
    return;
  }
  el.status.textContent = '測位を開始しています…';
  state.firstFix = true;
  state.tracker.start(
    (fix) => {
      renderSelf(fix);
      renderHud(fix);
    },
    (err) => renderError(err)
  );
  el.startBtn.textContent = '測位停止';
  el.startBtn.classList.add('active');
}

/** 起動処理。 */
function main() {
  initMap();
  el.startBtn.addEventListener('click', toggleTracking);
  el.status.textContent = 'HTTPS または localhost で「測位開始」を押してください。';
}

main();
