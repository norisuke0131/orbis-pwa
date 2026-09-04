// config.js
// 設定値の保存/読み出し（localStorage）。
// 地点データは IndexedDB、設定値は localStorage という要件の切り分けに沿う。

const KEY = 'orbis-settings';

/** 既定値 */
const DEFAULTS = {
  overSpeedThresholdKmh: 60, // 速度超過とみなすしきい値
  autoDeleteDays: 0, // 0=自動削除しない。N日より古いログを消す
  headingUp: true, // 地図の既定向き（true=進行方向アップ）
  autoStopMinutes: 30, // 停車がこの分数続いたら自動停止（0=しない）
  autoStartOnLaunch: false, // 起動時に自動で測位を開始
};

/** 全設定を取得（既定値とマージ）。 */
export function getSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch (e) {
    saved = {};
  }
  return { ...DEFAULTS, ...saved };
}

/** 単一設定を取得。 */
export function getSetting(key) {
  return getSettings()[key];
}

/** 単一設定を保存。 */
export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.error('設定の保存に失敗:', e);
  }
}
