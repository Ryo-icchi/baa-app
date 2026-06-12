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

// ============ 内蔵イラスト（オリジナルのどうぶつ・著作物なし） ============
function animalSvg(bg, face) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="${bg}"/>${face}</svg>`;
}
const EYES = (y = 46) =>
  `<circle cx="38" cy="${y}" r="3.5" fill="#3a2a1a"/><circle cx="62" cy="${y}" r="3.5" fill="#3a2a1a"/>`;
const BUILTINS = [
  {
    id: "builtin-bear", builtin: true, name: "くまさん",
    svg: animalSvg("#ffe2b8", `
      <circle cx="28" cy="26" r="11" fill="#b07a45"/><circle cx="72" cy="26" r="11" fill="#b07a45"/>
      <circle cx="28" cy="26" r="5" fill="#e8b888"/><circle cx="72" cy="26" r="5" fill="#e8b888"/>
      <circle cx="50" cy="52" r="30" fill="#b07a45"/>
      <ellipse cx="50" cy="62" rx="13" ry="10" fill="#e8b888"/>
      ${EYES()}<ellipse cx="50" cy="58" rx="4.5" ry="3.5" fill="#3a2a1a"/>
      <path d="M50 62 q-5 6 -9 2 M50 62 q5 6 9 2" stroke="#3a2a1a" stroke-width="2" fill="none" stroke-linecap="round"/>`),
  },
  {
    id: "builtin-cat", builtin: true, name: "ねこさん",
    svg: animalSvg("#dff3ff", `
      <path d="M22 36 L26 12 L44 26 Z" fill="#8a8a8a"/><path d="M78 36 L74 12 L56 26 Z" fill="#8a8a8a"/>
      <circle cx="50" cy="54" r="29" fill="#a8a8a8"/>
      ${EYES(48)}<path d="M46 58 l4 4 l4 -4" stroke="#3a2a1a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M20 52 h16 M20 60 h16 M64 52 h16 M64 60 h16" stroke="#777" stroke-width="2" stroke-linecap="round"/>
      <ellipse cx="50" cy="55" rx="3.5" ry="2.5" fill="#e88"/>`),
  },
  {
    id: "builtin-rabbit", builtin: true, name: "うさぎさん",
    svg: animalSvg("#ffe4ef", `
      <ellipse cx="36" cy="18" rx="9" ry="20" fill="#fff"/><ellipse cx="64" cy="18" rx="9" ry="20" fill="#fff"/>
      <ellipse cx="36" cy="18" rx="4" ry="13" fill="#ffc4d8"/><ellipse cx="64" cy="18" rx="4" ry="13" fill="#ffc4d8"/>
      <circle cx="50" cy="56" r="28" fill="#fff"/>
      ${EYES(50)}<ellipse cx="50" cy="58" rx="3.5" ry="2.5" fill="#e88"/>
      <path d="M46 64 q4 4 8 0" stroke="#3a2a1a" stroke-width="2" fill="none" stroke-linecap="round"/>`),
  },
  {
    id: "builtin-chick", builtin: true, name: "ひよこさん",
    svg: animalSvg("#fff7d6", `
      <circle cx="50" cy="54" r="29" fill="#ffd94d"/>
      <path d="M46 22 q4 -8 8 0" stroke="#e8b800" stroke-width="3" fill="none" stroke-linecap="round"/>
      ${EYES(48)}<path d="M44 58 L50 64 L56 58 Z" fill="#ff9c3f"/>`),
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
    img.alt = item.name || "";
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

function openDoor() {
  state.doorOpen = true;
  door.classList.add("open");
  reveal.classList.add("pop");
  burstSparkles();
  playVoice(state.current);
  if (state.current.name) {
    nameLabel.textContent = state.current.name;
    nameLabel.classList.add("show");
  }
}

function closeDoor() {
  state.doorOpen = false;
  door.classList.remove("open");
  nameLabel.classList.remove("show");
  // とびらが閉まりきってから次のアイテムを仕込む
  setTimeout(() => renderItem(nextItem()), 580);
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
