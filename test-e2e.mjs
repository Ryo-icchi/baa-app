// ばあ！アプリの E2E スモークテスト（ヘッドレスChrome + CDP・Node組み込みWebSocket使用）
// 前提: python3 -m http.server 8899 (アプリ) + Chrome --headless --remote-debugging-port=9333
const CDP = "http://127.0.0.1:9333";
const APP = "http://127.0.0.1:8899/index.html";

// ⚠️ 同アプリの残留タブを先に閉じる: 残ったタブの IndexedDB 接続が deleteDatabase を
//    永久ブロックし、リロード後の indexedDB.open がハングする（2026-06-12 実際に発生）
const existing = await (await fetch(`${CDP}/json/list`)).json();
for (const t of existing) {
  if (t.type === "page" && t.url.includes("127.0.0.1:8899")) {
    await fetch(`${CDP}/json/close/${t.id}`);
  }
}

const res = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" });
const target = await res.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    if (await evalJs("document.readyState === 'complete' && typeof state !== 'undefined' && state.current !== null").catch(() => false)) return;
    await sleep(200);
  }
}

await send("Runtime.enable");
await send("Page.enable");
await waitReady();

// テストをべき等にするため毎回 DB・SWキャッシュを初期化してリロード
// ⚠️ SWキャッシュ削除は必須: cache-first SW が前回テスト時の古い app.js を返し
//    「最新コードを検証したつもり」になる（2026-06-12 実際に発生）
// ⚠️ deleteDatabase の前に必ず db.close(): 接続を開いたまま消すと blocked になり
//    リロード後の新接続とレースして保存系テストが壊れる（2026-06-12 実際に発生）
await evalJs(`(async () => {
  try { if (db) db.close(); } catch (e) {}
  await new Promise(r => { const q = indexedDB.deleteDatabase('baa-db'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  await caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  return true;
})()`, true);
await send("Page.reload");
await sleep(1200);
await waitReady();

console.log("1. 初期化");
check("state が存在", await evalJs("typeof state === 'object'"));
check("再生キューが構築済み", await evalJs("state.queue.length >= 0 && state.current !== null"));
check("とびらの奥にコンテンツ描画済み", await evalJs("document.getElementById('reveal').innerHTML.length > 10"));
check("内蔵どうぶつ8種（すべてオリジナルSVG）", await evalJs("BUILTINS.length === 8 && BUILTINS.every(b => b.svg && !b.img)"));
check("初期状態でとびらは閉", await evalJs("state.doorOpen === false"));

console.log("2. 内蔵イラストの描画");
await evalJs("state.current = BUILTINS[5]; renderItem(BUILTINS[5])"); // ぺんぎん
await sleep(300);
check("内蔵SVGが描画される", await evalJs("!!document.querySelector('#reveal svg')"));
await evalJs("state.current = BUILTINS[0]; renderItem(BUILTINS[0])");
check("くまさんもSVGで描画", await evalJs("!!document.querySelector('#reveal svg rect')"));

console.log("3. タップ → とびら開閉");
await evalJs("onChildTap()");
check("1タップ目でとびらが開く", await evalJs("state.doorOpen === true && document.getElementById('door').classList.contains('open')"));
check("ポップアニメ発動", await evalJs("document.getElementById('reveal').classList.contains('pop')"));
check("キラキラ生成", await evalJs("document.querySelectorAll('.spark').length > 0"));
check("なまえ表示", await evalJs("document.getElementById('nameLabel').classList.contains('show')"));
const firstId = await evalJs("state.current.id");
await sleep(400);
await evalJs("onChildTap()");
check("2タップ目でとびらが閉じる", await evalJs("state.doorOpen === false"));
await sleep(700);
check("次のアイテムに切り替わる", (await evalJs("state.current.id")) !== firstId);
check("閉じた後はラベル文字列も空", await evalJs("document.getElementById('nameLabel').textContent === '' && getComputedStyle(document.getElementById('nameLabel')).visibility === 'hidden'"));

console.log("4. 連打ガード");
await evalJs("onChildTap()");
const openNow = await evalJs("state.doorOpen");
await evalJs("onChildTap()");
check("連打は無視される", (await evalJs("state.doorOpen")) === openNow);
await sleep(400);
if (await evalJs("state.doorOpen")) { await evalJs("onChildTap()"); await sleep(700); }

