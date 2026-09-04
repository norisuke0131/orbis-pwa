// import.js
// 地点データの取り込みアダプタ。
//  A: OpenStreetMap / Overpass API（自動取得, ODbL）
//  B: CSV / GeoJSON インポート（手動）
//
// いずれも SpotRecord 配列（未dedup）を返す。保存は呼び出し側で addSpotWithDedup する。

import { makeSpot } from './spots.js';
import { isInJapan } from './util.js';
import { haversine } from './util.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_KEY = 'overpass-cache';
const CACHE_TTL_MS = 24 * 3600 * 1000; // 24時間
const SAME_AREA_M = 10000; // 10km以内は同一エリア扱い

/**
 * 24時間キャッシュの判定。同一エリアを24h以内に取得済みなら再取得を抑止。
 * @returns {{blocked:boolean, remainingMin?:number}}
 */
export function overpassCacheStatus(lat, lng) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c) return { blocked: false };
    const age = Date.now() - c.at;
    if (age < CACHE_TTL_MS && haversine(c.lat, c.lng, lat, lng) < SAME_AREA_M) {
      return { blocked: true, remainingMin: Math.ceil((CACHE_TTL_MS - age) / 60000) };
    }
  } catch (e) { /* noop */ }
  return { blocked: false };
}

function markOverpassFetched(lat, lng) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), lat, lng }));
  } catch (e) { /* noop */ }
}

/**
 * アダプタA: 現在地周辺(半径50km)の speed_camera / enforcement=maxspeed を取得。
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{spots:Array, rawCount:number}>}
 */
export async function fetchOverpass(lat, lng) {
  const query = `[out:json][timeout:25];
(
  node["highway"="speed_camera"](around:50000,${lat},${lng});
  relation["type"="enforcement"]["enforcement"="maxspeed"](around:50000,${lat},${lng});
);
out center tags;`;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass応答エラー: ${res.status}`);
  const json = await res.json();
  const elems = json.elements || [];

  const spots = [];
  for (const el of elems) {
    const plat = el.lat ?? (el.center && el.center.lat);
    const plng = el.lon ?? (el.center && el.center.lon);
    if (plat == null || plng == null) continue;
    const tags = el.tags || {};
    const speedLimit = tags.maxspeed ? parseInt(tags.maxspeed, 10) : null;
    spots.push(
      makeSpot({
        id: `osm-${el.type}-${el.id}`,
        lat: plat,
        lng: plng,
        type: 'fixed', // OSMの取締り関連は固定式相当として扱う
        speedLimit: isNaN(speedLimit) ? null : speedLimit,
        label: tags.name || 'OSM 取締り地点',
        source: 'OpenStreetMap contributors (ODbL)',
        confidence: 'medium',
      })
    );
  }
  markOverpassFetched(lat, lng);
  return { spots, rawCount: elems.length };
}

/**
 * アダプタB-1: CSV を SpotRecord に変換する。
 * ヘッダ例: lat,lng,type,label,speedLimit,direction
 * @param {string} text
 * @returns {{spots:Array, errors:Array<{line:number, reason:string}>}}
 */
export function importCSV(text) {
  const spots = [];
  const errors = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { spots, errors };

  // ヘッダ解析
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iLat = idx('lat'), iLng = idx('lng'), iType = idx('type');
  const iLabel = idx('label'), iLimit = idx('speedlimit'), iDir = idx('direction');
  if (iLat < 0 || iLng < 0) {
    errors.push({ line: 1, reason: 'ヘッダに lat, lng が必要です' });
    return { spots, errors };
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const lat = parseFloat(cols[iLat]);
    const lng = parseFloat(cols[iLng]);
    if (isNaN(lat) || isNaN(lng)) { errors.push({ line: i + 1, reason: '緯度経度が数値でない' }); continue; }
    if (!isInJapan(lat, lng)) { errors.push({ line: i + 1, reason: '日本の範囲外の座標' }); continue; }
    const type = iType >= 0 ? (cols[iType] || '').trim() : 'user';
    spots.push(
      makeSpot({
        lat, lng,
        type: ['fixed', 'mobile', 'n_system', 'checkpoint', 'user'].includes(type) ? type : 'user',
        label: iLabel >= 0 ? (cols[iLabel] || '').trim() : '',
        speedLimit: iLimit >= 0 && cols[iLimit] ? parseInt(cols[iLimit], 10) : null,
        direction: iDir >= 0 && cols[iDir] !== '' && cols[iDir] != null ? parseFloat(cols[iDir]) : null,
        source: 'CSVインポート',
        confidence: 'high',
      })
    );
  }
  return { spots, errors };
}

/**
 * アダプタB-2: GeoJSON(FeatureCollection, Point)を SpotRecord に変換する。
 * @param {string} text
 * @returns {{spots:Array, errors:Array<{line:number, reason:string}>}}
 */
export function importGeoJSON(text) {
  const spots = [];
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    errors.push({ line: 0, reason: 'JSONとして読み取れません' });
    return { spots, errors };
  }
  const features = data.type === 'FeatureCollection' ? (data.features || []) : [];
  features.forEach((f, i) => {
    const g = f.geometry;
    if (!g || g.type !== 'Point') { errors.push({ line: i + 1, reason: 'Point以外は対象外' }); return; }
    const [lng, lat] = g.coordinates || [];
    if (isNaN(lat) || isNaN(lng)) { errors.push({ line: i + 1, reason: '座標が不正' }); return; }
    if (!isInJapan(lat, lng)) { errors.push({ line: i + 1, reason: '日本の範囲外の座標' }); return; }
    const p = f.properties || {};
    const type = (p.type || 'user');
    spots.push(
      makeSpot({
        lat, lng,
        type: ['fixed', 'mobile', 'n_system', 'checkpoint', 'user'].includes(type) ? type : 'user',
        label: p.label || '',
        speedLimit: p.speedLimit ?? null,
        direction: p.direction ?? null,
        source: 'GeoJSONインポート',
        confidence: 'high',
      })
    );
  });
  return { spots, errors };
}
