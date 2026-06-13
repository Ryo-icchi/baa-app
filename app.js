/* ばあ！ — 1歳児向け いないいないばあアプリ
 * 設計原則:
 *  - 全画面が当たり判定（狙ったタップを要求しない）
 *  - 失敗・不正解の概念なし、テキスト誘導なし
 *  - 音はなくても視覚だけで遊びが成立する
 *  - 写真・音声は IndexedDB（端末内）のみ。外部送信なし
 */
"use strict";

// ============ 状態 ============
const state = {
  items: [],          // 登録アイテム（IndexedDB から読み込み）
  queue: [],          // シャッフル再生キュー
  current: null,
  doorOpen: false,
  busy: false,        // アニメーション中の連打ガード
  soundOn: localStorage.getItem("soundOn") !== "0",
  night: false,
};

const audioPlayer = new Audio();
const audioUrlCache = new Map(); // itemId -> objectURL

// ============ サウンド（Web Audio で合成・オフライン完結・著作物なし） ============
// 設計: 飛行機・電車対応のため「音はおまけ」。state.soundOn と iOS の消音スイッチ
//       両方で止まる（Web Audio は消音スイッチを尊重するので電車では自動で静かになる）。
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  // iOS はユーザー操作内で resume しないと鳴らない（openDoor はタップ起点なのでOK）
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// 1音（やわらかいベル風: 速い立ち上がり → ゆっくり減衰）
function playTone(freq, startOffset, dur, peak, type) {
  const ctx = audioCtx;
  if (!ctx) return;
  const t0 = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "triangle";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 動物ごとに音程を変えて変化を出す（登録写真は id から決める）
const ANIMAL_NOTES = {
  "builtin-bear": 57, "builtin-cat": 64, "builtin-rabbit": 69, "builtin-chick": 76,
  "builtin-dog": 60, "builtin-penguin": 62, "builtin-elephant": 53, "builtin-panda": 67,
};
function noteForItem(item) {
  if (ANIMAL_NOTES[item.id] != null) return ANIMAL_NOTES[item.id];
  let h = 0;
  for (let i = 0; i < item.id.length; i++) h = (h * 31 + item.id.charCodeAt(i)) | 0;
  const penta = [60, 62, 64, 67, 69];
  return penta[Math.abs(h) % penta.length];
}

// とびらが開く「ぽよん」
function playPop() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(380, t0);
  osc.frequency.exponentialRampToValueAtTime(720, t0 + 0.1);
  gain.gain.setValueAtTime(0.16, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

// 「ばあ！」明るい上昇アルペジオ（ペンタトニックなので必ず気持ちいい）
function playRevealJingle(root) {
  if (!getAudioCtx()) return;
  [0, 4, 7, 12].forEach((s, i) => // do mi sol do
    playTone(midiToFreq(root + s), i * 0.075, 0.55, 0.16, "triangle"));
}

// とびらが閉まる「とん」
function playCloseSound() {
  if (!state.soundOn) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, t0);
  osc.frequency.exponentialRampToValueAtTime(170, t0 + 0.12);
  gain.gain.setValueAtTime(0.1, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.16);
}

// 名前のよみあげ（端末に日本語音声があれば。なければ何もしない＝ジングルだけ）
function speakName(name) {
  if (!name || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(name);
    u.lang = "ja-JP";
    u.rate = 0.95;
    u.pitch = 1.4; // 高めでかわいく
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

// とびらが開いた瞬間の全サウンド（iOS のジェスチャ要件のため全て同期実行）
function playOpenSound(item) {
  if (!state.soundOn) return;
  playPop();
  if (!item.builtin && item.audio) {
    // 親の録音が主役。ジングルは鳴らさず録音だけ（重なり防止）
    playVoice(item);
  } else {
    playRevealJingle(noteForItem(item));
    if (item.name) speakName(item.name);
  }
}

// ============ 内蔵イラスト（すべてオリジナルSVG・くまさんの作画文法で統一） ============
// 文法: フラット2トーン（体色+明るい差し色）/ 目=黒丸r3.5 / 鼻=黒楕円 /
//       口=「M x y q-5 6 -9 2」の左右カーブ / 頭=中央の大きな円 / 輪郭線なし
function animalSvg(bg, face) {
  // preserveAspectRatio=slice: インラインSVGはobject-fit非対応のため、cover相当の指定で
  // 縦長の「とびらの奥」を背景色で満たす（meetのままだと上下にレターボックス帯が出る）
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
    <rect width="100" height="100" fill="${bg}"/>${face}</svg>`;
}
const EYES = (y = 46, x1 = 38, x2 = 62) =>
  `<circle cx="${x1}" cy="${y}" r="3.5" fill="#3a2a1a"/><circle cx="${x2}" cy="${y}" r="3.5" fill="#3a2a1a"/>`;
const MOUTH = (x = 50, y = 62) =>
  `<path d="M${x} ${y} q-5 6 -9 2 M${x} ${y} q5 6 9 2" stroke="#3a2a1a" stroke-width="2" fill="none" stroke-linecap="round"/>`;
const BUILTINS = [
  {
    id: "builtin-bear", builtin: true, name: "くまさん",
    svg: animalSvg("#ffe2b8", `
      <circle cx="28" cy="26" r="11" fill="#b07a45"/><circle cx="72" cy="26" r="11" fill="#b07a45"/>
      <circle cx="28" cy="26" r="5" fill="#e8b888"/><circle cx="72" cy="26" r="5" fill="#e8b888"/>
      <circle cx="50" cy="52" r="30" fill="#b07a45"/>
      <ellipse cx="50" cy="62" rx="13" ry="10" fill="#e8b888"/>
      ${EYES()}<ellipse cx="50" cy="58" rx="4.5" ry="3.5" fill="#3a2a1a"/>
      ${MOUTH()}`),
  },
  {
    id: "builtin-cat", builtin: true, name: "ねこさん",
    svg: animalSvg("#dff3ff", `
      <path d="M24 40 L28 12 L47 28 Z" fill="#a9a9bb"/><path d="M76 40 L72 12 L53 28 Z" fill="#a9a9bb"/>
      <path d="M29 33 L31.5 18 L42 27 Z" fill="#e0e0ea"/><path d="M71 33 L68.5 18 L58 27 Z" fill="#e0e0ea"/>
      <circle cx="50" cy="54" r="29" fill="#a9a9bb"/>
      <ellipse cx="50" cy="64" rx="13" ry="9" fill="#e6e6ef"/>
      <path d="M19 53 L34 55 M20 63 L34 60 M81 53 L66 55 M80 63 L66 60" stroke="#8e8ea0" stroke-width="1.8" stroke-linecap="round"/>
      ${EYES(48)}<path d="M46.5 59 L53.5 59 L50 63 Z" fill="#e8899b"/>
      ${MOUTH(50, 63)}`),
  },
  {
    id: "builtin-rabbit", builtin: true, name: "うさぎさん",
    svg: animalSvg("#ffd9e8", `
      <ellipse cx="37" cy="17" rx="8.5" ry="19" fill="#f7f3ec"/><ellipse cx="63" cy="17" rx="8.5" ry="19" fill="#f7f3ec"/>
      <ellipse cx="37" cy="18" rx="4" ry="12" fill="#ffc4d8"/><ellipse cx="63" cy="18" rx="4" ry="12" fill="#ffc4d8"/>
      <circle cx="50" cy="56" r="29" fill="#f7f3ec"/>
      ${EYES(50)}<ellipse cx="50" cy="60" rx="4" ry="3" fill="#f08aa2"/>
      ${MOUTH(50, 63)}`),
  },
  {
    id: "builtin-chick", builtin: true, name: "ひよこさん",
    svg: animalSvg("#dff2ff", `
      <circle cx="50" cy="55" r="29" fill="#ffd94d"/>
      <path d="M46 27 q4 -10 8 0" stroke="#e8b800" stroke-width="3" fill="none" stroke-linecap="round"/>
      ${EYES(50)}
      <path d="M43 58 L57 58 L50 66 Z" fill="#ff9c3f"/>`),
  },
  {
    id: "builtin-dog", builtin: true, name: "わんわん",
    svg: animalSvg("#fff1d6", `
      <circle cx="50" cy="52" r="30" fill="#d9a268"/>
      <ellipse cx="25" cy="38" rx="10" ry="17" fill="#9c6b32" transform="rotate(18 25 38)"/>
      <ellipse cx="75" cy="38" rx="10" ry="17" fill="#9c6b32" transform="rotate(-18 75 38)"/>
      <ellipse cx="50" cy="63" rx="14" ry="10" fill="#f7e8cd"/>
      ${EYES()}<ellipse cx="50" cy="58" rx="4.5" ry="3.5" fill="#3a2a1a"/>
      ${MOUTH()}`),
  },
  {
    id: "builtin-penguin", builtin: true, name: "ぺんぎんさん",
    svg: animalSvg("#e6f0fb", `
      <circle cx="50" cy="52" r="30" fill="#4a5572"/>
      <circle cx="40" cy="58" r="13" fill="#ffffff"/><circle cx="60" cy="58" r="13" fill="#ffffff"/>
      <rect x="40" y="52" width="20" height="19" fill="#ffffff"/>
      ${EYES(55, 40, 60)}
      <path d="M44.5 60 L50 56.5 L55.5 60 L50 65 Z" fill="#ff9c3f"/>`),
  },
  {
    id: "builtin-elephant", builtin: true, name: "ぞうさん",
    svg: animalSvg("#e8f4e0", `
      <circle cx="23" cy="50" r="15" fill="#93a1bc"/><circle cx="77" cy="50" r="15" fill="#93a1bc"/>
      <circle cx="23" cy="50" r="9" fill="#ccd4e4"/><circle cx="77" cy="50" r="9" fill="#ccd4e4"/>
      <circle cx="50" cy="52" r="27" fill="#b4bdd0"/>
      ${EYES(46, 40, 60)}
      <path d="M45.5 56 L54.5 56 Q55.5 69 58.5 77 Q60 82.5 55 84 Q49.5 85 47.3 77.5 Q44.8 67 45.5 56 Z" fill="#b4bdd0"/>
      <ellipse cx="52.8" cy="80.5" rx="2.6" ry="1.8" fill="#8d9ab6" transform="rotate(18 52.8 80.5)"/>`),
  },
  {
    id: "builtin-panda", builtin: true, name: "ぱんださん",
    svg: animalSvg("#ffe9e0", `
      <circle cx="28" cy="26" r="11" fill="#3f3f3f"/><circle cx="72" cy="26" r="11" fill="#3f3f3f"/>
      <circle cx="50" cy="52" r="30" fill="#faf7f1"/>
      <ellipse cx="38" cy="49" rx="7.5" ry="9" fill="#3f3f3f" transform="rotate(-14 38 49)"/>
      <ellipse cx="62" cy="49" rx="7.5" ry="9" fill="#3f3f3f" transform="rotate(14 62 49)"/>
      <circle cx="38.5" cy="48.5" r="2.8" fill="#ffffff"/><circle cx="61.5" cy="48.5" r="2.8" fill="#ffffff"/>
      <circle cx="38.5" cy="48.8" r="1.7" fill="#3a2a1a"/><circle cx="61.5" cy="48.8" r="1.7" fill="#3a2a1a"/>
      <ellipse cx="50" cy="60" rx="4.5" ry="3.5" fill="#3a2a1a"/>
      ${MOUTH(50, 64)}`),
  },
];

// ============ IndexedDB ============
const DB_NAME = "baa-db";
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("items", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("items", mode);
    const store = tx.objectStore("items");
    const out = fn(store);
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

const loadItems  = () => idb("readonly",  (s) => s.getAll());
const putItem    = (item) => idb("readwrite", (s) => s.put(item));
const deleteItem = (id) => idb("readwrite", (s) => s.delete(id));

// ============ 再生プール ============
function rebuildQueue() {
  const pool = [...state.items, ...BUILTINS];
  // Fisher–Yates シャッフル
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // 直前と同じものが先頭に来たら後ろへ
  if (state.current && pool.length > 1 && pool[0].id === state.current.id) {
    pool.push(pool.shift());
  }
  state.queue = pool;
}

function nextItem() {
  if (state.queue.length === 0) rebuildQueue();
  state.current = state.queue.shift();
  return state.current;
}

// ============ 子ども層: とびら遊び ============
const stage = document.getElementById("stage");
const door = document.getElementById("door");
const reveal = document.getElementById("reveal");
const nameLabel = document.getElementById("nameLabel");
const sparkles = document.getElementById("sparkles");

function renderItem(item) {
  reveal.classList.remove("pop");
  if (item.builtin) {
    reveal.innerHTML = item.svg;
  } else {
    reveal.innerHTML = "";
    const img = document.createElement("img");
    img.src = getPhotoUrl(item);
    img.alt = "";
    img.draggable = false;
    reveal.appendChild(img);
  }
}

const photoUrlCache = new Map();
function getPhotoUrl(item) {
  if (!photoUrlCache.has(item.id)) {
    photoUrlCache.set(item.id, URL.createObjectURL(item.photo));
  }
  return photoUrlCache.get(item.id);
}

function playVoice(item) {
  if (!state.soundOn || item.builtin || !item.audio) return;
  if (!audioUrlCache.has(item.id)) {
    audioUrlCache.set(item.id, URL.createObjectURL(item.audio));
  }
  audioPlayer.src = audioUrlCache.get(item.id);
  // ユーザーのタップ起点なので iOS でも再生できる。失敗は無視（無音でも遊びは成立）
  audioPlayer.play().catch(() => {});
}

function burstSparkles() {
  const emojis = ["✨", "⭐️", "🎈", "💛"];
  for (let i = 0; i < 8; i++) {
    const s = document.createElement("span");
    s.className = "spark";
    s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    s.style.left = 35 + Math.random() * 30 + "%";
    s.style.top = 30 + Math.random() * 30 + "%";
    s.style.setProperty("--dx", (Math.random() - 0.5) * 60 + "vmin");
    s.style.setProperty("--dy", (Math.random() - 0.8) * 50 + "vmin");
    sparkles.appendChild(s);
    setTimeout(() => s.remove(), 1100);
  }
}

let swapTimer = null;

function openDoor() {
  state.doorOpen = true;
  // 閉じアニメ中の再オープンなら、予約済みの中身すり替えをキャンセル
  // （開いている最中に写真が別人に変わるのを防ぐ。同じ子がもう一度出るのは正しい挙動）
  clearTimeout(swapTimer);
  swapTimer = null;
  door.classList.add("open");
  reveal.classList.add("pop");
  burstSparkles();
  playOpenSound(state.current);
  if (state.current.name) {
    nameLabel.textContent = state.current.name;
    nameLabel.classList.add("show");
  } else {
    nameLabel.textContent = "";
    nameLabel.classList.remove("show");
  }
}

function closeDoor() {
  state.doorOpen = false;
  door.classList.remove("open");
  nameLabel.classList.remove("show");
  playCloseSound();
  // とびらが閉まりきってから次のアイテムを仕込み、文字列自体も消す
  // （CSSフェードが効かない環境でも文字が残らないように DOM からも空にする）
  clearTimeout(swapTimer);
  swapTimer = setTimeout(() => {
    nameLabel.textContent = "";
    renderItem(nextItem());
    swapTimer = null;
  }, 580);
}

function onChildTap() {
  if (state.busy) return;
  state.busy = true;
  setTimeout(() => { state.busy = false; }, 350);
  if (state.doorOpen) closeDoor();
  else openDoor();
}

// ============ 長押しゲート（親メニュー / おやすみ解除） ============
const adultBtn = document.getElementById("adultBtn");
const LONG_PRESS_MS = 1800;
let pressTimer = null;
let pressStart = null;
let adultBtnTimer = null;
let longPressFired = false;

function showAdultBtn() {
  adultBtn.classList.remove("hidden");
  clearTimeout(adultBtnTimer);
  adultBtnTimer = setTimeout(() => adultBtn.classList.add("hidden"), 4000);
}

function onPressStart(e) {
  longPressFired = false;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressFired = true;
    if (state.night) exitNight();
    else showAdultBtn();
  }, LONG_PRESS_MS);
}

function onPressMove(e) {
  if (!pressStart) return;
  if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 18) {
    clearTimeout(pressTimer);
  }
}

function onPressEnd() {
  clearTimeout(pressTimer);
  pressStart = null;
}

stage.addEventListener("pointerdown", onPressStart);
stage.addEventListener("pointermove", onPressMove);
stage.addEventListener("pointerup", (e) => {
  onPressEnd();
  if (!longPressFired) onChildTap();
});
stage.addEventListener("pointercancel", onPressEnd);

// ピンチズーム抑止（iOS Safari）
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());

// ============ おやすみモード ============
const night = document.getElementById("night");

function enterNight() {
  state.night = true;
  audioPlayer.pause();
  if ("speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  night.classList.remove("hidden");
  closeParentPanel();
  const stars = document.getElementById("stars");
  if (!stars.childElementCount) {
    for (let i = 0; i < 40; i++) {
      const star = document.createElement("span");
      star.className = "star";
      star.style.left = Math.random() * 100 + "%";
      star.style.top = Math.random() * 100 + "%";
      star.style.animationDelay = Math.random() * 2.4 + "s";
      stars.appendChild(star);
    }
  }
}

function exitNight() {
  state.night = false;
  night.classList.add("hidden");
  showAdultBtn();
}

night.addEventListener("pointerdown", onPressStart);
night.addEventListener("pointermove", onPressMove);
night.addEventListener("pointerup", onPressEnd);
night.addEventListener("pointercancel", onPressEnd);

// ============ 親メニュー ============
const parentPanel = document.getElementById("parentPanel");
adultBtn.addEventListener("click", () => {
  adultBtn.classList.add("hidden");
  parentPanel.classList.remove("hidden");
  renderItemList();
});
document.getElementById("closePanel").addEventListener("click", closeParentPanel);
function closeParentPanel() {
  parentPanel.classList.add("hidden");
  resetRegForm();
}

// --- 設定 ---
const soundToggle = document.getElementById("soundToggle");
soundToggle.checked = state.soundOn;
soundToggle.addEventListener("change", () => {
  state.soundOn = soundToggle.checked;
  localStorage.setItem("soundOn", state.soundOn ? "1" : "0");
});
document.getElementById("goodnightBtn").addEventListener("click", enterNight);

// --- 登録フォーム ---
const photoInput = document.getElementById("photoInput");
const regPreviewWrap = document.getElementById("regPreviewWrap");
const regPreview = document.getElementById("regPreview");
const regName = document.getElementById("regName");
const recBtn = document.getElementById("recBtn");
const recPlayBtn = document.getElementById("recPlayBtn");

let pendingPhoto = null; // Blob
let pendingAudio = null; // Blob
let recorder = null;
let recStopTimer = null;

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  try {
    pendingPhoto = await resizeImage(file, 1200);
    regPreview.src = URL.createObjectURL(pendingPhoto);
    regPreviewWrap.classList.remove("hidden");
  } catch (err) {
    alert("写真を読み込めませんでした: " + err.message);
  }
});

function resizeImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("変換失敗"))),
        "image/jpeg",
        0.85
      );
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("画像を開けません"));
    img.src = URL.createObjectURL(file);
  });
}

recBtn.addEventListener("click", async () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert("この環境では録音できません（iOS 14.3以降のSafariで開いてください）");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      pendingAudio = new Blob(chunks, { type: recorder.mimeType || "audio/mp4" });
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(recStopTimer);
      recBtn.textContent = "🎙 とりなおす";
      recBtn.classList.remove("recording");
      recPlayBtn.classList.remove("hidden");
    };
    recorder.start();
    recBtn.textContent = "⏹ とめる（ろくおんちゅう）";
    recBtn.classList.add("recording");
    recStopTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 10000); // 最長10秒
  } catch (err) {
    alert("マイクを使えませんでした。設定でマイクの許可を確認してください。");
  }
});

recPlayBtn.addEventListener("click", () => {
  if (!pendingAudio) return;
  const url = URL.createObjectURL(pendingAudio);
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  a.play().catch(() => {});
});

document.getElementById("saveItemBtn").addEventListener("click", async () => {
  if (!pendingPhoto) {
    alert("写真を選んでください");
    return;
  }
  const item = {
    id: crypto.randomUUID(),
    name: regName.value.trim(),
    photo: pendingPhoto,
    audio: pendingAudio,
    createdAt: Date.now(),
  };
  await putItem(item);
  state.items.push(item);
  rebuildQueue();
  resetRegForm();
  renderItemList();
});

document.getElementById("cancelRegBtn").addEventListener("click", resetRegForm);

function resetRegForm() {
  pendingPhoto = null;
  pendingAudio = null;
  if (recorder && recorder.state === "recording") recorder.stop();
  photoInput.value = "";
  regName.value = "";
  regPreviewWrap.classList.add("hidden");
  recBtn.textContent = "🎙 こえを ろくおん";
  recBtn.classList.remove("recording");
  recPlayBtn.classList.add("hidden");
}

// --- 登録済みリスト ---
function renderItemList() {
  const list = document.getElementById("itemList");
  const hint = document.getElementById("noItemsHint");
  document.getElementById("itemCount").textContent = state.items.length;
  hint.classList.toggle("hidden", state.items.length > 0);
  list.innerHTML = "";
  for (const item of state.items) {
    const row = document.createElement("div");
    row.className = "item-row";

    const img = document.createElement("img");
    img.src = getPhotoUrl(item);
    row.appendChild(img);

    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = item.name || "（なまえなし）";
    if (!item.audio) name.textContent += " 🔇こえ未登録";
    row.appendChild(name);

    if (item.audio) {
      const play = document.createElement("button");
      play.className = "btn";
      play.textContent = "▶";
      play.addEventListener("click", () => {
        if (!audioUrlCache.has(item.id)) {
          audioUrlCache.set(item.id, URL.createObjectURL(item.audio));
        }
        audioPlayer.src = audioUrlCache.get(item.id);
        audioPlayer.play().catch(() => {});
      });
      row.appendChild(play);
    }

    const del = document.createElement("button");
    del.className = "btn ghost";
    del.textContent = "🗑";
    del.addEventListener("click", async () => {
      if (!confirm(`「${item.name || "なまえなし"}」を削除しますか？`)) return;
      await deleteItem(item.id);
      state.items = state.items.filter((i) => i.id !== item.id);
      for (const cache of [photoUrlCache, audioUrlCache]) {
        if (cache.has(item.id)) {
          URL.revokeObjectURL(cache.get(item.id));
          cache.delete(item.id);
        }
      }
      rebuildQueue();
      renderItemList();
    });
    row.appendChild(del);

    list.appendChild(row);
  }
}

// ============ 起動 ============
(async function init() {
  try {
    db = await openDb();
    state.items = (await loadItems()) || [];
  } catch (err) {
    // DB が開けなくても内蔵イラストだけで遊べるようにする
    console.error("IndexedDB error:", err);
    state.items = [];
  }
  rebuildQueue();
  renderItem(nextItem());

  // 端末内ストレージの永続化を要求（iOSのデータ削除対策）
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