console.log("5. 閉じアニメ中の再オープン（レース）");
await evalJs("onChildTap()"); await sleep(500);
const raceId = await evalJs("state.current.id");
await evalJs("onChildTap()"); await sleep(400);   // 閉じ開始（580ms窓内）
await evalJs("onChildTap()"); await sleep(800);   // 即再オープン
check("再オープンで同じアイテムが維持される", (await evalJs("state.current.id")) === raceId);
await evalJs("onChildTap()"); await sleep(700);   // 閉じて次へ

console.log("6. 親メニューゲート");
await evalJs("showAdultBtn()");
check("おとなボタン出現", await evalJs("!document.getElementById('adultBtn').classList.contains('hidden')"));
await evalJs("document.getElementById('adultBtn').click()");
check("親メニューが開く", await evalJs("!document.getElementById('parentPanel').classList.contains('hidden')"));

console.log("7. アイテム登録（IndexedDB保存）");
await evalJs(`new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 100;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f80'; ctx.fillRect(0, 0, 100, 100);
  canvas.toBlob((blob) => { pendingPhoto = blob; resolve(true); }, 'image/jpeg');
})`, true);
await evalJs("document.getElementById('regName').value = 'てすと'");
await evalJs("document.getElementById('saveItemBtn').click()");
await sleep(500);
check("state.items に追加", await evalJs("state.items.length === 1 && state.items[0].name === 'てすと'"));
check("一覧に表示", await evalJs("document.querySelectorAll('.item-row').length === 1"));
check("カウント更新", await evalJs("document.getElementById('itemCount').textContent === '1'"));

console.log("8. リロード後の永続化（IndexedDB）");
await send("Page.reload");
await sleep(1500);
await waitReady();
check("リロード後も登録アイテムが残る", await evalJs("state.items.length === 1 && state.items[0].name === 'てすと'"));
check("写真Blobも復元", await evalJs("state.items[0].photo instanceof Blob && state.items[0].photo.size > 0"));
check("キューは登録1+内蔵8の9件", await evalJs("state.queue.length + 1 === 9")); // current に1件出ている

console.log("9. おやすみモード");
await evalJs("enterNight()");
check("おやすみ画面表示", await evalJs("!document.getElementById('night').classList.contains('hidden')"));
check("星が生成される", await evalJs("document.querySelectorAll('.star').length === 40"));
await evalJs("exitNight()");
check("長押しで解除", await evalJs("document.getElementById('night').classList.contains('hidden')"));

console.log("10. Service Worker / オフライン資産");
await sleep(1000);
check("SW登録成功", await evalJs("navigator.serviceWorker.getRegistration().then(r => !!r)", true));

console.log("11. サウンド");
check("動物8種すべてに音程が定義されている", await evalJs("BUILTINS.every(b => typeof ANIMAL_NOTES[b.id] === 'number')"));
check("soundOff時はオシレータを作らない", await evalJs(`(() => {
  state.soundOn = false;
  // 既存ctxがあればスパイ、なければ未生成のまま（どちらも0本）
  let count = 0;
  if (audioCtx) { const o = audioCtx.createOscillator.bind(audioCtx); audioCtx.createOscillator = () => { count++; return o(); }; }
  playOpenSound(BUILTINS[0]);
  return count === 0;
})()`));
check("soundOn時は ぽよん+アルペジオ で5本以上のオシレータ", await evalJs(`(() => {
  state.soundOn = true;
  const ctx = getAudioCtx();
  if (!ctx) return false;
  let count = 0;
  const o = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => { count++; return o(); };
  playOpenSound(BUILTINS[0]); // くま（録音なし）→ pop(1) + jingle(4) = 5
  ctx.createOscillator = o;
  return count >= 5;
})()`));
check("閉じる音も鳴る（オシレータ生成・例外なし）", await evalJs(`(() => {
  state.soundOn = true;
  const ctx = getAudioCtx();
  let count = 0;
  const o = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => { count++; return o(); };
  try { playCloseSound(); } catch (e) { return false; }
  ctx.createOscillator = o;
  return count === 1;
})()`));
check("名前よみあげ関数が例外を投げない", await evalJs("(() => { try { speakName('てすと'); return true; } catch (e) { return false; } })()"));

console.log(`\n結果: ${pass} passed / ${fail} failed`);
ws.close();
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
process.exit(fail > 0 ? 1 : 0);
