// util.js
// 地理計算（距離・方位・角度差）のユーティリティ。
// このモジュールは副作用を持たない純粋関数のみで構成し、
// Phase 0 以降のすべてのフェーズ（警報ロジック・重複判定・GPX再生）から再利用する。

/** 地球半径（メートル）。Haversine計算で使用。 */
const EARTH_RADIUS_M = 6371000;

/** 度 → ラジアン変換 */
export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** ラジアン → 度変換 */
export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * 2地点間の距離を Haversine 公式で求める（メートル）。
 * @param {number} lat1 緯度1
 * @param {number} lng1 経度1
 * @param {number} lat2 緯度2
 * @param {number} lng2 経度2
 * @returns {number} 距離（メートル）
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * 地点1から地点2へ向かう方位角（0〜359度、北=0、東=90）を求める。
 * GPSの heading が取れない場合の進行方向算出に使う。
 * @returns {number} 方位角（度、0-359）
 */
export function bearing(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360; // 0-359に正規化
}

/**
 * 2つの方位角の最小差（0〜180度）を求める。
 * 進行方向±45度の判定に使用。例: angleDiff(350, 10) === 20
 * @returns {number} 差（度、0-180）
 */
export function angleDiff(a, b) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/** m/s を km/h に変換 */
export function msToKmh(ms) {
  return ms * 3.6;
}

/**
 * 緯度経度が日本国内の妥当な範囲かをざっくり判定する。
 * CSVインポート時のバリデーション等で使用。
 * （厳密な国境判定ではなく、明らかな異常値を弾くための矩形判定）
 * @returns {boolean}
 */
export function isInJapan(lat, lng) {
  return lat >= 24 && lat <= 46 && lng >= 122 && lng <= 154;
}
