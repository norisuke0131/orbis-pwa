// db.js
// IndexedDB ラッパー。行動ログ（トリップ＋走行点）を端末内に保存する。
//
// 【重要・プライバシー】ここに保存される移動履歴は端末内(IndexedDB)のみに置かれ、
// サーバーには一切送信しない。
//
// object stores:
//   trips  : 1回の測位セッション。 { id(auto), startedAt, endedAt, date, ...集計 }
//   points : 走行点。 { id(auto), tripId, lat, lng, speedKmh, heading, accuracy, t }
//            tripId でインデックスを張り、トリップ単位で取り出す。
//
// 将来 Phase 1 の地点データ(spots)もこの DB にバージョンを上げて追加する想定。

const DB_NAME = 'orbis-db';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * DB を開く（未オープンなら初期化）。以降は同じ接続を使い回す。
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // スキーマ作成/移行
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) {
        db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('points')) {
        const ps = db.createObjectStore('points', {
          keyPath: 'id',
          autoIncrement: true,
        });
        ps.createIndex('tripId', 'tripId', { unique: false });
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 1つのトランザクションを Promise 化するヘルパ。 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IDBRequest を Promise 化するヘルパ。 */
function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 新しいトリップを作成し、その id を返す。
 * @param {number} startedAt epoch ms
 * @param {string} date 'YYYY-MM-DD'（ローカル日）
 * @returns {Promise<number>}
 */
export async function createTrip(startedAt, date) {
  const db = await openDB();
  const tx = db.transaction('trips', 'readwrite');
  const id = await reqDone(
    tx.objectStore('trips').add({
      startedAt,
      endedAt: null,
      date,
      pointCount: 0,
      distanceM: 0,
      maxSpeedKmh: 0,
    })
  );
  await txDone(tx);
  return id;
}

/**
 * 走行点を1件追加する。
 * @param {object} point { tripId, lat, lng, speedKmh, heading, accuracy, t }
 */
export async function addPoint(point) {
  const db = await openDB();
  const tx = db.transaction('points', 'readwrite');
  tx.objectStore('points').add(point);
  await txDone(tx);
}

/**
 * トリップを終了し、集計値を書き込む。
 * @param {number} tripId
 * @param {object} summary { endedAt, pointCount, distanceM, maxSpeedKmh }
 */
export async function endTrip(tripId, summary) {
  const db = await openDB();
  const tx = db.transaction('trips', 'readwrite');
  const store = tx.objectStore('trips');
  const trip = await reqDone(store.get(tripId));
  if (trip) {
    Object.assign(trip, summary);
    store.put(trip);
  }
  await txDone(tx);
}

/**
 * 全トリップを新しい順で返す。
 * @returns {Promise<Array>}
 */
export async function getAllTrips() {
  const db = await openDB();
  const tx = db.transaction('trips', 'readonly');
  const all = await reqDone(tx.objectStore('trips').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 指定トリップの走行点を時刻順で返す。
 * @param {number} tripId
 * @returns {Promise<Array>}
 */
export async function getPoints(tripId) {
  const db = await openDB();
  const tx = db.transaction('points', 'readonly');
  const idx = tx.objectStore('points').index('tripId');
  const pts = await reqDone(idx.getAll(IDBKeyRange.only(tripId)));
  return pts.sort((a, b) => a.t - b.t);
}

/**
 * トリップと、それに紐づく走行点をまとめて削除する。
 * @param {number} tripId
 */
export async function deleteTrip(tripId) {
  const db = await openDB();
  const tx = db.transaction(['trips', 'points'], 'readwrite');
  tx.objectStore('trips').delete(tripId);
  // points は tripId インデックスからカーソルで削除
  const idx = tx.objectStore('points').index('tripId');
  const curReq = idx.openCursor(IDBKeyRange.only(tripId));
  curReq.onsuccess = () => {
    const cur = curReq.result;
    if (cur) {
      cur.delete();
      cur.continue();
    }
  };
  await txDone(tx);
}

/** すべての行動ログ（trips/points）を削除する。 */
export async function deleteAllLogs() {
  const db = await openDB();
  const tx = db.transaction(['trips', 'points'], 'readwrite');
  tx.objectStore('trips').clear();
  tx.objectStore('points').clear();
  await txDone(tx);
}

/**
 * 指定日より前（endedAt/startedAt が古い）のトリップを削除する。
 * 自動削除設定で使用。
 * @param {number} cutoffMs この時刻より前に開始したトリップを削除
 */
export async function deleteTripsBefore(cutoffMs) {
  const trips = await getAllTrips();
  for (const t of trips) {
    if (t.startedAt < cutoffMs) {
      await deleteTrip(t.id);
    }
  }
}
