// analysis.js
// 走行点の配列から各種「考察（分析）」を計算する純粋関数群。
// UI から独立させ、単体で検証できるようにしている。
//
// 入力の points は時刻昇順の配列:
//   { lat, lng, speedKmh, heading, accuracy, t }

import { haversine } from './util.js';

/** 停車とみなす速度（km/h）。これ未満を停車扱い。 */
const STOP_SPEED_KMH = 3;
/** 停車として数える最小継続時間（ms）。信号待ち程度を1停車とする。 */
const STOP_MIN_MS = 15000;

/**
 * 総合サマリーを計算する。
 * @param {Array} points
 * @returns {{durationMs:number, distanceM:number, avgSpeedKmh:number, maxSpeedKmh:number, stopCount:number, stopTimeMs:number}}
 */
export function computeSummary(points) {
  if (!points || points.length === 0) {
    return { durationMs: 0, distanceM: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, stopCount: 0, stopTimeMs: 0 };
  }
  const durationMs = points[points.length - 1].t - points[0].t;

  let distanceM = 0;
  let maxSpeedKmh = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].speedKmh > maxSpeedKmh) maxSpeedKmh = points[i].speedKmh;
    if (i > 0) {
      const d = haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
      // GPSジッター除去（精度以下かつ15m未満の微小移動は無視）
      if (d > Math.min(points[i].accuracy || 0, 15)) distanceM += d;
    }
  }

  // 平均速度（総距離 ÷ 総時間）
  const hours = durationMs / 3600000;
  const avgSpeedKmh = hours > 0 ? distanceM / 1000 / hours : 0;

  // 停車の検出: 低速が STOP_MIN_MS 以上続く区間を1停車と数える
  let stopCount = 0;
  let stopTimeMs = 0;
  let runStart = null;
  for (let i = 0; i < points.length; i++) {
    const slow = points[i].speedKmh < STOP_SPEED_KMH;
    if (slow && runStart === null) runStart = points[i].t;
    if ((!slow || i === points.length - 1) && runStart !== null) {
      const runEnd = points[i].t;
      const dur = runEnd - runStart;
      if (dur >= STOP_MIN_MS) {
        stopCount += 1;
        stopTimeMs += dur;
      }
      runStart = null;
    }
  }

  return {
    durationMs,
    distanceM: Math.round(distanceM),
    avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
    maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10,
    stopCount,
    stopTimeMs,
  };
}

/**
 * 速度超過（しきい値超え）を検出する。
 * 連続して超過している区間を1回と数え、地点・時間を返す。
 * @param {Array} points
 * @param {number} thresholdKmh しきい値（km/h）
 * @returns {{count:number, timeMs:number, places:Array<{lat:number,lng:number,maxSpeedKmh:number,t:number,durationMs:number}>}}
 */
export function computeOverSpeed(points, thresholdKmh) {
  const places = [];
  let timeMs = 0;
  if (!points || points.length === 0) return { count: 0, timeMs: 0, places };

  let runStartIdx = null;
  let runMax = 0;

  const closeRun = (endIdx) => {
    if (runStartIdx === null) return;
    const start = points[runStartIdx];
    const end = points[endIdx];
    const dur = end.t - start.t;
    timeMs += dur;
    // 区間中の最高速度地点を代表点にする
    let peak = start, peakSpeed = 0;
    for (let k = runStartIdx; k <= endIdx; k++) {
      if (points[k].speedKmh > peakSpeed) { peakSpeed = points[k].speedKmh; peak = points[k]; }
    }
    places.push({
      lat: peak.lat, lng: peak.lng,
      maxSpeedKmh: Math.round(peakSpeed * 10) / 10,
      t: peak.t,
      durationMs: dur,
    });
    runStartIdx = null;
    runMax = 0;
  };

  for (let i = 0; i < points.length; i++) {
    const over = points[i].speedKmh > thresholdKmh;
    if (over) {
      if (runStartIdx === null) runStartIdx = i;
      if (points[i].speedKmh > runMax) runMax = points[i].speedKmh;
      if (i === points.length - 1) closeRun(i);
    } else if (runStartIdx !== null) {
      closeRun(i - 1 >= runStartIdx ? i - 1 : runStartIdx);
    }
  }

  return { count: places.length, timeMs, places };
}

/**
 * 速度ヒストグラム（速度帯ごとの滞在時間）を計算する。
 * 各点の速度帯に、直前の点からの経過時間(dt)を割り当てる。
 * @param {Array} points
 * @param {number} binKmh 1ビンの幅（既定10km/h）
 * @returns {Array<{from:number, to:number, timeMs:number}>}
 */
export function computeSpeedHistogram(points, binKmh = 10) {
  const bins = [];
  const ensureBin = (idx) => {
    while (bins.length <= idx) {
      const from = bins.length * binKmh;
      bins.push({ from, to: from + binKmh, timeMs: 0 });
    }
  };
  if (!points || points.length < 2) return bins;

  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0 || dt > 60000) continue; // 異常な間隔は無視
    const idx = Math.max(0, Math.floor(points[i].speedKmh / binKmh));
    ensureBin(idx);
    bins[idx].timeMs += dt;
  }
  return bins;
}

/**
 * 時間帯（0〜23時）別の平均速度・距離・時間を計算する。
 * @param {Array} points
 * @returns {Array<{hour:number, avgSpeedKmh:number, distanceM:number, timeMs:number}>}
 */
export function computeHourly(points) {
  const acc = Array.from({ length: 24 }, (_, h) => ({ hour: h, distanceM: 0, timeMs: 0 }));
  if (!points || points.length < 2) {
    return acc.map((a) => ({ ...a, avgSpeedKmh: 0 }));
  }
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0 || dt > 60000) continue;
    const hour = new Date(points[i].t).getHours();
    const d = haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    const dd = d > Math.min(points[i].accuracy || 0, 15) ? d : 0;
    acc[hour].distanceM += dd;
    acc[hour].timeMs += dt;
  }
  return acc.map((a) => {
    const hours = a.timeMs / 3600000;
    return {
      hour: a.hour,
      distanceM: Math.round(a.distanceM),
      timeMs: a.timeMs,
      avgSpeedKmh: hours > 0 ? Math.round((a.distanceM / 1000 / hours) * 10) / 10 : 0,
    };
  });
}

/**
 * 速度(km/h)を色に変換する（遅い=青 → 速い=赤）。ルート色分けに使用。
 * @param {number} kmh
 * @param {number} maxKmh 色スケールの上限（既定120）
 * @returns {string} CSS色
 */
export function speedColor(kmh, maxKmh = 120) {
  const r = Math.max(0, Math.min(1, kmh / maxKmh));
  // 青(210°) → 赤(0°) へ色相を回す HSL
  const hue = 210 - 210 * r;
  return `hsl(${hue}, 85%, 50%)`;
}

/** ms を "H時間M分" / "M分S秒" 形式にする。 */
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

/** m を "X.X km" / "Xm" 形式にする。 */
export function formatDistance(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}
