// spots.js
// オービス等の地点(SpotRecord)のモデル・重複判定・表示ラベル。
//
// SpotRecord {
//   id: string, lat: number, lng: number,
//   type: 'fixed'|'mobile'|'n_system'|'checkpoint'|'user',
//   direction?: number,   // 対象進行方向(度,0-359)。未指定=全方向
//   speedLimit?: number,  // その地点の制限速度
//   label: string,        // 表示名
//   source: string,       // 出典（表示義務のあるライセンス対応で必須）
//   confidence: 'high'|'medium'|'low',
//   updatedAt: string,    // ISO8601
// }

import { getAllSpots, putSpot } from './db.js';
import { haversine } from './util.js';

/** 同一地点とみなす距離（メートル）。 */
const DEDUP_DISTANCE_M = 50;

/** 種別 → 表示ラベル。 */
export const TYPE_LABELS = {
  fixed: '固定式オービス',
  mobile: '移動式（取締り実績）',
  n_system: 'Nシステム',
  checkpoint: '検問（取締り実績）',
  user: '自己登録地点',
};

/**
 * 種別 → 警報の読み上げ文言。
 * 移動式・検問は常設ではないため断定を避けた表現にする（要件）。
 * @param {string} type
 * @returns {string}
 */
export function speechPhraseForType(type) {
  switch (type) {
    case 'fixed': return '固定式オービスです';
    case 'n_system': return 'Nシステムです';
    case 'mobile': return 'この付近で移動式の取締り実績があります';
    case 'checkpoint': return 'この付近で検問の実績があります';
    default: return '登録地点です';
  }
}

/** 信頼度の順位（大きいほど高信頼）。 */
const CONF_RANK = { high: 3, medium: 2, low: 1 };

/** 一意な地点IDを生成。 */
export function newSpotId(prefix = 'self') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * SpotRecord を作る（未指定項目を補完）。
 * @param {object} p 部分的な地点情報
 * @returns {object} SpotRecord
 */
export function makeSpot(p) {
  return {
    id: p.id || newSpotId(p.source === 'self' ? 'self' : 'imp'),
    lat: p.lat,
    lng: p.lng,
    type: p.type || 'user',
    direction: p.direction ?? null,
    speedLimit: p.speedLimit ?? null,
    label: p.label || TYPE_LABELS[p.type] || '地点',
    source: p.source || 'self',
    confidence: p.confidence || 'high',
    updatedAt: p.updatedAt || new Date().toISOString(),
  };
}

/**
 * 重複判定して保存する。
 * 既存に「50m以内かつ同一種別」があれば、信頼度が高い方を優先してマージ。
 * @param {object} spot SpotRecord
 * @returns {Promise<{action:'added'|'merged'|'kept', spot:object}>}
 */
export async function addSpotWithDedup(spot) {
  const existing = await getAllSpots();
  const dup = existing.find(
    (e) => e.type === spot.type && haversine(e.lat, e.lng, spot.lat, spot.lng) <= DEDUP_DISTANCE_M
  );
  if (!dup) {
    await putSpot(spot);
    return { action: 'added', spot };
  }
  // 既存の方が信頼度が高い/同等なら既存を残す
  if (CONF_RANK[dup.confidence] >= CONF_RANK[spot.confidence]) {
    return { action: 'kept', spot: dup };
  }
  // 新しい方が高信頼 → 既存idを引き継いで上書き（マージ）
  const merged = { ...spot, id: dup.id, updatedAt: new Date().toISOString() };
  await putSpot(merged);
  return { action: 'merged', spot: merged };
}

/** 全地点を取得（db の getAllSpots を再エクスポート）。 */
export { getAllSpots };
