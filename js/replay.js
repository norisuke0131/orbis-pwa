// replay.js
// GPXログ再生モード。watchPosition をモックし、走行軌跡を時系列で供給する。
// 実車なしで警報ロジックを検証するための最重要機能。
//
// - MockTracker: GeoTracker と同じ start/stop/isRunning インターフェース。
//   トラック点(track: [{lat,lng,t}])を速度倍率で再生し、GeoFix を供給する。
// - buildSampleTrack / sampleSpots: 三条市周辺のサンプル走行とダミー地点。
// - parseGPX: GPXファイル文字列から track を取り出す。

import { haversine, bearing, msToKmh } from './util.js';
import { makeSpot } from './spots.js';

/** 進行方向を有効とみなす速度（m/s）。geo.js と合わせる。 */
const HEADING_MIN_SPEED_MS = 2.5;

export class MockTracker {
  /**
   * @param {Array<{lat:number,lng:number,t:number}>} track
   * @param {number} speedMultiplier 1|5|20
   */
  constructor(track, speedMultiplier = 5) {
    this._track = track || [];
    this._mult = speedMultiplier;
    this._timer = null;
    this._i = 0;
    this._onUpdate = null;
    this._onEnd = null;
  }

  get isRunning() {
    return this._timer !== null;
  }

  /**
   * 再生を開始する。
   * @param {(fix:import('./geo.js').GeoFix)=>void} onUpdate
   * @param {()=>void} [onEnd] 再生終了時
   */
  start(onUpdate, onEnd) {
    this._onUpdate = onUpdate;
    this._onEnd = onEnd || (() => {});
    this._i = 0;
    if (this._track.length === 0) return;

    // トラックは約1秒間隔想定。倍率で間隔を縮める。
    const intervalMs = Math.max(20, 1000 / this._mult);
    this._timer = setInterval(() => this._step(), intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 1点進める。 */
  _step() {
    if (this._i >= this._track.length) {
      this.stop();
      this._onEnd();
      return;
    }
    const cur = this._track[this._i];
    const prev = this._i > 0 ? this._track[this._i - 1] : null;

    let speedMs = 0;
    let heading = null;
    let headingSource = 'none';
    if (prev) {
      const dt = (cur.t - prev.t) / 1000;
      const dist = haversine(prev.lat, prev.lng, cur.lat, cur.lng);
      if (dt > 0) speedMs = dist / dt;
      if (speedMs >= HEADING_MIN_SPEED_MS && dist >= 3) {
        heading = bearing(prev.lat, prev.lng, cur.lat, cur.lng);
        headingSource = 'computed';
      }
    }

    /** @type {import('./geo.js').GeoFix} */
    const fix = {
      lat: cur.lat,
      lng: cur.lng,
      accuracy: 5,
      speedMs,
      speedKmh: msToKmh(speedMs),
      heading,
      headingReliable: heading !== null,
      timestamp: cur.t,
      headingSource,
    };
    this._i += 1;
    if (this._onUpdate) this._onUpdate(fix);
  }
}

/**
 * 三条市周辺を東へ走る約6分のサンプル走行を生成する。
 * @returns {Array<{lat:number,lng:number,t:number}>}
 */
export function buildSampleTrack() {
  const track = [];
  const lat = 37.626; // 東へ直進（緯度一定）
  let lng = 138.95;
  const metersPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const t0 = Date.now();

  // 速度プロファイル（km/h）: 発進→巡航→減速→再加速…を約360秒分
  let t = 0;
  const pushFor = (kmh, seconds) => {
    for (let s = 0; s < seconds; s++) {
      const dLng = (kmh / 3.6) / metersPerDegLng; // 1秒分の東進
      lng += dLng;
      track.push({ lat, lng, t: t0 + t * 1000 });
      t++;
    }
  };
  pushFor(0, 3);
  for (let v = 10; v <= 60; v += 10) pushFor(v, 3); // 加速
  pushFor(60, 90); // 巡航
  pushFor(45, 20); // 減速
  pushFor(70, 60); // 少し飛ばす
  pushFor(50, 90); // 巡航
  pushFor(30, 15);
  pushFor(0, 5);
  return track;
}

/**
 * サンプル走行の前方に置くダミー地点。
 * 東進(進行方向90度)に対して direction=90 を付与し、前方警報が出るようにする。
 * @returns {Array} SpotRecord[]
 */
export function sampleSpots() {
  const lat = 37.626;
  const lng0 = 138.95;
  const mpd = 111320 * Math.cos((lat * Math.PI) / 180);
  const at = (km) => lng0 + (km * 1000) / mpd;
  return [
    makeSpot({ id: 'sample-fixed', lat, lng: at(1.5), type: 'fixed', direction: 90, speedLimit: 60, label: 'サンプル固定式', source: 'sample', confidence: 'low' }),
    makeSpot({ id: 'sample-mobile', lat, lng: at(3.0), type: 'mobile', direction: 90, label: 'サンプル移動式', source: 'sample', confidence: 'low' }),
    makeSpot({ id: 'sample-nsys', lat, lng: at(4.2), type: 'n_system', direction: 90, label: 'サンプルNシステム', source: 'sample', confidence: 'low' }),
  ];
}

/**
 * GPX文字列を track に変換する。time が無ければ1秒間隔を仮定。
 * @param {string} xml
 * @returns {Array<{lat:number,lng:number,t:number}>}
 */
export function parseGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const pts = Array.from(doc.getElementsByTagName('trkpt'));
  const t0 = Date.now();
  const track = [];
  pts.forEach((p, i) => {
    const lat = parseFloat(p.getAttribute('lat'));
    const lng = parseFloat(p.getAttribute('lon'));
    if (isNaN(lat) || isNaN(lng)) return;
    const timeEl = p.getElementsByTagName('time')[0];
    let t;
    if (timeEl) {
      const ms = Date.parse(timeEl.textContent);
      t = isNaN(ms) ? t0 + i * 1000 : ms;
    } else {
      t = t0 + i * 1000;
    }
    track.push({ lat, lng, t });
  });
  return track;
}
