// speech.js
// 音声読み上げ（Web Speech API）のラッパー。
//
// 【iOSの制約】speechSynthesis は最初の発話をユーザー操作(タップ)起点で
// 呼ばないと鳴らないことがある。測位開始ボタンなどで unlock() を呼ぶ。

let _muted = false;
let _volume = 1.0;
let _unlocked = false;

/** 日本語の音声を優先的に選ぶ。 */
function pickJaVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ja')) || null;
}

/**
 * 音声を有効化する（ユーザー操作の中で呼ぶこと）。
 * 無音に近い短い発話を流して iOS の自動再生制限を解除する。
 */
export function unlockSpeech() {
  if (_unlocked || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    _unlocked = true;
  } catch (e) {
    /* 対応していなくても致命的ではない */
  }
}

/**
 * テキストを読み上げる。ミュート中は何もしない。
 * @param {string} text
 * @param {object} [opts] { interrupt?:boolean }
 */
export function speak(text, opts = {}) {
  if (_muted || !window.speechSynthesis || !text) return;
  try {
    if (opts.interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.volume = _volume;
    u.rate = 1.0;
    const v = pickJaVoice();
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) {
    console.error('読み上げに失敗:', e);
  }
}

/** ミュート状態を設定。 */
export function setMuted(m) {
  _muted = !!m;
  if (_muted && window.speechSynthesis) speechSynthesis.cancel();
}

/** ミュート状態を取得。 */
export function isMuted() {
  return _muted;
}

/** 音量(0〜1)を設定。 */
export function setVolume(v) {
  _volume = Math.max(0, Math.min(1, v));
}
