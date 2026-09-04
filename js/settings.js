// settings.js
// 設定画面。速度超過しきい値、ログの自動削除、エクスポート、全削除。

import { getSettings, setSetting } from './config.js';
import { getAllTrips, getPoints, deleteAllLogs } from './db.js';
import { localDateStr } from './util.js';

let elThreshold, elThresholdOut, elAutoDelete, elExportGeo, elExportCsv, elDeleteAll, elStorageInfo;

/** 初期化: 要素取得・現在値反映・イベント配線。 */
export function initSettings() {
  elThreshold = document.getElementById('set-threshold');
  elThresholdOut = document.getElementById('set-threshold-out');
  elAutoDelete = document.getElementById('set-autodelete');
  elExportGeo = document.getElementById('set-export-geo');
  elExportCsv = document.getElementById('set-export-csv');
  elDeleteAll = document.getElementById('set-delete-all');
  elStorageInfo = document.getElementById('set-storage');

  const s = getSettings();
  elThreshold.value = s.overSpeedThresholdKmh;
  elThresholdOut.textContent = `${s.overSpeedThresholdKmh} km/h`;
  elAutoDelete.value = String(s.autoDeleteDays);

  elThreshold.addEventListener('input', () => {
    elThresholdOut.textContent = `${elThreshold.value} km/h`;
  });
  elThreshold.addEventListener('change', () => {
    setSetting('overSpeedThresholdKmh', Number(elThreshold.value));
  });
  elAutoDelete.addEventListener('change', () => {
    setSetting('autoDeleteDays', Number(elAutoDelete.value));
  });

  elExportGeo.addEventListener('click', exportGeoJSON);
  elExportCsv.addEventListener('click', exportCSV);
  elDeleteAll.addEventListener('click', async () => {
    if (confirm('すべての行動ログを削除します。よろしいですか？（元に戻せません）')) {
      await deleteAllLogs();
      alert('すべての行動ログを削除しました。');
      refreshStorageInfo();
    }
  });

  refreshStorageInfo();
}

/** 保存状況（トリップ数）を表示。 */
export async function refreshStorageInfo() {
  if (!elStorageInfo) return;
  const trips = await getAllTrips();
  elStorageInfo.textContent = `保存中のトリップ: ${trips.length} 件`;
}

/** 全トリップを1つの GeoJSON（トリップ=LineString）に書き出してダウンロード。 */
async function exportGeoJSON() {
  const trips = await getAllTrips();
  const features = [];
  for (const t of trips) {
    const pts = await getPoints(t.id);
    if (pts.length === 0) continue;
    features.push({
      type: 'Feature',
      properties: {
        tripId: t.id, date: t.date, startedAt: t.startedAt, endedAt: t.endedAt,
        distanceM: t.distanceM, maxSpeedKmh: t.maxSpeedKmh,
      },
      geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) },
    });
  }
  const geo = { type: 'FeatureCollection', features };
  download(`orbis-log-${localDateStr(Date.now())}.geojson`, JSON.stringify(geo), 'application/geo+json');
}

/** 全走行点を CSV に書き出してダウンロード。 */
async function exportCSV() {
  const trips = await getAllTrips();
  let csv = 'tripId,date,t_iso,lat,lng,speedKmh,heading,accuracy\n';
  for (const t of trips) {
    const pts = await getPoints(t.id);
    for (const p of pts) {
      csv += [t.id, t.date, new Date(p.t).toISOString(), p.lat, p.lng, p.speedKmh, p.heading ?? '', p.accuracy ?? ''].join(',') + '\n';
    }
  }
  download(`orbis-log-${localDateStr(Date.now())}.csv`, csv, 'text/csv');
}

/** テキストをファイルとしてダウンロードさせる。 */
function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  } catch (e) {
    alert('エクスポートに失敗しました: ' + e.message);
  }
}
