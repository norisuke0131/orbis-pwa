// history.js
// 履歴・考察画面。トリップ一覧と、選択したトリップの分析（リプレイ/サマリー/
// 速度超過/分布）を表示する。地図は詳細内に1つだけ持ち、各サブタブで使い回す。

import { getAllTrips, getPoints, deleteTrip } from './db.js';
import { getSetting } from './config.js';
import {
  computeSummary, computeOverSpeed, computeSpeedHistogram, computeHourly,
  speedColor, formatDuration, formatDistance,
} from './analysis.js';
import { localTimeStr } from './util.js';

// DOM 参照（initHistory で設定）
let elList, elDetail, elTitle, elMapDiv, elView, elSubtabs, elBack;

// 詳細表示の状態
const H = {
  map: null,          // 詳細用 Leaflet 地図
  routeLayers: [],    // 速度色分けの線分
  replayMarker: null, // リプレイの現在位置マーカー
  overMarkers: [],    // 速度超過マーカー
  points: [],         // 現在表示中のトリップの走行点
  trip: null,
  view: 'replay',
  playTimer: null,
};

/** 初期化: 画面内の要素を掴み、イベントを配線する。 */
export function initHistory() {
  elList = document.getElementById('history-list');
  elDetail = document.getElementById('history-detail');
  elTitle = document.getElementById('hist-title');
  elMapDiv = document.getElementById('hist-map');
  elView = document.getElementById('hist-view');
  elSubtabs = document.getElementById('hist-subtabs');
  elBack = document.getElementById('hist-back');

  elBack.addEventListener('click', showListView);
  elSubtabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.subtab');
    if (!btn) return;
    setView(btn.dataset.view);
  });
  document.getElementById('hist-refresh').addEventListener('click', refreshHistoryList);
}

/** トリップ一覧を（新しい順・日付でまとめて）描画する。 */
export async function refreshHistoryList() {
  stopPlay();
  elDetail.hidden = true;
  elList.hidden = false;
  const trips = await getAllTrips();

  if (trips.length === 0) {
    elList.innerHTML =
      '<p class="empty">まだ記録がありません。走行画面で「測位開始」を押すと、その走行が自動で記録されます。</p>';
    return;
  }

  // 日付ごとにグループ化
  const byDate = new Map();
  for (const t of trips) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  let html = '';
  for (const [date, list] of byDate) {
    html += `<div class="date-group"><div class="date-head">${date}</div>`;
    for (const t of list) {
      const time = `${localTimeStr(t.startedAt)}〜${t.endedAt ? localTimeStr(t.endedAt) : ''}`;
      html += `
        <div class="trip-card" data-id="${t.id}">
          <div class="trip-main">
            <div class="trip-time">${time}</div>
            <div class="trip-stats">
              ${formatDistance(t.distanceM || 0)} ・ 最高 ${Math.round(t.maxSpeedKmh || 0)}km/h
            </div>
          </div>
          <button class="trip-del" data-del="${t.id}" title="削除">🗑</button>
        </div>`;
    }
    html += '</div>';
  }
  elList.innerHTML = html;

  // カードのクリック（開く / 削除）
  elList.querySelectorAll('.trip-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.trip-del')) return; // 削除ボタンは別処理
      openTrip(Number(card.dataset.id));
    });
  });
  elList.querySelectorAll('.trip-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('このトリップの記録を削除しますか？')) {
        await deleteTrip(Number(btn.dataset.del));
        refreshHistoryList();
      }
    });
  });
}

/** 一覧に戻る。 */
function showListView() {
  stopPlay();
  elDetail.hidden = true;
  elList.hidden = false;
}

