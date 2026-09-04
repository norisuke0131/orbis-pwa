// alerts.js
// 警報ロジック。自車位置・進行方向と地点群から、前方の地点に対して
// 3段階(1000/500/200m)の警報イベントを生成する。
//
// 方針（要件）:
// - 前方のみ: 自車→地点の方位が進行方向の ±45度以内の地点だけを対象。
// - 対象進行方向(direction)指定がある地点は、自車の進行方向が概ね一致する時のみ。
// - 同一地点への重複警報は、通過するまで各段階1回のみ。
// - 移動式・検問は断定を避けた文言（spots.js の speechPhraseForType）。

import { haversine, bearing, angleDiff } from './util.js';
import { speechPhraseForType } from './spots.js';

/** 警報段階（メートル）。昇順で「最も近い未通知段階」を選ぶのに使う。 */
const STAGES_ASC = [200, 500, 1000];
/** 前方とみなす角度（±度）。 */
const AHEAD_TOLERANCE = 45;
/** 背後（通過）とみなす角度。これを超えたら通過扱いにして状態リセット。 */
const BEHIND_ANGLE = 90;
/** 対象進行方向(direction)と自車進行方向の許容差（度）。 */
const TARGET_TOLERANCE = 60;
/** この距離を超えたら圏外として状態をリセット（再接近で再警報可能に）。 */
const RESET_DISTANCE_M = 1200;

/**
 * 段階と地点から読み上げ文を作る。
 * @param {number} stage 200|500|1000
 * @param {object} spot SpotRecord
 */
function buildMessage(stage, spot) {
  const phrase = speechPhraseForType(spot.type);
  if (stage === 1000) return `1キロ先、${phrase}`;
  if (stage === 500) {
    let m = `500メートル先、${phrase}。速度を確認してください`;
    if (spot.speedLimit) m += `。制限速度は${spot.speedLimit}キロです`;
    return m;
  }
  return `まもなく、${phrase}`;
}

export class AlertEngine {
  constructor() {
    /** @type {Map<string, Set<number>>} spotId → 通知済み段階 */
    this._fired = new Map();
  }

  /** 状態をリセット（測位開始時などに呼ぶ）。 */
  reset() {
    this._fired.clear();
  }

  /**
   * 現在の fix と地点群を評価し、発火すべき警報イベントを返す。
   * @param {import('./geo.js').GeoFix} fix
   * @param {Array} spots SpotRecord[]
   * @returns {{events:Array<{spot:object,stage:number,distance:number,message:string}>, nearest:{spot:object,distance:number}|null}}
   */
  evaluate(fix, spots) {
    const events = [];
    let nearest = null;

    // 進行方向が不明（低速/静止）なら前方判定できないため警報しない
    if (fix.heading === null || isNaN(fix.heading)) {
      return { events, nearest };
    }

    for (const s of spots) {
      const dist = haversine(fix.lat, fix.lng, s.lat, s.lng);

      // 圏外: 状態リセットして次へ
      if (dist > RESET_DISTANCE_M) {
        this._fired.delete(s.id);
        continue;
      }

      // 前方判定: 自車→地点の方位が進行方向の ±45度以内か
      const brg = bearing(fix.lat, fix.lng, s.lat, s.lng);
      const aheadDiff = angleDiff(fix.heading, brg);
      if (aheadDiff > AHEAD_TOLERANCE) {
        // 背後に回った＝通過とみなして状態リセット（再接近で再警報可能に）
        if (aheadDiff > BEHIND_ANGLE) this._fired.delete(s.id);
        continue;
      }

      // 対象進行方向の指定がある場合、自車の向きが概ね一致するか
      if (s.direction != null && angleDiff(fix.heading, s.direction) > TARGET_TOLERANCE) {
        continue;
      }

      // 前方の対象のうち最も近いものを記録（HUDの「次の地点まで」用）
      if (!nearest || dist < nearest.distance) nearest = { spot: s, distance: dist };

      // 最も近い未通知段階を選ぶ
      const applicable = STAGES_ASC.find((S) => dist <= S);
      if (applicable == null) continue;

      let fired = this._fired.get(s.id);
      if (!fired) {
        fired = new Set();
        this._fired.set(s.id, fired);
      }
      if (!fired.has(applicable)) {
        // この段階以上をまとめて通知済みにする（飛ばした遠い段階を後で鳴らさない）
        for (const S of STAGES_ASC) if (S >= applicable) fired.add(S);
        events.push({ spot: s, stage: applicable, distance: dist, message: buildMessage(applicable, s) });
      }
    }

    return { events, nearest };
  }
}
