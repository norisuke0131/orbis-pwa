// recorder.js
// 行動ログの記録係。GeoTracker からの fix を受け取り、
// 「トリップ」として IndexedDB に書き込む。
//
// 記録方式（ユーザー選択）: 測位中は自動で常に記録。
// 走行点は約1秒間隔に間引いて保存し、走行距離・最高速度を随時集計する。

import { createTrip, addPoint, endTrip } from './db.js';
import { haversine, localDateStr } from './util.js';

/** 走行点を保存する最小間隔（ms）。GPSが高頻度でも約1秒に間引く。 */
const MIN_POINT_INTERVAL_MS = 1000;

export class TripRecorder {
  constructor() {
    this._tripId = null;
    this._lastStored = null; // {lat,lng,t} 直近保存点（距離・間引き用）
    this._pointCount = 0;
    this._distanceM = 0;
    this._maxSpeedKmh = 0;
    this._startedAt = 0;
    this._lastT = 0; // 直近に記録した時刻（endTrip用）
    this._busy = false; // 書き込み中フラグ（多重防止）
  }

  get isRecording() {
    return this._tripId !== null;
  }

  /** 新しいトリップの記録を開始する。 */
  async start() {
    if (this._tripId !== null) return;
    this._startedAt = Date.now();
    this._lastStored = null;
    this._pointCount = 0;
    this._distanceM = 0;
    this._maxSpeedKmh = 0;
    this._lastT = this._startedAt;
    try {
      this._tripId = await createTrip(
        this._startedAt,
        localDateStr(this._startedAt)
      );
    } catch (e) {
      // 記録に失敗しても走行画面は動かし続ける（ログはベストエフォート）
      console.error('トリップ作成に失敗:', e);
      this._tripId = null;
    }
  }

  /**
   * fix を1件処理する。約1秒間隔で走行点を保存する。
   * @param {import('./geo.js').GeoFix} fix
   */
  async onFix(fix) {
    if (this._tripId === null || this._busy) return;
    const t = fix.timestamp || Date.now();

    // 間引き: 直近保存から MIN_POINT_INTERVAL_MS 未満ならスキップ
    if (this._lastStored && t - this._lastStored.t < MIN_POINT_INTERVAL_MS) {
      return;
    }

    // 距離の積算（直近保存点からの移動量）
    if (this._lastStored) {
      const d = haversine(this._lastStored.lat, this._lastStored.lng, fix.lat, fix.lng);
      // GPSジッターの微小移動を距離に足しすぎないよう、精度以下の揺れは無視
      if (d > Math.min(fix.accuracy || 0, 15)) {
        this._distanceM += d;
      }
    }
    if (fix.speedKmh > this._maxSpeedKmh) this._maxSpeedKmh = fix.speedKmh;

    this._busy = true;
    try {
      await addPoint({
        tripId: this._tripId,
        lat: fix.lat,
        lng: fix.lng,
        speedKmh: fix.speedKmh,
        heading: fix.heading,
        accuracy: fix.accuracy,
        t,
      });
      this._pointCount += 1;
      this._lastStored = { lat: fix.lat, lng: fix.lng, t };
      this._lastT = t;
    } catch (e) {
      console.error('走行点の保存に失敗:', e);
    } finally {
      this._busy = false;
    }
  }

  /** 記録を終了し、集計をトリップに書き込む。 */
  async stop() {
    if (this._tripId === null) return;
    const id = this._tripId;
    this._tripId = null; // 先に無効化して onFix を止める
    try {
      await endTrip(id, {
        endedAt: this._lastT || Date.now(),
        pointCount: this._pointCount,
        distanceM: Math.round(this._distanceM),
        maxSpeedKmh: Math.round(this._maxSpeedKmh * 10) / 10,
      });
    } catch (e) {
      console.error('トリップ終了の保存に失敗:', e);
    }
  }
}