/** トリップ詳細を開く。 */
async function openTrip(tripId) {
  const trips = await getAllTrips();
  const trip = trips.find((t) => t.id === tripId);
  if (!trip) return;
  H.trip = trip;
  H.points = await getPoints(tripId);

  elList.hidden = true;
  elDetail.hidden = false;
  elTitle.textContent = `${trip.date} ${localTimeStr(trip.startedAt)}〜${trip.endedAt ? localTimeStr(trip.endedAt) : ''}`;

  ensureMap();
  drawRoute();
  H.view = 'replay';
  updateSubtabButtons();
  setView('replay');
}

/** 詳細用の地図を必要時に生成する。 */
function ensureMap() {
  if (H.map) {
    H.map.invalidateSize();
    return;
  }
  H.map = L.map(elMapDiv, { zoomControl: true, attributionControl: false }).setView([37.6, 139.0], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(H.map);
  setTimeout(() => H.map.invalidateSize(), 0);
}

/** ルートを速度で色分けして描画し、範囲にフィットする。 */
function drawRoute() {
  // 既存レイヤ除去
  H.routeLayers.forEach((l) => H.map.removeLayer(l));
  H.routeLayers = [];
  H.overMarkers.forEach((m) => H.map.removeLayer(m));
  H.overMarkers = [];
  if (H.replayMarker) { H.map.removeLayer(H.replayMarker); H.replayMarker = null; }

  const pts = H.points;
  if (pts.length === 0) return;

  // 速度で色分けした線分を並べる
  for (let i = 1; i < pts.length; i++) {
    const seg = L.polyline(
      [[pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng]],
      { color: speedColor(pts[i].speedKmh), weight: 5, opacity: 0.9 }
    ).addTo(H.map);
    H.routeLayers.push(seg);
  }
  const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
  H.map.fitBounds(bounds, { padding: [30, 30] });

  // リプレイ用マーカー（先頭に置く）
  H.replayMarker = L.circleMarker([pts[0].lat, pts[0].lng], {
    radius: 8, color: '#fff', weight: 2, fillColor: '#58a6ff', fillOpacity: 1,
  }).addTo(H.map);
}

/** サブタブのアクティブ表示を更新。 */
function updateSubtabButtons() {
  elSubtabs.querySelectorAll('.subtab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === H.view);
  });
}

/** サブタブを切り替えて下部ビューを描く。 */
function setView(view) {
  H.view = view;
  updateSubtabButtons();
  stopPlay();
  // 速度超過マーカーは over ビュー以外では消す
  if (view !== 'over') {
    H.overMarkers.forEach((m) => H.map.removeLayer(m));
    H.overMarkers = [];
  }
  if (view === 'replay') renderReplay();
  else if (view === 'summary') renderSummary();
  else if (view === 'over') renderOver();
  else if (view === 'dist') renderDist();
}

/** リプレイ: スライダーで現在地マーカーを動かす＋再生。 */
function renderReplay() {
  const pts = H.points;
  elView.innerHTML = `
    <div class="replay-ctrl">
      <button id="rp-play" class="rp-btn">▶ 再生</button>
      <input id="rp-slider" type="range" min="0" max="${Math.max(0, pts.length - 1)}" value="0" />
    </div>
    <div id="rp-readout" class="rp-readout">—</div>
    <div class="legend">
      <span>遅い</span><div class="legend-bar"></div><span>速い</span>
    </div>`;
  const slider = document.getElementById('rp-slider');
  const readout = document.getElementById('rp-readout');
  const playBtn = document.getElementById('rp-play');

  const showAt = (idx) => {
    const p = pts[idx];
    if (!p || !H.replayMarker) return;
    H.replayMarker.setLatLng([p.lat, p.lng]);
    readout.textContent = `${localTimeStr(p.t)} ・ ${Math.round(p.speedKmh)} km/h`;
  };
  slider.addEventListener('input', () => showAt(Number(slider.value)));
  showAt(0);

  playBtn.addEventListener('click', () => {
    if (H.playTimer) { stopPlay(); playBtn.textContent = '▶ 再生'; return; }
    playBtn.textContent = '⏸ 停止';
    H.playTimer = setInterval(() => {
      let v = Number(slider.value);
      if (v >= pts.length - 1) { stopPlay(); playBtn.textContent = '▶ 再生'; return; }
      v += 1;
      slider.value = String(v);
      showAt(v);
    }, 150); // 約6.7倍速（1点=150ms）
  });
}

