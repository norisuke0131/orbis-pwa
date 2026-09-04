// geo.js
// 位置情報の監視ラッパー。
// navigator.geolocation.watchPosition を扱いやすい形にまとめ、
// 進行方向(heading)と速度(speed)を安定して供給する。
//
// 【設計上の重要点】
// iOS Safari では coords.heading が静止時 null / 低速時 不安定なため、
// 「GPS 2点間の方位計算」を主たる進行方向とする（着手前の懸念1の結論）。
// また Phase 2 の GPX再生モードでは、この GeoTracker を差し替える形で
// watchPosition をモックする（同じ update コールバック形式に揃える）。

import { bearing, haversine, msToKmh } from './util.js';

/** 進行方向を「有効」とみなす最低速度（m/s）。約 2.5 m/s ≒ 9 km/h。 */
const HEADING_MIN_SPEED_MS = 2.5;

/** bearing 計算に必要な最小移動距離（メートル）。GPSジッター対策。 */
const MIN_MOVE_FOR_BEARING_M = 5;

/**
 * @typedef {Object} GeoFix
 * @property {number} lat        緯度
 * @property {number} lng        経度
 * @property {number} accuracy   位置精度（メートル）
 * @property {number} speedMs    速度（m/s）
 * @property {number} speedKmh   速度（km/h）
 * @property {number|null} heading 進行方向（度, 0-359）。不定なら null
 * @property {boolean} headingReliable 進行方向が信頼できるか（低速時は false）
 * @property {number} timestamp  取得時刻（ms epoch）
 * @property {'gps'|'computed'|'none'} headingSource 方向の由来
 */

export class GeoTracker {
  constructor() {
    /** @type {number|null} watchPosition の ID */
    this._watchId = null;
    /** @type {GeoFix|null} 直近の確定 fix（bearing 計算用） */
    this._last = null;
    this._onUpdate = null;
    this._onError = null;
  }

  /** 監視中かどうか */
  get isRunning() {
    return this._watchId !== null;
  }

  /**
   * 位置監視を開始する。
   * @param {(fix: GeoFix) => void} onUpdate 位置更新のたびに呼ばれる
   * @param {(err: GeolocationPositionError|Error) => void} [onError]
   */
  start(onUpdate, onError) {
    this._onUpdate = onUpdate;
    this._onError = onError || (() => {});

    if (!('geolocation' in navigator)) {
      this._onError(new Error('この端末は位置情報に対応していません。'));
      return;
    }
    if (this._watchId !== null) return; // 二重起動防止

    this._watchId = navigator.geolocation.watchPosition(
      (pos) => this._handlePosition(pos),
      (err) => this._onError(err),
      {
        enableHighAccuracy: true, // 高精度モード（要件指定）
        maximumAge: 0, // キャッシュを使わず常に最新
        timeout: 10000,
      }
    );
  }

  /** 位置監視を停止する。 */
  stop() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
  }

  /**
   * GeolocationPosition を GeoFix に正規化して onUpdate へ渡す。
   * @param {GeolocationPosition} pos
   */
  _handlePosition(pos) {
    const c = pos.coords;
    const lat = c.latitude;
    const lng = c.longitude;

    // --- 速度の決定 ---
    // coords.speed は取れない端末では null になるため、
    // その場合は直近 fix からの距離÷時間で推定する。
    let speedMs = typeof c.speed === 'number' && c.speed >= 0 ? c.speed : null;
    if (speedMs === null && this._last) {
      const dt = (pos.timestamp - this._last.timestamp) / 1000;
      if (dt > 0) {
        const dist = haversine(this._last.lat, this._last.lng, lat, lng);
        speedMs = dist / dt;
      }
    }
    if (speedMs === null || !isFinite(speedMs)) speedMs = 0;

    // --- 進行方向の決定（着手前の懸念1の結論を実装） ---
    let heading = null;
    let headingSource = 'none';
    const reliable = speedMs >= HEADING_MIN_SPEED_MS;

    if (reliable && typeof c.heading === 'number' && !isNaN(c.heading)) {
      // 速度が十分あり、GPS由来の heading が取れる場合はそれを採用
      heading = c.heading;
      headingSource = 'gps';
    } else if (reliable && this._last) {
      // GPS heading が無い/不安定な場合、直近2点から方位を計算
      const moved = haversine(this._last.lat, this._last.lng, lat, lng);
      if (moved >= MIN_MOVE_FOR_BEARING_M) {
        heading = bearing(this._last.lat, this._last.lng, lat, lng);
        headingSource = 'computed';
      } else if (this._last.heading !== null) {
        // 移動量が小さいときは直近の向きを維持
        heading = this._last.heading;
        headingSource = this._last.headingSource;
      }
    }

    /** @type {GeoFix} */
    const fix = {
      lat,
      lng,
      accuracy: c.accuracy,
      speedMs,
      speedKmh: msToKmh(speedMs),
      heading,
      headingReliable: reliable && heading !== null,
      timestamp: pos.timestamp,
      headingSource,
    };

    this._last = fix;
    if (this._onUpdate) this._onUpdate(fix);
  }
}
