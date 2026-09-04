// nav.js
// 簡易ナビの中核。無料の公共APIを使う（オフライン不可）。
//  - 住所/地名検索: Nominatim (OpenStreetMap)
//  - ルート探索: OSRM (router.project-osrm.org, driving)
// いずれも個人利用の低頻度前提。混雑時に不安定/制限の可能性あり。

import { haversine } from './util.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

/**
 * 地名・住所で検索して候補を返す（日本国内）。
 * @param {string} query
 * @returns {Promise<Array<{name:string, lat:number, lng:number}>>}
 */
export async function geocode(query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&countrycodes=jp&limit=6&addressdetails=0`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`検索エラー: ${res.status}`);
  const arr = await res.json();
  return arr.map((r) => ({ name: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) }));
}

/**
 * OSRM の maneuver を日本語の短い案内文にする。
 * @param {object} man maneuver {type, modifier}
 * @param {string} roadName
 */
function instructionText(man, roadName) {
  const t = man.type;
  const m = man.modifier || '';
  const road = roadName ? `${roadName}を` : '';
  const byMod = {
    left: '左折です',
    right: '右折です',
    'slight left': '斜め左方向です',
    'slight right': '斜め右方向です',
    'sharp left': '左に鋭く曲がります',
    'sharp right': '右に鋭く曲がります',
    straight: '直進です',
    uturn: 'Uターンです',
  };
  if (t === 'depart') return `${road}出発します`;
  if (t === 'arrive') return '目的地に到着します';
  if (t === 'roundabout' || t === 'rotary') return 'ロータリーに進みます';
  if (t === 'merge') return '合流します';
  if (t === 'on ramp') return '入口へ進みます';
  if (t === 'off ramp') return '出口へ出ます';
  if (t === 'fork') return m.includes('left') ? '左の分岐です' : '右の分岐です';
  if (t === 'end of road') return byMod[m] || '道なりに進みます';
  if (t === 'new name' || t === 'continue') return byMod[m] || '直進です';
  return byMod[m] || '道なりに進みます';
}

/**
 * ルートを取得する。
 * @param {{lat:number,lng:number}} from
 * @param {{lat:number,lng:number}} to
 * @returns {Promise<{coords:Array<[number,number]>, steps:Array<{lat:number,lng:number,text:string,dist:number}>, distanceM:number, durationSec:number}>}
 */
export async function fetchRoute(from, to) {
  const url = `${OSRM}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ルート取得エラー: ${res.status}`);
  const json = await res.json();
  if (!json.routes || json.routes.length === 0) throw new Error('ルートが見つかりません');
  const route = json.routes[0];

  // ジオメトリ [lng,lat] → [lat,lng]
  const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

  // 手順（曲がり角）
  const steps = [];
  for (const leg of route.legs || []) {
    for (const s of leg.steps || []) {
      const man = s.maneuver || {};
      const loc = man.location || [];
      if (loc.length < 2) continue;
      steps.push({
        lat: loc[1],
        lng: loc[0],
        text: instructionText(man, s.name),
        dist: s.distance || 0,
      });
    }
  }
  return { coords, steps, distanceM: route.distance, durationSec: route.duration };
}

/**
 * 点から経路（頂点列）までの最短距離（近似: 頂点への最短）。
 * リルート判定に使用。経路は密なので頂点最短で十分。
 * @param {number} lat
 * @param {number} lng
 * @param {Array<[number,number]>} coords
 * @returns {number} メートル
 */
export function distanceToPath(lat, lng, coords) {
  let min = Infinity;
  for (const [clat, clng] of coords) {
    const d = haversine(lat, lng, clat, clng);
    if (d < min) min = d;
  }
  return min;
}

/** m/秒 表記の補助。 */
export function formatEta(durationSec) {
  const min = Math.round(durationSec / 60);
  if (min >= 60) return `約${Math.floor(min / 60)}時間${min % 60}分`;
  return `約${min}分`;
}