function stopPlay() {
  if (H.playTimer) { clearInterval(H.playTimer); H.playTimer = null; }
}

/** サマリー数値。 */
function renderSummary() {
  const s = computeSummary(H.points);
  elView.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="stat-v">${formatDistance(s.distanceM)}</div><div class="stat-l">総距離</div></div>
      <div class="stat"><div class="stat-v">${formatDuration(s.durationMs)}</div><div class="stat-l">所要時間</div></div>
      <div class="stat"><div class="stat-v">${s.avgSpeedKmh}<small>km/h</small></div><div class="stat-l">平均速度</div></div>
      <div class="stat"><div class="stat-v">${s.maxSpeedKmh}<small>km/h</small></div><div class="stat-l">最高速度</div></div>
      <div class="stat"><div class="stat-v">${s.stopCount}<small>回</small></div><div class="stat-l">停車回数</div></div>
      <div class="stat"><div class="stat-v">${formatDuration(s.stopTimeMs)}</div><div class="stat-l">停車時間</div></div>
    </div>`;
}

/** 速度超過: しきい値超えの回数・時間・地点（地図にマーカー）。 */
function renderOver() {
  const thr = getSetting('overSpeedThresholdKmh');
  const o = computeOverSpeed(H.points, thr);

  // 地図に赤マーカー
  H.overMarkers.forEach((m) => H.map.removeLayer(m));
  H.overMarkers = o.places.map((p) =>
    L.circleMarker([p.lat, p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#f85149', fillOpacity: 1 })
      .addTo(H.map)
      .bindPopup(`${Math.round(p.maxSpeedKmh)}km/h ・ ${formatDuration(p.durationMs)}`)
  );

  let list = o.places.map((p) =>
    `<li>${localTimeStr(p.t)} ・ 最高 <b>${Math.round(p.maxSpeedKmh)}</b>km/h ・ ${formatDuration(p.durationMs)}</li>`
  ).join('');
  if (!list) list = '<li class="empty">しきい値超過はありませんでした。</li>';

  elView.innerHTML = `
    <div class="over-head">しきい値 <b>${thr}</b> km/h 超過：
      <b>${o.count}</b> 回 / 合計 ${formatDuration(o.timeMs)}
      <span class="hint">（しきい値は設定画面で変更）</span>
    </div>
    <ul class="over-list">${list}</ul>`;
}

/** 分布: 速度ヒストグラム＋時間帯別平均。 */
function renderDist() {
  const hist = computeSpeedHistogram(H.points, 10);
  const maxT = Math.max(1, ...hist.map((b) => b.timeMs));
  const bars = hist.map((b) => {
    const pct = (b.timeMs / maxT) * 100;
    return `
      <div class="hbar-row">
        <div class="hbar-label">${b.from}-${b.to}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${pct}%;background:${speedColor((b.from + b.to) / 2)}"></div></div>
        <div class="hbar-val">${formatDuration(b.timeMs)}</div>
      </div>`;
  }).join('');

  const hourly = computeHourly(H.points).filter((h) => h.timeMs > 0);
  const rows = hourly.map((h) =>
    `<tr><td>${h.hour}時</td><td>${h.avgSpeedKmh} km/h</td><td>${formatDistance(h.distanceM)}</td></tr>`
  ).join('');

  elView.innerHTML = `
    <div class="dist-title">速度帯ごとの時間</div>
    <div class="hbars">${bars || '<p class="empty">データ不足</p>'}</div>
    <div class="dist-title">時間帯別の平均速度</div>
    <table class="hourly">
      <thead><tr><th>時間帯</th><th>平均速度</th><th>距離</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="empty">データ不足</td></tr>'}</tbody>
    </table>`;
}
