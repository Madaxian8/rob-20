"use strict";
/* rob-20 铭文平台 前端 — 纯原生 JS，零外部依赖
 * API 同源（索引器提供）；钱包经 EIP-6963 多钱包发现（Rainbow/MetaMask/Coinbase…），
 * 回退到注入的 window.ethereum。
 */

// ---------------- 常量 ----------------
const CHAIN_ID_HEX = "0x1237"; // 4663 Robinhood Chain
// 钱包 wallet_addEthereumChain 用公共 RPC——切勿在此放带 key 的 drpc 端点，
// 否则 key 会暴露给每个访客并被盗刷。后端索引器/部署另用 drpc（见 config.json）。
const CHAIN_PARAMS = {
  chainId: "0x1237",
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};
const EXPLORER = "https://robinhoodchain.blockscout.com";
const SEL_DEPLOY = "0x0925e6b6"; // deployTick(string,uint64,uint128,uint32,uint128)
const SEL_BUY = "0xd96a094a";    // buy(uint256)
const SEL_CANCEL = "0x40e58ee5"; // cancel(uint256)
const SEL_SWEEP = "0x98b02275";  // sweep(uint256[])
const SEL_PLACEBID = "0xc7df5882"; // placeBid(string,uint128,uint128)
const SEL_CANCELBID = "0x9703ef35"; // cancelBid(uint256)
// Memes launchpad
const SEL_LAUNCH = "0x98110acd";           // launch(string,string,string,uint256)
const SEL_WITHDRAW_CREATOR = "0x38a6fc32"; // withdrawCreator(address)
const SEL_WITHDRAW_TREASURY = "0xf86c9e9a"; // withdrawTreasury(address)
const SEL_PENDING_CREATOR = "0x72d1ae54";  // pendingCreator()
const SEL_PENDING_TREASURY = "0x2ed6b75d"; // pendingTreasury()
const SEL_CREATOR = "0x02d05d3f";          // creator()
const SEL_TREASURY = "0x61d027b3";         // treasury()
const MEME_SUPPLY = 1000000000n * (10n ** 18n); // 1e27, used as launch maxTokenAmount bound
const FEE_BPS = 500n;            // 买卖双边各 5%
const MAX_SWEEP = 50;            // 合约单笔扫单上限

// ---------------- 全局状态 ----------------
let HUB = null;
let MARKET = null;
let LAUNCHPAD = null; // Memes 发射台工厂地址（部署后由 /api/status 下发）
let account = null;          // 已连接地址（小写）
let currentUpdate = null;    // 当前页面的数据刷新函数
let navToken = 0;            // 每次路由切换自增；异步 update() 用它判断是否已过期
let pollTimers = [];
let listingById = new Map(); // 最近渲染的挂单，供买入/撤单使用
let ticksCache = [];

const app = document.getElementById("app");
const $ = (sel, el = document) => el.querySelector(sel);

// ---------------- 工具函数 ----------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 十进制整数字符串加千分位（BigInt 安全）
function fmtInt(s) {
  return String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// wei(BigInt|string) -> ETH 字符串，去掉尾随零
function fmtEth(wei) {
  let v = BigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const int = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + fmtInt(int.toString()) + (frac ? "." + frac : "");
}

// ETH 十进制字符串 -> wei BigInt；非法返回 null
function parseEth(str) {
  str = String(str ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const [i, f = ""] = str.split(".");
  if (f.length > 18) return null;
  return BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}

// 浮点显示（单价等），保留有效位并去尾零
function fmtFloat(x) {
  if (!isFinite(x) || x === 0) return "0";
  if (x >= 1e15 || x < 1e-9) return x.toExponential(4);
  let s = x < 1 ? x.toFixed(12) : x.toFixed(6);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function short(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "-";
}

function addrLink(addr) {
  return `<a class="addr-link" href="${EXPLORER}/address/${esc(addr)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${short(esc(addr))}</a>`;
}
function txLink(hash, label) {
  return `<a class="addr-link" href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(label || short(hash))}</a>`;
}

// UTF-8 字符串 -> 0x 十六进制（铭文均为 ASCII）
function utf8ToHex(s) {
  const bytes = new TextEncoder().encode(s);
  let h = "0x";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h;
}

// 32 字节 ABI word（大端左补零）
function abiWord(v) {
  return BigInt(v).toString(16).padStart(64, "0");
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { msg = (await r.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// ---------------- Custom dropdown (themed replacement for <select>) ----------------
function customSelect(opts, current, onChange) {
  const el = document.createElement("div");
  el.className = "cselect";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn";
  const pop = document.createElement("div");
  pop.className = "cs-pop";
  pop.hidden = true;
  el.append(btn, pop);
  let cur = current;
  let open = false;
  const labelOf = (v) => { const o = opts.find((x) => x.value === v); return o ? o.label : ""; };
  function render() {
    btn.innerHTML = `<span class="cs-val">${esc(labelOf(cur) || "")}</span><span class="cs-arrow">▾</span>`;
    pop.innerHTML = opts.map((o) =>
      `<button type="button" class="cs-opt${o.value === cur ? " sel" : ""}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join("");
  }
  // Outside-close via a capture-phase pointerdown on document, attached ONLY
  // while open (removed on close, so it never accumulates). pointerdown fires
  // before click, so it can't race the opening click, and works with real mice
  // and touch alike.
  function onOutside(e) { if (!el.contains(e.target)) close(); }
  function openPop() {
    if (open) return;
    open = true; pop.hidden = false;
    document.addEventListener("pointerdown", onOutside, true);
  }
  function close() {
    if (!open) return;
    open = false; pop.hidden = true;
    document.removeEventListener("pointerdown", onOutside, true);
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); open ? close() : openPop(); });
  pop.addEventListener("click", (e) => {
    const o = e.target.closest("[data-v]");
    if (!o) return;
    cur = o.dataset.v; close(); render();
    if (onChange) onChange(cur);
  });
  render();
  el.getValue = () => cur;
  el.setValue = (v) => { cur = v; render(); };
  // rebuilding options must NOT change the open state
  el.setOptions = (newOpts, keep) => { opts = newOpts; if (keep !== undefined) cur = keep; render(); };
  return el;
}

// ---------------- Toast ----------------
function toast(html, type = "", ttl = 6000) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = html;
  el.addEventListener("click", (e) => { if (e.target.tagName !== "A") el.remove(); });
  box.appendChild(el);
  if (ttl > 0) setTimeout(() => el.remove(), ttl);
}
function toastTx(hash) {
  toast(`Transaction submitted, waiting for confirmation<br>${txLink(hash)}`, "ok", 15000);
}
function txError(e) {
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) {
    toast("Cancelled: request rejected by user", "err");
  } else {
    const msg = (e && (e.shortMessage || e.message)) || String(e);
    toast("Action failed: " + esc(msg).slice(0, 300), "err", 9000);
  }
}

// ---------------- 钱包（EIP-6963 多钱包发现）----------------
const wallets = new Map(); // rdns -> { info:{uuid,name,icon,rdns}, provider }
let wallet = null;         // 当前选中的 EIP-1193 provider
const LS_WALLET = "rob20_wallet";

// 监听各钱包（Rainbow / MetaMask / Coinbase…）的广播并请求发现
window.addEventListener("eip6963:announceProvider", (e) => {
  if (e.detail && e.detail.info) wallets.set(e.detail.info.rdns, e.detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

// 可选钱包列表：EIP-6963 自动发现（Rainbow/MetaMask/OKX/Coinbase… 谁装了谁出现），
// 再补上已知的“专用注入”（部分钱包不广播 6963，如 window.okxwallet），按名字去重。
function walletOptions() {
  const byName = new Map(); // name(lower) -> {info, provider}
  const put = (info, provider) => {
    if (!provider) return;
    const k = (info.name || "").toLowerCase();
    if (!byName.has(k)) byName.set(k, { info, provider });
  };
  // 1) EIP-6963 发现结果（带图标，优先）
  for (const d of wallets.values()) put(d.info, d.provider);
  // 2) 专用注入对象
  if (window.okxwallet) put({ name: "OKX Wallet", icon: "", rdns: "com.okex.wallet" }, window.okxwallet);
  if (window.coinbaseWalletExtension) put({ name: "Coinbase Wallet", icon: "", rdns: "com.coinbase.wallet" }, window.coinbaseWalletExtension);
  // 3) window.ethereum（含 providers 多注入数组），按 flag 命名
  const eths = [];
  if (window.ethereum) { eths.push(window.ethereum); if (Array.isArray(window.ethereum.providers)) eths.push(...window.ethereum.providers); }
  for (const p of eths) {
    const name = p.isOkxWallet ? "OKX Wallet" : p.isRainbow ? "Rainbow" : p.isCoinbaseWallet ? "Coinbase Wallet"
      : p.isMetaMask ? "MetaMask" : "Browser Wallet";
    put({ name, icon: "", rdns: "injected:" + name }, p);
  }
  return [...byName.values()];
}

function bindWalletEvents(p) {
  if (!p || !p.on || p._rob20Bound) return;
  p._rob20Bound = true;
  p.on("accountsChanged", (accs) => {
    account = accs && accs[0] ? accs[0].toLowerCase() : null;
    updateWalletUI();
    router();
  });
  p.on("chainChanged", () => { /* 交易时会自动切链 */ });
}

function useWallet(detail) {
  wallet = detail.provider;
  try { localStorage.setItem(LS_WALLET, detail.info.rdns); } catch (_) {}
  bindWalletEvents(wallet);
}

// 弹出钱包选择框，返回选中的 detail（或 null）
function walletModal(opts) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "wallet-modal";
    ov.innerHTML = `
      <div class="wm-box" role="dialog" aria-label="Select wallet">
        <div class="wm-head">Select Wallet<button class="wm-close" aria-label="Close">×</button></div>
        <div class="wm-list">${opts.map((o, i) => `
          <button class="wm-item" data-i="${i}">
            ${o.info.icon ? `<img src="${esc(o.info.icon)}" alt="">` : `<span class="wm-ph"></span>`}
            <span>${esc(o.info.name)}</span>
          </button>`).join("")}</div>
      </div>`;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest(".wm-close")) return done(null);
      const it = e.target.closest(".wm-item");
      if (it) done(opts[Number(it.dataset.i)]);
    });
    document.body.appendChild(ov);
  });
}

function updateWalletUI() {
  const btn = $("#walletBtn");
  if (account) {
    btn.textContent = short(account);
    btn.title = account + " (click for menu)";
    btn.classList.add("connected");
  } else {
    btn.textContent = "Connect Wallet";
    btn.title = "";
    btn.classList.remove("connected");
    closeWalletMenu();
  }
}

// Wallet dropdown menu (address + Disconnect), shown when clicking the connected button.
let walletMenuEl = null;
function onWalletOutside(e) {
  const btn = $("#walletBtn");
  if (walletMenuEl && !walletMenuEl.contains(e.target) && !btn.contains(e.target)) closeWalletMenu();
}
function closeWalletMenu() {
  if (!walletMenuEl) return;
  walletMenuEl.remove();
  walletMenuEl = null;
  document.removeEventListener("click", onWalletOutside);
}
function openWalletMenu() {
  closeWalletMenu();
  const wrap = $("#walletBtn").parentElement;
  const m = document.createElement("div");
  m.className = "wallet-menu";
  m.innerHTML =
    `<div class="wm-addr" title="${esc(account)}">${esc(short(account))}</div>` +
    `<button type="button" class="wm-item" data-act="my">My Orders</button>` +
    `<button type="button" class="wm-item wm-danger" data-act="disc">Disconnect</button>`;
  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "my") { location.hash = "#/me"; closeWalletMenu(); }
    else { disconnectWallet(); }
  });
  wrap.appendChild(m);
  walletMenuEl = m;
  // Attach the outside-close on the NEXT tick so the click that opened the menu
  // (which bubbles to document) can't immediately close it.
  setTimeout(() => document.addEventListener("click", onWalletOutside), 0);
}
function disconnectWallet() {
  account = null;
  wallet = null; // forget the provider so the next connect re-opens the picker
  try { localStorage.removeItem(LS_WALLET); } catch (_) {}
  closeWalletMenu();
  updateWalletUI();
  router();
  toast("Wallet disconnected", "", 3000);
}

async function connectWallet() {
  if (!wallet) {
    const opts = walletOptions();
    if (!opts.length) {
      toast("No wallet detected. Please install a browser wallet such as Rainbow or MetaMask", "err");
      return null;
    }
    const chosen = opts.length === 1 ? opts[0] : await walletModal(opts);
    if (!chosen) return null; // 用户取消
    useWallet(chosen);
  }
  const accs = await wallet.request({ method: "eth_requestAccounts" });
  account = accs && accs[0] ? accs[0].toLowerCase() : null;
  updateWalletUI();
  return account;
}

async function ensureChain() {
  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (e) {
    const code = e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902));
    if (code) {
      await wallet.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
    } else {
      throw e;
    }
  }
}

// 连接 + 切链，返回账户地址
async function ensureWallet() {
  const acc = await connectWallet();
  if (!acc) throw new Error("Wallet not connected");
  await ensureChain();
  return acc;
}

// 通用发交易：处理按钮状态、错误提示、上链后轮询刷新
async function sendTx(tx, btn) {
  let orig;
  try {
    if (btn) { orig = btn.textContent; btn.disabled = true; btn.textContent = "Waiting for wallet…"; }
    const from = await ensureWallet();
    if (!HUB) await refreshStatus();
    const hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from, ...tx }],
    });
    toastTx(hash);
    schedulePolls();
    return hash;
  } catch (e) {
    txError(e);
    return null;
  } finally {
    if (btn) { btn.disabled = false; if (orig) btn.textContent = orig; }
  }
}

// 交易后按递增间隔轮询 API（索引器有确认延迟）
function schedulePolls() {
  for (const t of pollTimers) clearTimeout(t);
  pollTimers = [2000, 5000, 9000, 15000, 25000, 40000].map((ms) =>
    setTimeout(async () => {
      try {
        await refreshStatus();
        if (currentUpdate) await currentUpdate();
      } catch (_) {}
    }, ms));
}

// ---------------- 铭文/合约交易构造 ----------------
function mintTx(t) {
  // amt 必须与注册的 amountPerMint 字符串逐字节一致
  const text = `data:,{"p":"rob-20","op":"mint","tick":"${t.tick}","amt":"${t.amountPerMint}"}`;
  return { to: HUB, value: "0x" + BigInt(t.mintPriceWei).toString(16), data: utf8ToHex(text) };
}
function mintText(t) {
  return `data:,{"p":"rob-20","op":"mint","tick":"${t.tick}","amt":"${t.amountPerMint}"}`;
}
function transferTx(to, tick, amt) {
  const text = `data:,{"p":"rob-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`;
  return { to, value: "0x0", data: utf8ToHex(text) };
}
function listTx(tick, amt, priceWei) {
  const text = `data:,{"p":"rob-20","op":"list","tick":"${tick}","amt":"${amt}","price":"${priceWei}"}`;
  return { to: MARKET, value: "0x0", data: utf8ToHex(text) };
}
function deployTx(tick, maxMints, amountPerMint, walletLimit, mintPriceWei) {
  // deployTick(string,uint64,uint128,uint32,uint128)
  // head 5 words: [0]=tail 偏移 160, [1..4]=数值参数；tail: 长度 word + tick 字节右补零
  let tickHex = "";
  for (const c of tick) tickHex += c.charCodeAt(0).toString(16).padStart(2, "0");
  const data = SEL_DEPLOY +
    abiWord(160) + abiWord(maxMints) + abiWord(amountPerMint) +
    abiWord(walletLimit) + abiWord(mintPriceWei) +
    abiWord(tick.length) + tickHex.padEnd(64, "0");
  return { to: HUB, value: "0x0", data };
}

// ---- Memes launchpad tx builders + chain reads ----
// ABI-encode a dynamic string tail segment: length word + right-padded bytes.
function abiStr(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return { hex: abiWord(bytes.length) + padded, byteLen: 32 + Math.ceil(bytes.length / 32) * 32 };
}
function launchTx(name, symbol, imageURI, valueWei) {
  // launch(string name, string symbol, string imageURI, uint256 maxTokenAmount)
  const n = abiStr(name), s = abiStr(symbol), im = abiStr(imageURI);
  const off1 = 128; // 4 head words
  const off2 = 128 + n.byteLen;
  const off3 = 128 + n.byteLen + s.byteLen;
  const data = SEL_LAUNCH + abiWord(off1) + abiWord(off2) + abiWord(off3) + abiWord(MEME_SUPPLY) + n.hex + s.hex + im.hex;
  return { to: LAUNCHPAD, value: "0x" + BigInt(valueWei).toString(16), data };
}

// Upload an image to the indexer, which pins it to IPFS; returns { cid, ipfs, url }.
async function pinAvatar(file) {
  const dataB64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(file);
  });
  const resp = await fetch("/api/memes/pin", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataB64 }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ipfs) throw new Error(j.error || "image pinning failed");
  return j;
}

// Pin a metadata JSON object to IPFS; returns { cid, ipfs, url }.
async function pinJson(obj) {
  const resp = await fetch("/api/memes/pin-json", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: obj }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ipfs) throw new Error(j.error || "metadata pinning failed");
  return j;
}
function withdrawCreatorTx(token, to) {
  return { to: token, value: "0x0", data: SEL_WITHDRAW_CREATOR + abiWord(to) };
}
function withdrawTreasuryTx(token, to) {
  return { to: token, value: "0x0", data: SEL_WITHDRAW_TREASURY + abiWord(to) };
}
// eth_call via the connected wallet (current chain) if available, else the public RPC.
async function readCall(to, data) {
  const params = [{ to, data }, "latest"];
  if (wallet && account) {
    try { return await wallet.request({ method: "eth_call", params }); } catch (_) {}
  }
  const res = await fetch(CHAIN_PARAMS.rpcUrls[0], {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const readBig = (hex) => (hex && hex !== "0x" ? BigInt(hex) : 0n);

function buyTx(id, priceWei) {
  const price = BigInt(priceWei);
  const pay = price + (price * FEE_BPS) / 10000n; // 买家实付 = price * 1.05（向下取整）
  return { to: MARKET, value: "0x" + pay.toString(16), data: SEL_BUY + abiWord(id) };
}
function cancelTx(id) {
  return { to: MARKET, value: "0x0", data: SEL_CANCEL + abiWord(id) };
}
function sweepTx(ids, payWei) {
  // sweep(uint256[]): selector + offset(0x20) + length + ids...
  let data = SEL_SWEEP + abiWord(32) + abiWord(ids.length);
  for (const id of ids) data += abiWord(id);
  return { to: MARKET, value: "0x" + BigInt(payWei).toString(16), data };
}
// placeBid(string,uint128,uint128): escrow = price + 5%
function placeBidTx(tick, amt, priceWei) {
  let tickHex = "";
  for (const c of tick) tickHex += c.charCodeAt(0).toString(16).padStart(2, "0");
  const data = SEL_PLACEBID + abiWord(96) + abiWord(amt) + abiWord(priceWei) +
    abiWord(tick.length) + tickHex.padEnd(64, "0");
  return { to: MARKET, value: "0x" + buyerPays(priceWei).toString(16), data };
}
function cancelBidTx(id) {
  return { to: MARKET, value: "0x0", data: SEL_CANCELBID + abiWord(id) };
}
// accept: a holder delivers into a bid by sending the accept inscription to the bidder
function acceptTx(bidder, tick, bidId) {
  const text = `data:,{"p":"rob-20","op":"accept","tick":"${tick}","bid":"${bidId}"}`;
  return { to: bidder, value: "0x0", data: utf8ToHex(text) };
}
// 从最便宜的卖单起累加，凑够目标数量；跳过自己的挂单，最多 MAX_SWEEP 手
function computeSweep(asks, targetAmt) {
  const target = BigInt(targetAmt);
  if (target <= 0n) return null;
  let cumAmt = 0n, pay = 0n;
  const ids = [];
  for (const a of asks) {
    if (account && a.seller === account) continue; // 不扫自己的单
    if (ids.length >= MAX_SWEEP) break;
    ids.push(a.id);
    cumAmt += BigInt(a.amt);
    pay += buyerPays(a.price);
    if (cumAmt >= target) break;
  }
  if (!ids.length) return null;
  return { ids, totalAmt: cumAmt, totalPay: pay, count: ids.length, filled: cumAmt >= target };
}
const buyerPays = (p) => BigInt(p) + (BigInt(p) * FEE_BPS) / 10000n;
const sellerGets = (p) => BigInt(p) - (BigInt(p) * FEE_BPS) / 10000n;

// ---------------- 状态栏 ----------------
async function refreshStatus() {
  try {
    const s = await api("/api/status");
    HUB = s.hub;
    MARKET = s.market;
    LAUNCHPAD = s.launchpad || null;
    return s;
  } catch (_) {
    return null;
  }
}

// ---------------- 共用渲染 ----------------
function progressHtml(total, max, big) {
  const pct = max > 0 ? Math.min(100, (total / max) * 100) : 0;
  return `
    <div class="prog${big ? " big" : ""}"><div class="prog-fill" style="width:${pct.toFixed(2)}%"></div></div>
    <div class="prog-label">${fmtInt(String(total))} / ${fmtInt(String(max))} (${pct.toFixed(1)}%)</div>`;
}

function statusPill(t) {
  return t.soldOut
    ? '<span class="pill pill-done">Sold Out</span>'
    : '<span class="pill pill-live">Live</span>';
}

function priceLabel(wei) {
  return BigInt(wei) === 0n ? "Free" : fmtEth(wei) + " ETH";
}

function listingStatus(l) {
  if (l.chainStatus === "pending") {
    return l.escrow === "valid"
      ? '<span class="pill pill-warn">Pending Confirmation</span>'
      : '<span class="pill pill-red">Escrow Invalid</span>';
  }
  if (l.chainStatus === "active") return '<span class="pill pill-live">Listed</span>';
  if (l.chainStatus === "sold") return '<span class="pill pill-blue">Sold</span>';
  return '<span class="pill pill-done">Cancelled</span>';
}

function listingCard(l) {
  const price = BigInt(l.price);
  const unit = Number(price) / 1e18 / Number(l.amt || 1);
  const mine = account && l.seller === account;
  let action = "";
  if (mine && (l.chainStatus === "pending" || l.chainStatus === "active")) {
    action = `<button class="btn btn-danger" data-cancel="${l.id}">Cancel</button>`;
  } else if (l.chainStatus === "active") {
    action = `<button class="btn btn-primary" data-buy="${l.id}">Buy · Pay ${fmtEth(buyerPays(price))} ETH</button>`;
  }
  return `
  <div class="card listing">
    <div class="l-head">
      <span class="tick-badge">${esc(l.tick || "?")}</span>
      ${listingStatus(l)}
    </div>
    <div class="l-amt">${fmtInt(l.amt)} <span>${esc(l.tick || "")}</span></div>
    <div class="l-row"><span class="k">Total</span><span class="v hl">${fmtEth(price)} ETH</span></div>
    <div class="l-row"><span class="k">Unit Price</span><span class="v">${fmtFloat(unit)} ETH</span></div>
    <div class="l-row"><span class="k">Seller</span><span class="v">${mine ? "Me" : addrLink(l.seller)}</span></div>
    <div class="l-row"><span class="k">Listing</span><span class="v">#${l.id} · ${txLink(l.listTx)}</span></div>
    ${l.buyer ? `<div class="l-row"><span class="k">Buyer</span><span class="v">${addrLink(l.buyer)}</span></div>` : ""}
    ${action}
  </div>`;
}

// 挂单容器的买入/撤单事件委托
function bindListingActions(grid) {
  grid.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-buy],[data-cancel]");
    if (!btn) return;
    const id = btn.dataset.buy || btn.dataset.cancel;
    const l = listingById.get(String(id));
    if (!l) return;
    if (btn.dataset.buy) {
      await sendTx(buyTx(l.id, l.price), btn);
    } else {
      await sendTx(cancelTx(l.id), btn);
    }
  });
}

function connectPrompt(msg) {
  return `<div class="card empty">
    <p style="margin-bottom:12px">${esc(msg || "Please connect your wallet first")}</p>
    <button class="btn btn-primary" onclick="connectWalletAndRerender()">Connect Wallet</button>
  </div>`;
}
// 供 connectPrompt 内联调用
window.connectWalletAndRerender = async function () {
  try {
    await connectWallet();
    router();
  } catch (e) { txError(e); }
};

// ---------------- 页面：首页（发现）----------------
const ACT = {
  mint: { label: "Mint", cls: "act-mint" },
  trade: { label: "Trade", cls: "act-trade" },
  list: { label: "List", cls: "act-list" },
  bid: { label: "Bid", cls: "act-bid" },
  deploy: { label: "Deploy", cls: "act-deploy" },
};
function floorUnit(t) { return t.floor ? unitEth(t.floor.price, t.floor.amt) : Infinity; }

async function pageHome() {
  const myNav = navToken;
  let sortKey = "volume", filter = "all", search = "";
  let actType = "all", actPage = 0, actTotal = 0; // activity feed: type filter + pagination

  app.innerHTML = `
    <div class="discover-controls">
      <input id="searchTick" class="mono" placeholder="Search tick…" autocomplete="off" spellcheck="false">
      <div class="filters" id="filters">
        <button data-f="all" class="active">All</button>
        <button data-f="live">Live</button>
        <button data-f="soldout">Sold Out</button>
        <button data-f="free">Free</button>
        <button data-f="market">Tradable</button>
      </div>
      <div id="sortSelMount"></div>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th>Tick</th><th style="min-width:170px">Mint Progress</th><th>Floor / Unit</th>
          <th>Volume</th><th>Holders</th><th>Status</th>
        </tr></thead>
        <tbody id="tickRows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>Activity</h2>
        <div class="filters" id="actFilters">
          <button data-at="all" class="active">All</button>
          <button data-at="mint">Mint</button>
          <button data-at="trade">Trade</button>
          <button data-at="list">List</button>
          <button data-at="bid">Bid</button>
          <button data-at="deploy">Deploy</button>
        </div>
      </div>
      <div class="activity" id="activity"><div class="empty small">Loading…</div></div>
      <div class="pager" id="actPager"></div>
    </div>`;

  function renderTicks() {
    let rows = ticksCache.slice();
    if (search) rows = rows.filter((t) => t.tick.includes(search));
    if (filter === "live") rows = rows.filter((t) => !t.soldOut);
    else if (filter === "soldout") rows = rows.filter((t) => t.soldOut);
    else if (filter === "free") rows = rows.filter((t) => BigInt(t.mintPriceWei) === 0n);
    else if (filter === "market") rows = rows.filter((t) => t.listedCount > 0 || t.bidCount > 0);
    const cmp = {
      volume: (a, b) => (BigInt(b.volumeWei) > BigInt(a.volumeWei) ? 1 : BigInt(b.volumeWei) < BigInt(a.volumeWei) ? -1 : 0),
      newest: (a, b) => b.deployBlock - a.deployBlock,
      floor: (a, b) => floorUnit(a) - floorUnit(b),
      holders: (a, b) => b.holders - a.holders,
      progress: (a, b) => b.totalMints / b.maxMints - a.totalMints / a.maxMints,
    }[sortKey];
    rows.sort(cmp);
    $("#tickRows").innerHTML = rows.length ? rows.map((t) => `
      <tr class="clickable" onclick="location.hash='#/tick/${esc(t.tick)}'">
        <td><span class="tick-badge">${esc(t.tick)}</span></td>
        <td>${progressHtml(t.totalMints, t.maxMints)}</td>
        <td class="mono">${t.floor ? fmtFloat(floorUnit(t)) : '<span class="muted">—</span>'}</td>
        <td class="mono">${BigInt(t.volumeWei) > 0n ? fmtEth(t.volumeWei) + " ETH" : '<span class="muted">—</span>'}</td>
        <td class="mono">${fmtInt(String(t.holders))}</td>
        <td>${statusPill(t)}</td>
      </tr>`).join("")
      : `<tr><td colspan="6" class="empty">${ticksCache.length ? "No matching ticks" : 'No ticks yet — <a href="#/deploy">deploy</a> the first one'}</td></tr>`;
  }

  function renderActivity(acts) {
    $("#activity").innerHTML = acts.length ? acts.map((a) => {
      const meta = ACT[a.type] || { label: a.type, cls: "" };
      const unit = a.price && a.amt ? ` @ ${fmtFloat(unitEth(a.price, a.amt))}` : "";
      const detail = a.type === "mint" ? `Mint #${fmtInt(String(a.n))}`
        : a.type === "deploy" ? "Created tick"
        : `${fmtInt(a.amt)} ${esc(a.tick)}${unit}`;
      return `
        <div class="act-row">
          <span class="act-tag ${meta.cls}">${meta.label}</span>
          <a href="#/tick/${esc(a.tick)}" class="act-tick">${esc(a.tick)}</a>
          <span class="act-detail mono">${detail}</span>
          <span class="act-who">${addrLink(a.actor)}</span>
          <span class="act-block mono muted">${txLink(a.tx, "#" + fmtInt(String(a.block)))}</span>
        </div>`;
    }).join("") : `<div class="empty small">No activity</div>`;
  }

  function renderActPager() {
    const pages = Math.max(1, Math.ceil(actTotal / 20));
    if (actPage >= pages) actPage = pages - 1;
    $("#actPager").innerHTML = `
      <button class="btn small" id="actPrev" ${actPage <= 0 ? "disabled" : ""}>← Prev</button>
      <span class="pager-info muted small">Page ${actPage + 1} / ${pages}</span>
      <button class="btn small" id="actNext" ${actPage >= pages - 1 ? "disabled" : ""}>Next →</button>`;
    $("#actPrev").addEventListener("click", () => { if (actPage > 0) { actPage--; updateActivity(); } });
    $("#actNext").addEventListener("click", () => {
      const p = Math.max(1, Math.ceil(actTotal / 20));
      if (actPage < p - 1) { actPage++; updateActivity(); }
    });
  }

  async function updateActivity() {
    const typeParam = actType && actType !== "all" ? actType : ""; // "all" = no filter
    const q = `/api/activity?type=${encodeURIComponent(typeParam)}&offset=${actPage * 20}&limit=20`;
    const av = await api(q);
    if (myNav !== navToken) return;
    actTotal = Number(av.total) || 0;
    renderActivity(av.activity);
    renderActPager();
  }

  async function update() {
    const [td] = await Promise.all([api("/api/ticks"), updateActivity()]);
    if (myNav !== navToken) return;
    ticksCache = td.ticks;
    renderTicks();
  }

  $("#searchTick").addEventListener("input", (e) => { search = e.target.value.trim().toLowerCase(); renderTicks(); });
  $("#sortSelMount").appendChild(customSelect(
    [
      { value: "volume", label: "Volume ↓" },
      { value: "newest", label: "Newest" },
      { value: "floor", label: "Floor ↑" },
      { value: "holders", label: "Holders ↓" },
      { value: "progress", label: "Mint Progress ↓" },
    ],
    sortKey,
    (v) => { sortKey = v; renderTicks(); }
  ));
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    filter = b.dataset.f;
    for (const x of $("#filters").children) x.classList.toggle("active", x === b);
    renderTicks();
  });
  $("#actFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-at]");
    if (!b) return;
    actType = b.dataset.at;
    actPage = 0; // reset to first page on filter change
    for (const x of $("#actFilters").children) x.classList.toggle("active", x === b);
    updateActivity();
  });

  await update();
  currentUpdate = update;
}

// ---------------- 页面：Tick 详情 ----------------
async function pageTick(tick) {
  const myNav = navToken;
  app.innerHTML = `<a class="back-link" href="#/">← Back to Home</a><div id="tickBody"><div class="card empty">Loading…</div></div>`;
  const body = $("#tickBody");

  async function update() {
    let t, hd;
    try {
      [t, hd] = await Promise.all([api("/api/tick/" + encodeURIComponent(tick)), api("/api/tick/" + encodeURIComponent(tick) + "/holders")]);
    } catch (e) {
      if (myNav === navToken) body.innerHTML = `<div class="card error-card">Failed to load: ${esc(e.message)}</div>`;
      return;
    }
    if (myNav !== navToken) return;
    const supply = BigInt(t.totalMints) * BigInt(t.amountPerMint);      // circulating (minted so far)
    const totalSupply = BigInt(t.maxMints) * BigInt(t.amountPerMint);   // full supply (share is measured against this)
    const holders = hd.holders.slice(0, 20);
    body.innerHTML = `
      <h1 class="page-title"><span class="tick-badge" style="font-size:20px">${esc(t.tick)}</span>${statusPill(t)}</h1>

      <div class="card mint-card">
        <div style="margin-bottom:10px">${progressHtml(t.totalMints, t.maxMints, true)}</div>
        <div class="mint-price">Mint price <b>${priceLabel(t.mintPriceWei)}</b> / mint · <b>${fmtInt(t.amountPerMint)}</b> ${esc(t.tick)} each · limit ${fmtInt(String(t.walletLimit))} per wallet</div>
        <button class="btn btn-primary btn-big" id="mintBtn" ${t.soldOut ? "disabled" : ""}>${t.soldOut ? "Sold Out" : "Mint"}</button>
        <div class="hint-box">
          The mint transaction's input data is the raw inscription, viewable on the block explorer:<br>
          <code>${esc(mintText(t))}</code>
        </div>
      </div>

      <div class="card">
        <h2>Parameters</h2>
        <div class="kv-grid">
          <div class="kv"><div class="k">Total Mints</div><div class="v mono">${fmtInt(String(t.maxMints))}</div></div>
          <div class="kv"><div class="k">Minted</div><div class="v mono">${fmtInt(String(t.totalMints))}</div></div>
          <div class="kv"><div class="k">Amount / Mint</div><div class="v mono">${fmtInt(t.amountPerMint)}</div></div>
          <div class="kv"><div class="k">Per-Wallet Limit</div><div class="v mono">${fmtInt(String(t.walletLimit))}</div></div>
          <div class="kv"><div class="k">Mint Price</div><div class="v mono">${priceLabel(t.mintPriceWei)}</div></div>
          <div class="kv"><div class="k">Circulating Supply</div><div class="v mono">${fmtInt(supply.toString())}</div></div>
          <div class="kv"><div class="k">Holders</div><div class="v mono">${fmtInt(String(t.holders))}</div></div>
          <div class="kv"><div class="k">Deploy Block</div><div class="v mono">#${fmtInt(String(t.deployBlock))}</div></div>
          <div class="kv"><div class="k">Deployer</div><div class="v mono">${addrLink(t.deployer)}</div></div>
          <div class="kv"><div class="k">Deploy Tx</div><div class="v mono">${txLink(t.deployTx)}</div></div>
        </div>
      </div>

      <div class="card">
        <h2>Top 20 Holders</h2>
        <div class="tbl-wrap" style="border:none;margin-bottom:0">
          <table class="tbl compact">
            <thead><tr><th>#</th><th>Address</th><th>Balance</th><th>Share</th></tr></thead>
            <tbody>${holders.length ? holders.map((h, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td>${addrLink(h.address)}${account === h.address ? ' <span class="pill pill-live">Me</span>' : ""}</td>
                <td class="mono">${fmtInt(h.balance)}</td>
                <td class="mono muted">${totalSupply > 0n ? fmtFloat(Number(BigInt(h.balance) * 10000n / totalSupply) / 100) + "%" : "-"}</td>
              </tr>`).join("") : '<tr><td colspan="4" class="empty">No holders yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Recent Mints</h2>
        <div class="tbl-wrap" style="border:none;margin-bottom:0">
          <table class="tbl compact"><tbody>${t.recentMints.length ? t.recentMints.map((m) => `
            <tr>
              <td class="mono">Mint #${fmtInt(String(m.n))}</td>
              <td>${addrLink(m.minter)}</td>
              <td>${txLink(m.tx)}</td>
              <td class="mono muted">#${fmtInt(String(m.block))}</td>
            </tr>`).join("") : '<tr><td class="empty">No records yet</td></tr>'}
          </tbody></table>
        </div>
      </div>`;

    const mintBtn = $("#mintBtn");
    if (mintBtn && !t.soldOut) {
      mintBtn.addEventListener("click", () => sendTx(mintTx(t), mintBtn));
    }
  }
  await update();
  currentUpdate = update;
}

// ---------------- 页面：部署 ----------------
async function pageDeploy() {
  app.innerHTML = `
    <div class="narrow-page">
    <h1 class="page-title centered">Deploy Tick</h1>
    <div class="card">
      <form id="deployForm" class="form-grid" novalidate>
        <div class="field">
          <label>Tick Name</label>
          <input class="mono" name="tick" placeholder="1-8 lowercase letters or digits" maxlength="8" autocomplete="off" spellcheck="false">
          <div class="sub">Matches <b>^[a-z0-9]{1,8}$</b>, globally unique, first come first served</div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Total Mints (maxMints)</label>
            <input class="mono" name="maxMints" inputmode="numeric" placeholder="e.g. 10000">
            <div class="sub">1 ~ 1,000,000,000</div>
          </div>
          <div class="field">
            <label>Amount per Mint (amountPerMint)</label>
            <input class="mono" name="amountPerMint" inputmode="numeric" placeholder="e.g. 1000">
            <div class="sub">1 ~ 1,000,000,000,000,000</div>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Per-Wallet Mint Limit</label>
            <input class="mono" name="walletLimit" inputmode="numeric" placeholder="e.g. 10">
            <div class="sub">1 ~ total mints</div>
          </div>
          <div class="field">
            <label>Mint Price (ETH / mint)</label>
            <input class="mono" name="mintPrice" inputmode="decimal" placeholder="0 = free" value="0">
            <div class="sub">0 ~ 100 ETH, proceeds go to the deployer (withdrawable in contract)</div>
          </div>
        </div>
        <button class="btn btn-primary btn-big" type="submit">Deploy Tick</button>
      </form>
    </div>
    </div>`;

  // 预取已注册 tick 用于占用校验
  try { ticksCache = (await api("/api/ticks")).ticks; } catch (_) {}

  $("#deployForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const tick = f.tick.value.trim();
    const maxMints = f.maxMints.value.trim();
    const amountPerMint = f.amountPerMint.value.trim();
    const walletLimit = f.walletLimit.value.trim();
    const priceWei = parseEth(f.mintPrice.value);

    if (!/^[a-z0-9]{1,8}$/.test(tick)) return toast("Tick must be 1-8 lowercase letters or digits", "err");
    if (ticksCache.some((t) => t.tick === tick)) return toast(`Tick "${esc(tick)}" is already registered`, "err");
    if (!/^\d+$/.test(maxMints) || BigInt(maxMints) < 1n || BigInt(maxMints) > 1000000000n)
      return toast("Total mints must be an integer between 1 and 1e9", "err");
    if (!/^\d+$/.test(amountPerMint) || BigInt(amountPerMint) < 1n || BigInt(amountPerMint) > 1000000000000000n)
      return toast("Amount per mint must be an integer between 1 and 1e15", "err");
    if (!/^\d+$/.test(walletLimit) || BigInt(walletLimit) < 1n || BigInt(walletLimit) > BigInt(maxMints))
      return toast("Per-wallet limit must be an integer between 1 and total mints", "err");
    if (priceWei === null || priceWei > 100n * 10n ** 18n)
      return toast("Price must be an ETH value between 0 and 100", "err");

    const btn = f.querySelector("button[type=submit]");
    const hash = await sendTx(
      deployTx(tick, BigInt(maxMints), BigInt(amountPerMint), BigInt(walletLimit), priceWei), btn);
    if (hash) toast(`Deploy transaction sent — "${esc(tick)}" will appear on Home once confirmed`, "ok", 10000);
  });

  currentUpdate = null;
}

// ---------------- 页面：市场（订单簿交易界面）----------------
// 单价（ETH / 每 1 个）— 展示用浮点
function unitEth(priceWei, amt) {
  return Number(BigInt(priceWei)) / 1e18 / Number(amt || 1);
}

async function pageMarket(tickParam) {
  try { ticksCache = (await api("/api/ticks")).ticks; } catch (_) { ticksCache = []; }
  // market tabs: highest trading volume first (tiebreak by trade count)
  ticksCache.sort((a, b) => {
    const av = BigInt(a.volumeWei || "0"), bv = BigInt(b.volumeWei || "0");
    if (av !== bv) return av > bv ? -1 : 1;
    return (b.tradeCount || 0) - (a.tradeCount || 0);
  });
  if (!ticksCache.length) {
    app.innerHTML = `<h1 class="page-title">Market</h1>
      <div class="card empty">No ticks yet — <a href="#/deploy">deploy</a> the first one</div>`;
    currentUpdate = null;
    return;
  }
  const myNav = navToken;
  const selected = ticksCache.some((t) => t.tick === tickParam) ? tickParam : ticksCache[0].tick;
  let market = null;   // 最近一次 /api/market 数据
  let selAskId = null; // 选入买入面板的卖单
  let sweepPlan = null; // 当前扫单方案
  let myBalances = {};
  let priceRange = "all"; // Price 图时间范围（1m/5m/30m/1h/4h/24h/7d/all）

  // A tick can only be traded once it is 100% minted. If not, hide the trading
  // UI and show a gate banner pointing to the mint page.
  const selTick = ticksCache.find((t) => t.tick === selected);
  const tradable = !!(selTick && selTick.soldOut);
  const mintPct = selTick && selTick.maxMints ? Math.floor((selTick.totalMints / selTick.maxMints) * 100) : 0;

  app.innerHTML = `
    <div class="mkt${tradable ? "" : " gated"}">
      <div class="pair-search-wrap">
        <input id="pairSearch" class="pair-search" type="text" inputmode="search" autocomplete="off" placeholder="Search ticker…">
      </div>
      <div class="pair-strip" id="pairStrip"></div>
      <div class="mkt-statbar card" id="statBar"></div>
      ${tradable ? "" : `
      <div class="trade-gate card">
        <span class="tg-lock">🔒</span>
        <div class="tg-text"><b>${esc(selected)}</b> is <b>${mintPct}%</b> minted — trading opens once it reaches <b>100%</b>.</div>
        <a class="btn btn-primary" href="#/tick/${esc(selected)}">Go mint →</a>
      </div>`}
      <div class="mkt-grid">
        <section class="card book-card">
          <div class="card-head"><h2>Order Book</h2><span class="muted small" id="bookMeta"></span></div>
          <div class="book-side-label"><span class="down">Asks</span><span class="muted small">Unit / Amount / Total / Cumulative</span></div>
          <div class="book" id="book"><div class="empty small">Loading…</div></div>
          <div class="book-spread" id="bookSpread"></div>
          <div class="book-side-label"><span class="up">Bids</span><span class="muted small">Highest first · hold to Fill</span></div>
          <div class="book bids" id="bidBook"><div class="empty small">No bids</div></div>
        </section>
        <aside class="mkt-side">
          <div class="card buy-card" id="buyPanel"></div>
          <div class="card bid-card">
            <div class="card-head"><h2>Place Bid</h2><span class="muted small">Escrow ETH to buy</span></div>
            <div class="bid-form-row">
              <input class="mono" id="bidAmt" inputmode="numeric" placeholder="Amount">
              <input class="mono" id="bidPrice" inputmode="decimal" placeholder="Bid ETH (total)">
            </div>
            <div id="bidSummary" class="sweep-summary muted small">Placing a bid escrows your bid + 5% ETH. It fills when a seller accepts; cancel anytime before that for a full refund.</div>
            <button class="btn btn-primary btn-big" id="bidBtn">Place Bid</button>
          </div>
          <div class="card sweep-card">
            <div class="card-head"><h2>Sweep</h2><span class="muted small">Fill from lowest asks</span></div>
            <div class="sweep-input">
              <input class="mono" id="sweepQty" inputmode="numeric" placeholder="Amount to buy">
              <button class="btn btn-primary" id="sweepBtn" disabled>Sweep</button>
            </div>
            <div id="sweepSummary" class="sweep-summary muted small">Enter an amount to auto-fill from the cheapest asks</div>
          </div>
        </aside>
      </div>
      <div class="card trades-card">
        <div class="card-head"><h2>Recent Trades</h2></div>
        <div class="trades-head"><span>Unit (ETH)</span><span>Amount</span><span>Buyer</span><span>Block</span></div>
        <div class="trades" id="trades"><div class="empty small">Loading…</div></div>
      </div>
      <div class="mkt-forms">
        <section class="card">
          <div class="card-head"><h2>List for Sale</h2></div>
          <form id="listForm" class="form-grid" novalidate>
            <div class="field">
              <label>Amount (${esc(selected)})</label>
              <input class="mono" name="amt" inputmode="numeric" placeholder="Amount to sell">
              <div class="sub" id="listBalHint">&nbsp;</div>
            </div>
            <div class="field">
              <label>Total Price (ETH, fixed)</label>
              <input class="mono" name="price" inputmode="decimal" placeholder="e.g. 0.1">
              <div class="sub" id="listFeeHint">Seller receives = total × 95% (platform takes 5% on each side)</div>
            </div>
            <button class="btn btn-primary btn-big" type="submit">List ${esc(selected)} for Sale</button>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>My Orders</h2></div>
          <div id="myOrders" class="my-orders"><div class="empty small">Connect wallet to view</div></div>
        </section>
      </div>
      <div class="mkt-charts">
        <div class="card chart-card"><div class="card-head"><h2>Price</h2><span class="muted small">/ unit</span></div><div id="priceChart" class="chart"></div></div>
        <div class="card chart-card"><div class="card-head"><h2>Depth</h2><span class="muted small">Bids (green) / Asks (red)</span></div><div id="depthChart" class="chart"></div></div>
      </div>
    </div>`;

  const bookEl = $("#book");
  const bidBookEl = $("#bidBook");
  const tradesEl = $("#trades");

  function renderPairStrip(q = "") {
    const query = q.trim().toLowerCase();
    const list = query ? ticksCache.filter((t) => t.tick.toLowerCase().includes(query)) : ticksCache;
    const strip = $("#pairStrip");
    if (!list.length) {
      strip.innerHTML = `<div class="pair-empty muted small">No ticker matches “${esc(q)}”</div>`;
      return;
    }
    strip.innerHTML = list.map((t) => `
      <a class="pair${t.tick === selected ? " active" : ""}" href="#/market/${esc(t.tick)}">
        <span class="pair-tick">${esc(t.tick)}</span>
        <span class="pair-sub">${t.soldOut ? "Sold Out" : priceLabel(t.mintPriceWei)}</span>
      </a>`).join("");
  }

  function renderStatBar() {
    const t = ticksCache.find((x) => x.tick === selected) || {};
    const floor = market && market.floor ? unitEth(market.floor.price, market.floor.amt) : null;
    const last = market && market.last ? unitEth(market.last.price, market.last.amt) : null;
    const topBid = market && market.topBid ? unitEth(market.topBid.price, market.topBid.amt) : null;
    $("#statBar").innerHTML = `
      <div class="stat-lead"><span class="tick-badge lg">${esc(selected)}</span>${statusPill(t)}</div>
      <div class="stat-item"><span class="k">Floor / unit</span><span class="v hl">${floor != null ? fmtFloat(floor) : "—"}</span></div>
      <div class="stat-item"><span class="k">Top Bid / unit</span><span class="v up">${topBid != null ? fmtFloat(topBid) : "—"}</span></div>
      <div class="stat-item"><span class="k">Last / unit</span><span class="v">${last != null ? fmtFloat(last) : "—"}</span></div>
      <div class="stat-item"><span class="k">Volume</span><span class="v">${fmtFloat(Number(BigInt(t.volumeWei || "0")) / 1e18)} ETH</span></div>
      <div class="stat-item"><span class="k">Holders</span><span class="v">${fmtInt(String(t.holders || 0))}</span></div>
      <div class="stat-item"><span class="k">Listed / Bids</span><span class="v">${market ? market.listedCount : "—"} / ${market ? market.bidCount : "—"}</span></div>`;
  }

  function renderSpread() {
    const el = $("#bookSpread");
    if (!market || !market.floor || !market.topBid) { el.innerHTML = ""; return; }
    const ask = unitEth(market.floor.price, market.floor.amt);
    const bid = unitEth(market.topBid.price, market.topBid.amt);
    const spread = ask - bid;
    const pct = ask > 0 ? (spread / ask) * 100 : 0;
    el.innerHTML = `<span>Spread</span><span class="mono ${spread < 0 ? "up" : ""}">${fmtFloat(Math.abs(spread))} ETH (${pct.toFixed(1)}%)</span>`;
  }

  function renderBids() {
    const bids = market ? market.bids : [];
    if (!bids.length) { bidBookEl.innerHTML = `<div class="empty small">No bids — place one via "Place Bid" on the right</div>`; return; }
    const total = Number(market.totalBidAmt) || 1;
    const myBal = BigInt(myBalances[selected] || "0");
    bidBookEl.innerHTML = bids.map((b) => {
      const mine = account && b.bidder === account;
      const depth = Math.min(100, (Number(b.cumAmt) / total) * 100);
      const isTop = b.id === bids[0].id;
      let action = "";
      if (mine) action = `<button class="mini-btn danger" data-cancelbid="${b.id}">Cancel</button>`;
      else if (account && myBal >= BigInt(b.amt)) action = `<button class="mini-btn ok" data-accept="${b.id}">Fill</button>`;
      return `
      <div class="book-row bid-row${mine ? " mine" : ""}">
        <div class="depth up" style="width:${depth}%"></div>
        <span class="bid-unit${isTop ? " top" : ""}">${fmtFloat(unitEth(b.price, b.amt))}</span>
        <span class="mono">${fmtInt(b.amt)}</span>
        <span class="mono">${fmtEth(b.price)}</span>
        <span>${action || `<span class="mono muted">${fmtInt(b.cumAmt)}</span>`}</span>
      </div>`;
    }).join("");
  }

  function renderBook() {
    const asks = market ? market.asks : [];
    $("#bookMeta").textContent = asks.length ? `${asks.length} asks · sorted by unit price` : "";
    if (!asks.length) {
      bookEl.innerHTML = `<div class="empty small">No asks — be the first seller via "List for Sale" below</div>`;
      return;
    }
    const total = Number(market.totalForSale) || 1;
    bookEl.innerHTML = asks.map((a) => {
      const mine = account && a.seller === account;
      const depth = Math.min(100, (Number(a.cumAmt) / total) * 100);
      const isFloor = a.id === asks[0].id;
      return `
      <div class="book-row${a.id === selAskId ? " sel" : ""}${mine ? " mine" : ""}" data-ask="${a.id}">
        <div class="depth" style="width:${depth}%"></div>
        <span class="ask-unit${isFloor ? " floor" : ""}">${fmtFloat(unitEth(a.price, a.amt))}</span>
        <span class="mono">${fmtInt(a.amt)}</span>
        <span class="mono">${fmtEth(a.price)}</span>
        <span class="mono muted">${fmtInt(a.cumAmt)}</span>
      </div>`;
    }).join("");
  }

  function renderBuyPanel() {
    const panel = $("#buyPanel");
    const asks = market ? market.asks : [];
    const ask = asks.find((a) => a.id === selAskId) || asks[0] || null;
    selAskId = ask ? ask.id : null;
    if (!ask) {
      panel.innerHTML = `<div class="card-head"><h2>Buy</h2></div>
        <div class="empty small">No asks available</div>`;
      return;
    }
    const mine = account && ask.seller === account;
    const price = BigInt(ask.price);
    panel.innerHTML = `
      <div class="card-head"><h2>Buy ${esc(selected)}</h2><span class="muted small">Ask #${ask.id}</span></div>
      <div class="buy-rows">
        <div class="l-row"><span class="k">Unit / unit</span><span class="v hl">${fmtFloat(unitEth(ask.price, ask.amt))} ETH</span></div>
        <div class="l-row"><span class="k">Amount</span><span class="v mono">${fmtInt(ask.amt)} ${esc(selected)}</span></div>
        <div class="l-row"><span class="k">Total</span><span class="v mono">${fmtEth(price)} ETH</span></div>
        <div class="l-row"><span class="k">Fee 5%</span><span class="v mono">${fmtEth(price * FEE_BPS / 10000n)} ETH</span></div>
        <div class="l-row total"><span class="k">You Pay</span><span class="v hl mono">${fmtEth(buyerPays(price))} ETH</span></div>
        <div class="l-row"><span class="k">Seller</span><span class="v">${mine ? "Me" : addrLink(ask.seller)}</span></div>
      </div>
      ${mine
        ? `<button class="btn btn-danger btn-big" data-cancel="${ask.id}">Cancel</button>`
        : `<button class="btn btn-primary btn-big" data-buy="${ask.id}">Buy · Pay ${fmtEth(buyerPays(price))} ETH</button>`}`;
  }

  // 成交价走势（散点图）
  const PRICE_RANGES = [["1m", 60], ["5m", 300], ["30m", 1800], ["1h", 3600], ["4h", 14400], ["24h", 86400], ["7d", 604800], ["all", Infinity]];
  function renderPriceChart() {
    const el = $("#priceChart");
    const rangeBar = `<div class="price-ranges">${PRICE_RANGES.map(([k]) =>
      `<button type="button" data-r="${k}" class="${k === priceRange ? "active" : ""}">${k === "all" ? "All" : k}</button>`).join("")}</div>`;
    const wireRanges = () => el.querySelectorAll(".price-ranges button").forEach((b) =>
      b.addEventListener("click", () => { priceRange = b.dataset.r; renderPriceChart(); }));

    const all = (market ? market.trades : []).slice().reverse(); // old→new
    const secs = PRICE_RANGES.find((r) => r[0] === priceRange)[1];
    const cutoff = secs === Infinity ? -Infinity : (Date.now() / 1000) - secs;
    const pts = all
      .map((t) => ({ v: unitEth(t.price, t.amt), ts: t.ts || 0, amt: t.amt }))
      .filter((p) => isFinite(p.v) && p.v > 0 && (secs === Infinity || p.ts >= cutoff));
    if (!pts.length) {
      el.innerHTML = rangeBar + `<div class="empty small">No trades in this range</div>`;
      wireRanges();
      return;
    }
    const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v)), span = hi - lo || hi || 1;
    const bottomOf = (v) => 8 + ((v - lo) / span) * 84;          // inset 8%..92% so edge points aren't clipped
    const leftOf = (i) => pts.length > 1 ? 12 + (i / (pts.length - 1)) * 86 : 54;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const val = lo + f * span;
      return `<div class="cg-line" style="bottom:${bottomOf(val).toFixed(2)}%"><span class="cg-label">${fmtFloat(val)}</span></div>`;
    }).join("");
    const dots = pts.map((p, i) => {
      const last = i === pts.length - 1;
      return `<div class="cg-dot${last ? " last" : ""}" style="left:${leftOf(i).toFixed(2)}%;bottom:${bottomOf(p.v).toFixed(2)}%" data-p="${fmtFloat(p.v)}" data-t="${p.ts}" data-a="${esc(p.amt)}"></div>`;
    }).join("");
    el.innerHTML = rangeBar +
      `<div class="chart-plot">${grid}${dots}<div class="chart-tip" hidden></div></div>` +
      `<div class="chart-legend"><span>${pts.length} trades</span><span class="mono" style="color:var(--accent)">Last ${fmtFloat(pts[pts.length - 1].v)}</span><span>${priceRange === "all" ? "all time" : "last " + priceRange}</span></div>`;
    wireRanges();
    // hover tooltip: show price + amount + time for the point under the cursor
    const plot = el.querySelector(".chart-plot"), tip = el.querySelector(".chart-tip");
    plot.addEventListener("pointerover", (e) => {
      const d = e.target.closest(".cg-dot"); if (!d) return;
      const when = d.dataset.t && d.dataset.t !== "0" ? new Date(Number(d.dataset.t) * 1000).toLocaleString() : "—";
      tip.innerHTML = `<b>${d.dataset.p}</b> ETH/unit<br><span class="muted">${fmtInt(d.dataset.a)} · ${when}</span>`;
      tip.hidden = false;
      const pr = plot.getBoundingClientRect(), dr = d.getBoundingClientRect();
      tip.style.left = (dr.left - pr.left + dr.width / 2) + "px";
      tip.style.top = (dr.top - pr.top) + "px";
    });
    plot.addEventListener("pointerout", (e) => { if (e.target.closest(".cg-dot")) tip.hidden = true; });
  }

  // 深度图（累计买单/卖单，柱状图）
  function renderDepthChart() {
    const el = $("#depthChart");
    const asks = market ? market.asks : [], bids = market ? market.bids : [];
    if (!asks.length && !bids.length) { el.innerHTML = `<div class="empty small">No open orders</div>`; return; }
    // 按价格升序排列：买单在左（绿，最低价累计最高）、卖单在右（红，累计随价升高）
    const bidBars = bids.slice().reverse().map((b) => ({ u: unitEth(b.price, b.amt), h: Number(b.cumAmt), side: "bid" }));
    const askBars = asks.map((a) => ({ u: unitEth(a.price, a.amt), h: Number(a.cumAmt), side: "ask" }));
    const bars = [...bidBars, ...askBars];
    const cMax = Math.max(1, ...bars.map((b) => b.h));
    const W = 300, H = 110, pad = 6, n = bars.length;
    const bw = (W - 2 * pad) / n;
    const rects = bars.map((b, i) => {
      const h = (b.h / cMax) * (H - 2 * pad);
      const xx = pad + i * bw;
      const color = b.side === "bid" ? "var(--up)" : "var(--down)";
      return `<rect x="${(xx + bw * 0.14).toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.82"/>`;
    }).join("");
    const pMin = Math.min(...bars.map((b) => b.u)), pMax = Math.max(...bars.map((b) => b.u));
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${rects}</svg>
    <div class="chart-legend"><span class="up">Bids ${fmtInt(String(market.totalBidAmt || 0))}</span><span>${fmtFloat(pMin)}–${fmtFloat(pMax)}</span><span class="down">Asks ${fmtInt(String(market.totalForSale || 0))}</span></div>`;
  }

  function renderTrades() {
    const trades = market ? market.trades : [];
    if (!trades.length) { tradesEl.innerHTML = `<div class="empty small">No trades yet</div>`; return; }
    tradesEl.innerHTML = trades.map((tr) => `
      <div class="trade-row">
        <span class="up mono">${fmtFloat(unitEth(tr.price, tr.amt))}</span>
        <span class="mono">${fmtInt(tr.amt)}</span>
        <span>${addrLink(tr.buyer)}</span>
        <span class="mono muted">#${fmtInt(String(tr.block))}</span>
      </div>`).join("");
  }

  function renderMyOrders() {
    const box = $("#myOrders");
    if (!account) { box.innerHTML = connectPrompt("Connect wallet to view your orders"); return; }
    const myAsks = (market ? market.asks : []).filter((a) => a.seller === account);
    const myBids = (market ? market.bids : []).filter((b) => b.bidder === account);
    if (!myAsks.length && !myBids.length) {
      box.innerHTML = `<div class="empty small">You have no orders in ${esc(selected)}</div>`;
      return;
    }
    const askRows = myAsks.map((a) => `
      <div class="my-order">
        <div class="mo-main"><span class="tag sell">Ask</span> <b class="mono">${fmtInt(a.amt)}</b> ${esc(selected)} · ${fmtEth(a.price)} ETH
          <span class="muted small">(unit ${fmtFloat(unitEth(a.price, a.amt))})</span></div>
        <button class="btn btn-danger small" data-cancel="${a.id}">Cancel</button>
      </div>`).join("");
    const bidRows = myBids.map((b) => `
      <div class="my-order">
        <div class="mo-main"><span class="tag buy">Bid</span> <b class="mono">${fmtInt(b.amt)}</b> ${esc(selected)} · ${fmtEth(b.price)} ETH
          <span class="muted small">(unit ${fmtFloat(unitEth(b.price, b.amt))})</span></div>
        <button class="btn btn-danger small" data-cancelbid="${b.id}">Cancel</button>
      </div>`).join("");
    box.innerHTML = askRows + bidRows;
  }

  // 扫单：根据输入数量，从最便宜的卖单凑单，刷新摘要与按钮
  function renderSweep() {
    const input = $("#sweepQty");
    const summary = $("#sweepSummary");
    const btn = $("#sweepBtn");
    if (!input) return;
    const qty = input.value.trim();
    sweepPlan = null;
    if (!/^\d+$/.test(qty) || BigInt(qty) <= 0n) {
      summary.className = "sweep-summary muted small";
      summary.textContent = "Enter an amount to auto-fill from the cheapest asks";
      btn.disabled = true;
      return;
    }
    sweepPlan = computeSweep(market ? market.asks : [], qty);
    if (!sweepPlan) {
      summary.className = "sweep-summary muted small";
      summary.textContent = account
        ? "No asks to sweep (they may all be your own listings)"
        : "No asks currently for sale";
      btn.disabled = true;
      return;
    }
    const note = sweepPlan.filled ? "" : ` (not enough for sale, max ${fmtInt(sweepPlan.totalAmt.toString())})`;
    summary.className = "sweep-summary";
    summary.innerHTML =
      `Buy <b>${sweepPlan.count}</b> orders · total <b>${fmtInt(sweepPlan.totalAmt.toString())}</b> ${esc(selected)}${note}<br>` +
      `You pay <b class="hl">${fmtEth(sweepPlan.totalPay)} ETH</b> (incl. 5% fee)`;
    btn.disabled = false;
  }

  // 事件委托：点卖单行选中；买入/撤单按钮
  bookEl.addEventListener("click", (e) => {
    const row = e.target.closest("[data-ask]");
    if (!row) return;
    selAskId = Number(row.dataset.ask);
    renderBook();
    renderBuyPanel();
  });
  app.querySelector(".mkt").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-buy],[data-cancel],[data-accept],[data-cancelbid]");
    if (!btn) return;
    if (btn.dataset.buy || btn.dataset.cancel) {
      const id = Number(btn.dataset.buy || btn.dataset.cancel);
      const ask = (market ? market.asks : []).find((a) => a.id === id);
      if (!ask) return;
      if (btn.dataset.buy) await sendTx(buyTx(id, ask.price), btn);
      else await sendTx(cancelTx(id), btn);
    } else if (btn.dataset.cancelbid) {
      await sendTx(cancelBidTx(Number(btn.dataset.cancelbid)), btn);
    } else if (btn.dataset.accept) {
      const bid = (market ? market.bids : []).find((b) => b.id === Number(btn.dataset.accept));
      if (!bid) return;
      if (!account || BigInt(myBalances[selected] || "0") < BigInt(bid.amt))
        return toast(`Insufficient balance — filling needs ${fmtInt(bid.amt)} ${esc(selected)}`, "err");
      const hash = await sendTx(acceptTx(bid.bidder, selected, bid.id), btn);
      if (hash) toast(`Fill delivery sent (bid #${bid.id}); trade settles and funds arrive once confirmed`, "ok", 12000);
    }
  });

  // 扫单：输入实时预览 + 一键执行
  $("#sweepQty").addEventListener("input", renderSweep);
  $("#sweepBtn").addEventListener("click", async (e) => {
    if (!sweepPlan) return;
    const hash = await sendTx(sweepTx(sweepPlan.ids, sweepPlan.totalPay.toString()), e.currentTarget);
    if (hash) {
      toast(`Sweep sent: buying ${sweepPlan.count} orders of ${esc(selected)}; already-taken orders are skipped and refunded`, "ok", 12000);
      $("#sweepQty").value = "";
      renderSweep();
    }
  });

  // 挂买单：实时托管预览 + 执行
  function updateBidSummary() {
    const el = $("#bidSummary");
    const wei = parseEth($("#bidPrice").value);
    if (wei && wei > 0n) {
      el.className = "sweep-summary";
      el.innerHTML = `Escrow <b class="hl">${fmtEth(buyerPays(wei))} ETH</b> (bid ${fmtEth(wei)} + 5%) · seller receives ${fmtEth(sellerGets(wei))} ETH on fill`;
    } else {
      el.className = "sweep-summary muted small";
      el.textContent = "Placing a bid escrows your bid + 5% ETH. It fills when a seller accepts; cancel anytime before that for a full refund.";
    }
  }
  $("#bidPrice").addEventListener("input", updateBidSummary);
  $("#bidBtn").addEventListener("click", async (e) => {
    let amt = $("#bidAmt").value.trim();
    const priceWei = parseEth($("#bidPrice").value);
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString();
    if (priceWei === null || priceWei < 1n) return toast("Bid must be greater than 0", "err");
    const hash = await sendTx(placeBidTx(selected, amt, priceWei.toString()), e.currentTarget);
    if (hash) {
      toast(`Bid placed, escrowed ${fmtEth(buyerPays(priceWei))} ETH; fills when a seller accepts`, "ok", 10000);
      $("#bidAmt").value = ""; $("#bidPrice").value = ""; updateBidSummary();
    }
  });

  // 挂单表单
  const form = $("#listForm");
  async function updateBalHint() {
    const hint = $("#listBalHint");
    if (!account) { hint.textContent = "Connect wallet to see available balance"; return; }
    hint.innerHTML = `Available: <b>${fmtInt(myBalances[selected] || "0")}</b> ${esc(selected)}`;
  }
  form.price.addEventListener("input", () => {
    const wei = parseEth(form.price.value);
    const el = $("#listFeeHint");
    if (wei && wei > 0n) {
      el.innerHTML = `Seller receives <b>${fmtEth(sellerGets(wei))} ETH</b> · buyer pays ${fmtEth(buyerPays(wei))} ETH`;
    } else {
      el.textContent = "Seller receives = total × 95% (platform takes 5% on each side)";
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let amt = form.amt.value.trim();
    const priceWei = parseEth(form.price.value);
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString();
    if (priceWei === null || priceWei < 1n) return toast("Total price must be greater than 0", "err");
    if (account && BigInt(myBalances[selected] || "0") < BigInt(amt))
      return toast(`Insufficient balance: you hold ${fmtInt(myBalances[selected] || "0")} ${esc(selected)}`, "err");
    const btn = form.querySelector("button[type=submit]");
    const hash = await sendTx(listTx(selected, amt, priceWei.toString()), btn);
    if (hash) { toast("Listing sent — it becomes Listed once the platform confirms escrow", "ok", 10000); form.reset(); }
  });

  async function update() {
    let mk, bal;
    try {
      const reqs = [api("/api/market/" + encodeURIComponent(selected))];
      if (account) reqs.push(api("/api/balances/" + account));
      [mk, bal] = await Promise.all(reqs);
    } catch (e) {
      if (myNav === navToken) bookEl.innerHTML = `<div class="empty small">Failed to load: ${esc(e.message)}</div>`;
      return;
    }
    if (myNav !== navToken) return; // 页面已切走，丢弃这次结果
    market = mk;
    if (bal) myBalances = bal.balances;
    renderStatBar();
    renderPriceChart();
    renderDepthChart();
    renderBook();
    renderSpread();
    renderBids();
    renderBuyPanel();
    renderTrades();
    renderMyOrders();
    renderSweep();
    updateBalHint();
  }

  renderPairStrip();
  const searchEl = $("#pairSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => renderPairStrip(searchEl.value));
    searchEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = searchEl.value.trim().toLowerCase();
      if (!q) return;
      const match = ticksCache.find((t) => t.tick.toLowerCase() === q) ||
        ticksCache.find((t) => t.tick.toLowerCase().includes(q));
      if (match) location.hash = "#/market/" + match.tick;
    });
  }
  await update();
  currentUpdate = update;
}

// ---------------- 页面：我的 ----------------
async function pageMe() {
  if (!account) {
    app.innerHTML = `<h1 class="page-title">My</h1>` + connectPrompt("Connect wallet to view balances and orders");
    currentUpdate = null;
    return;
  }

  app.innerHTML = `
    <h1 class="page-title">My</h1>

    <div class="card">
      <div class="card-head"><h2>Balances</h2></div>
      <div class="tbl-wrap" style="border:none;margin-bottom:0">
        <table class="tbl compact">
          <thead><tr><th>Tick</th><th>Balance</th><th></th></tr></thead>
          <tbody id="balRows"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="mkt-forms">
      <section class="card">
        <div class="card-head"><h2>Transfer</h2></div>
        <form id="xferForm" class="form-grid" novalidate>
          <div class="field">
            <label>Tick</label>
            <div id="xferTickMount"></div>
            <div class="sub" id="xferBalHint">&nbsp;</div>
          </div>
          <div class="field">
            <label>Amount</label>
            <input class="mono" name="amt" inputmode="numeric" placeholder="Integer amount">
          </div>
          <div class="field">
            <label>Recipient Address</label>
            <input class="mono" name="to" placeholder="0x…" autocomplete="off" spellcheck="false">
            <div class="sub">Sends a 0 ETH inscription transaction to the recipient to complete the transfer</div>
          </div>
          <button class="btn btn-primary btn-big" type="submit">Send Transfer</button>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>My Orders</h2></div>
        <div id="meGrid" class="grid"><div class="card empty">Loading…</div></div>
      </section>
    </div>`;

  const grid = $("#meGrid");
  bindListingActions(grid);
  let myBalances = {};
  const myNav = navToken;

  // themed tick dropdown (rebuilt from balances in update())
  let xferTick = "";
  const xferSelect = customSelect([{ value: "", label: "Select tick" }], "", (v) => {
    xferTick = v;
    $("#xferBalHint").innerHTML = v ? `Available: <b>${fmtInt(myBalances[v] || "0")}</b> ${esc(v)}` : "&nbsp;";
  });
  $("#xferTickMount").appendChild(xferSelect);

  async function update() {
    try {
      const [b, ls] = await Promise.all([api("/api/balances/" + account), api("/api/listings")]);
      if (myNav !== navToken) return;
      myBalances = b.balances;
      const entries = Object.entries(myBalances);
      $("#balRows").innerHTML = entries.length ? entries.map(([tick, bal]) => `
        <tr>
          <td><a href="#/tick/${esc(tick)}"><span class="tick-badge">${esc(tick)}</span></a></td>
          <td class="mono">${fmtInt(bal)}</td>
          <td><a href="#/market" class="small">List →</a></td>
        </tr>`).join("")
        : '<tr><td colspan="3" class="empty">No balances yet — go to <a href="#/">Home</a> and mint one</td></tr>';

      // rebuild themed tick dropdown, keeping current selection
      xferSelect.setOptions(
        [{ value: "", label: "Select tick" }, ...entries.map(([tick]) => ({ value: tick, label: tick }))],
        xferTick
      );

      const mine = ls.listings.filter((l) => l.seller === account);
      for (const l of mine) listingById.set(String(l.id), l);
      grid.innerHTML = mine.length ? mine.map(listingCard).join("") : '<div class="card empty">No orders</div>';
    } catch (e) {
      toast("Refresh failed: " + esc(e.message), "err");
    }
  }

  const form = $("#xferForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tick = xferTick;
    let amt = form.amt.value.trim();
    const to = form.to.value.trim();
    if (!tick) return toast("Please select a tick", "err");
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString(); // 去前导零
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return toast("Recipient address is invalid", "err");
    const toLower = to.toLowerCase();
    if (toLower === HUB || toLower === MARKET) return toast("Cannot transfer to system contracts (the transaction would revert)", "err");
    if (toLower === account) toast("Note: transferring to yourself is valid but has no net balance change", "", 5000);
    if (BigInt(myBalances[tick] || "0") < BigInt(amt))
      return toast(`Insufficient balance: you hold ${fmtInt(myBalances[tick] || "0")} ${esc(tick)}`, "err");
    const btn = form.querySelector("button[type=submit]");
    const hash = await sendTx(transferTx(to, tick, amt), btn);
    if (hash) toast("Transfer inscription sent — recorded once the transaction succeeds with sufficient balance", "ok", 10000);
  });

  await update();
  currentUpdate = update;
}

// ---------------- 路由 ----------------
let memesState = { coins: [], sort: "new", search: "", page: 0, ethUsd: null, pageSize: 8 };

async function pageMemes() {
  const live = !!LAUNCHPAD;

  if (!live) {
    app.innerHTML = `
      <div class="narrow-page memes-page">
        <div class="memes-coming">
          <span class="memes-coming-badge">✦ Coming soon</span>
          <h1 class="memes-coming-title">Memes</h1>
        </div>
      </div>`;
    currentUpdate = null;
    return;
  }

  app.innerHTML = `
    <div class="narrow-page memes-page">
      <div class="memes-hero">
        <a class="btn btn-primary btn-big" href="#/memes/new">Create Meme Coin</a>
      </div>

      <input class="memes-search" id="memesSearch" type="search" placeholder="Search name, ticker, or contract address…" autocomplete="off" spellcheck="false">

      <div class="memes-listbar">
        <h2 class="memes-h2">Recent launches</h2>
        <div class="memes-sort" id="memesSort">
          <button data-sort="new">New</button>
          <button data-sort="mcap">Market cap</button>
          <button data-sort="vol">Volume</button>
          <button data-sort="holders">Holders</button>
        </div>
      </div>
      <div id="memesList" class="memes-grid"><div class="empty muted">Loading…</div></div>
      <div id="memesPager" class="memes-pager"></div>
    </div>`;

  // fit roughly one screen of cards (each ~96px tall)
  memesState.pageSize = Math.max(5, Math.floor((window.innerHeight - 340) / 96));
  memesState.page = 0;
  memesState.search = "";

  $("#memesSort").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    memesState.sort = b.dataset.sort;
    memesState.page = 0;
    renderMemesList();
  });

  const searchEl = $("#memesSearch");
  if (searchEl) searchEl.addEventListener("input", () => {
    memesState.search = searchEl.value;
    memesState.page = 0;
    renderMemesList();
  });

  try {
    const data = await api("/api/memes");
    memesState.coins = (data && data.coins) || [];
    memesState.ethUsd = (data && data.ethUsd) || null;
    renderMemesList();
  } catch (_) {
    $("#memesList").innerHTML = '<div class="empty muted">No launches yet.</div>';
  }
  currentUpdate = null;
}

function memesSorted() {
  const q = (memesState.search || "").trim().toLowerCase();
  let coins = memesState.coins;
  if (q) {
    coins = coins.filter((c) =>
      (c.name || "").toLowerCase().includes(q) ||
      (c.symbol || "").toLowerCase().includes(q) ||
      (c.token || "").toLowerCase().includes(q)
    );
  }
  const bi = (x) => { try { return BigInt(x || "0"); } catch { return 0n; } };
  const cmp = {
    new: (a, b) => b.block - a.block,
    mcap: (a, b) => (bi(b.mcapWei) > bi(a.mcapWei) ? 1 : bi(b.mcapWei) < bi(a.mcapWei) ? -1 : 0),
    vol: (a, b) => (bi(b.volumeWei) > bi(a.volumeWei) ? 1 : bi(b.volumeWei) < bi(a.volumeWei) ? -1 : 0),
    holders: (a, b) => (b.holders || 0) - (a.holders || 0),
  }[memesState.sort] || ((a, b) => b.block - a.block);
  return coins.slice().sort(cmp);
}

function renderMemesList() {
  for (const b of document.querySelectorAll("#memesSort button")) b.classList.toggle("active", b.dataset.sort === memesState.sort);
  const listEl = $("#memesList");
  const pagerEl = $("#memesPager");
  if (!listEl) return;
  const all = memesSorted();
  if (!all.length) {
    const msg = memesState.search.trim() ? "No coins match your search." : "No launches yet — be the first.";
    listEl.innerHTML = `<div class="empty muted">${msg}</div>`;
    if (pagerEl) pagerEl.innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(all.length / memesState.pageSize));
  memesState.page = Math.min(memesState.page, pages - 1);
  const start = memesState.page * memesState.pageSize;
  listEl.innerHTML = all.slice(start, start + memesState.pageSize).map((c) => memeCardHtml(c)).join("");
  wireMemeCards(listEl);
  if (pagerEl) {
    pagerEl.innerHTML = pages > 1
      ? `<button id="pgPrev" ${memesState.page === 0 ? "disabled" : ""}>‹ Prev</button>` +
        `<span class="memes-pageinfo">Page ${memesState.page + 1} / ${pages}</span>` +
        `<button id="pgNext" ${memesState.page >= pages - 1 ? "disabled" : ""}>Next ›</button>`
      : "";
    const prev = $("#pgPrev"), next = $("#pgNext");
    if (prev) prev.onclick = () => { if (memesState.page > 0) { memesState.page--; renderMemesList(); } };
    if (next) next.onclick = () => { if (memesState.page < pages - 1) { memesState.page++; renderMemesList(); } };
  }
}

// Format a wei value as compact USD (if an ETH price is known) or ETH.
function fmtValue(wei, ethUsd) {
  if (wei == null) return "—";
  let eth;
  try { eth = Number(BigInt(wei)) / 1e18; } catch { return "—"; }
  return ethUsd ? "$" + fmtCompactNum(eth * ethUsd) : fmtCompactNum(eth) + " ETH";
}
function fmtCompactNum(n) {
  if (!isFinite(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n >= 1) return n.toFixed(2);
  if (n === 0) return "0";
  if (n >= 0.0001) return n.toFixed(4);
  return n.toPrecision(2);
}

function memeAvatar(c) {
  const a = (c.token || "0x0").toLowerCase();
  const hue = parseInt(a.slice(2, 8) || "0", 16) % 360;
  const hue2 = (hue + 45) % 360;
  const ch = ((c.symbol || c.name || "?").trim()[0] || "?").toUpperCase();
  const placeholder =
    `<div class="meme-avatar" style="background:linear-gradient(135deg,hsl(${hue},62%,50%),hsl(${hue2},64%,38%))">${esc(ch)}</div>`;
  if (c.imageUrl) {
    // real IPFS avatar; if it fails to load, swap in the generated placeholder
    return `<img class="meme-avatar" src="${esc(c.imageUrl)}" alt="" loading="lazy"` +
      ` data-hue="${hue}" data-hue2="${hue2}" data-ch="${esc(ch)}" onerror="memeAvatarFallback(this)">`;
  }
  return placeholder;
}
function memeAvatarFallback(img) {
  const div = document.createElement("div");
  div.className = "meme-avatar";
  div.style.background = `linear-gradient(135deg,hsl(${img.dataset.hue},62%,50%),hsl(${img.dataset.hue2},64%,38%))`;
  div.textContent = img.dataset.ch || "?";
  img.replaceWith(div);
}
function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}
function memeSocials(coin) {
  if (!coin) return "";
  const links = [["Twitter", coin.twitter], ["Website", coin.website], ["Telegram", coin.telegram]]
    .map(([label, u]) => [label, safeUrl(u)])
    .filter(([, u]) => u);
  if (!links.length) return "";
  return `<div class="meme-socials">` +
    links.map(([label, u]) => `<a class="meme-social" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>`).join("") +
    `</div>`;
}

function memeCardHtml(c) {
  const eu = memesState.ethUsd;
  return `
    <div class="meme-card" data-token="${esc(c.token)}">
      ${memeAvatar(c)}
      <div class="meme-card-main">
        <div class="meme-card-title">${esc(c.name || "—")} <span class="meme-ticker">${esc(c.symbol || "")}</span></div>
        <button class="meme-ca" type="button" data-ca="${esc(c.token)}" title="Copy contract address">${short(c.token)} <span class="meme-ca-ic">⧉</span></button>
      </div>
      <div class="meme-metrics">
        <div class="meme-metric"><span class="mm-k">MC</span><span class="mm-v">${fmtValue(c.mcapWei, eu)}</span></div>
        <div class="meme-metric"><span class="mm-k">Vol</span><span class="mm-v">${fmtValue(c.volumeWei, eu)}</span></div>
        <div class="meme-metric"><span class="mm-k">Holders</span><span class="mm-v">${c.holders != null ? fmtInt(String(c.holders)) : "—"}</span></div>
      </div>
    </div>`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  // Fallback for contexts where the async Clipboard API is blocked.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function wireMemeCards(root) {
  for (const card of root.querySelectorAll(".meme-card")) {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".meme-ca")) return; // the copy button handles its own click
      location.hash = "#/memes/" + card.dataset.token;
    });
  }
  for (const btn of root.querySelectorAll(".meme-ca")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(btn.dataset.ca);
      toast(ok ? "Contract address copied" : "Copy failed", ok ? "ok" : "err", 2000);
    });
  }
}

async function pageMemesNew() {
  if (!LAUNCHPAD) {
    app.innerHTML = `<div class="narrow-page"><div class="card empty muted">Launchpad not deployed yet.</div></div>`;
    return;
  }
  app.innerHTML = `
    <div class="narrow-page">
    <a class="back-link" href="#/memes">← Memes</a>
    <h1 class="page-title centered">Create Meme Coin</h1>
    <div class="card">
      <form id="memeForm" class="form-grid" novalidate>
        <div class="meme-form-top">
          <label class="meme-drop">
            <img id="imgPreview" class="meme-drop-img" alt="" style="display:none">
            <span id="imgPick" class="meme-drop-hint"><span class="meme-drop-plus">+</span>Add image</span>
            <input type="file" name="cimg" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          </label>
          <div class="meme-form-top-right">
            <div class="field">
              <label>Name</label>
              <input name="cname" maxlength="32" placeholder="Doge Rob" autocomplete="off" spellcheck="false">
            </div>
            <div class="field">
              <label>Ticker</label>
              <input class="mono" name="csymbol" maxlength="11" placeholder="DROB" autocomplete="off" spellcheck="false">
            </div>
          </div>
        </div>
        <div class="field">
          <label>Twitter <span class="muted">(optional)</span></label>
          <input name="ctwitter" placeholder="https://x.com/…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Telegram <span class="muted">(optional)</span></label>
          <input name="ctelegram" placeholder="https://t.me/…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Website <span class="muted">(optional)</span></label>
          <input name="cwebsite" placeholder="https://…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Initial buy (ETH)</label>
          <input class="mono" name="cdev" inputmode="decimal" placeholder="0.05" value="0.05">
          <div class="sub">Seeds the locked liquidity and buys you the opening tokens. Must be &gt; 0.</div>
        </div>
        <button class="btn btn-primary btn-big" type="submit">Launch Coin</button>
      </form>
    </div>
    </div>`;

  // avatar preview + client-side validation (fills the square dropzone)
  const fileInput = $('#memeForm [name="cimg"]');
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    const prev = $("#imgPreview");
    const hint = $("#imgPick");
    if (!file) { prev.style.display = "none"; hint.style.display = "flex"; return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast("Use a PNG / JPG / WEBP / GIF image", "err"); fileInput.value = ""; return; }
    if (file.size > 5 * 1024 * 1024) { toast("Image must be ≤ 5MB", "err"); fileInput.value = ""; return; }
    prev.src = URL.createObjectURL(file);
    prev.style.display = "block";
    hint.style.display = "none";
  });

  $("#memeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!account) return toast("Connect your wallet first", "err");
    const f = e.target;
    const name = f.elements.cname.value.trim();
    const symbol = f.elements.csymbol.value.trim();
    const devWei = parseEth(f.elements.cdev.value);
    const file = f.elements.cimg.files[0];
    const twitter = f.elements.ctwitter.value.trim();
    const website = f.elements.cwebsite.value.trim();
    const telegram = f.elements.ctelegram.value.trim();
    if (name.length < 1 || name.length > 32) return toast("Name must be 1–32 characters", "err");
    if (symbol.length < 1 || symbol.length > 11) return toast("Symbol must be 1–11 characters", "err");
    if (!file) return toast("Add an avatar image", "err");
    if (devWei === null || devWei <= 0n) return toast("First buy must be greater than 0", "err");

    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const label = btn.textContent;
    let metadataURI;
    try {
      btn.textContent = "Uploading image…";
      const img = await pinAvatar(file);
      btn.textContent = "Saving metadata…";
      const meta = { name, symbol, image: img.ipfs };
      if (twitter) meta.twitter = twitter;
      if (website) meta.website = website;
      if (telegram) meta.telegram = telegram;
      const md = await pinJson(meta);
      metadataURI = md.ipfs;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      return toast("Upload failed: " + err.message, "err", 6000);
    }
    btn.textContent = label;
    btn.disabled = false;

    const hash = await sendTx(launchTx(name, symbol, metadataURI, devWei), btn);
    if (hash) {
      toast("Launch sent — your coin appears on Memes once confirmed", "ok", 10000);
      setTimeout(() => { location.hash = "#/memes"; }, 3000);
    }
  });
  currentUpdate = null;
}

async function pageMemesCoin(token) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { location.hash = "#/memes"; return; }
  token = token.toLowerCase();
  let coin = null, eu = null;
  try {
    const d = await api("/api/memes");
    eu = (d && d.ethUsd) || null;
    coin = (d.coins || []).find((c) => c.token.toLowerCase() === token);
  } catch (_) {}

  const sym = esc(coin?.symbol || "");
  const stat = (k, v) => `<div class="coin-stat"><div class="cs-k">${k}</div><div class="cs-v">${v}</div></div>`;
  const info = (k, v, wide) => `<div class="coin-info${wide ? " wide" : ""}"><div class="ci-k">${k}</div><div class="ci-v">${v}</div></div>`;

  app.innerHTML = `
    <div class="narrow-page coin-page">
      <a class="back-link" href="#/memes">← Memes</a>

      <div class="coin-hero">
        ${coin ? memeAvatar(coin) : ""}
        <div class="coin-hero-info">
          <div class="coin-hero-title">${esc(coin?.name || "Coin")} <span class="ticker">${sym}</span></div>
          <button class="meme-ca coin-ca" type="button" data-ca="${esc(token)}" title="Copy contract address">${short(token)} <span class="meme-ca-ic">⧉</span></button>
          ${memeSocials(coin)}
        </div>
      </div>

      <div class="coin-stats">
        ${stat("Market cap", fmtValue(coin?.mcapWei, eu))}
        ${stat("Volume", fmtValue(coin?.volumeWei || "0", eu))}
        ${stat("Holders", coin && coin.holders != null ? fmtInt(String(coin.holders)) : "—")}
        ${stat("Trades", coin ? fmtInt(String(coin.trades || 0)) : "—")}
      </div>

      <div class="card coin-info-card">
        <div class="coin-info-grid">
          ${info("Trading pair", (sym || "TOKEN") + " / WETH")}
          ${info("Supply", "1,000,000,000")}
          ${info("Trade tax", "1%")}
          ${info("Pool fee", "0%")}
          ${coin ? info("Creator", addrLink(coin.creator)) : ""}
          ${coin?.ts ? info("Launched", memeTimeAgo(coin.ts)) : ""}
          ${info("Contract", addrLink(token))}
          ${info("Explorer", `<a class="addr-link" href="${EXPLORER}/token/${esc(token)}" target="_blank" rel="noopener">View ↗</a>`)}
        </div>
      </div>

      <div class="card" id="feeCard"><div class="empty muted">Loading fees…</div></div>
    </div>`;

  const ca = $(".coin-ca");
  if (ca) ca.addEventListener("click", async () => {
    const ok = await copyText(ca.dataset.ca);
    toast(ok ? "Contract address copied" : "Copy failed", ok ? "ok" : "err", 2000);
  });

  await renderMemeFees(token);
  currentUpdate = null;
}

function memeTimeAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function renderMemeFees(token) {
  const el = $("#feeCard");
  if (!el) return;
  try {
    const [creatorHex, treasuryHex, pcHex, ptHex] = await Promise.all([
      readCall(token, SEL_CREATOR), readCall(token, SEL_TREASURY),
      readCall(token, SEL_PENDING_CREATOR), readCall(token, SEL_PENDING_TREASURY),
    ]);
    // Empty result = no contract on the wallet's current network (e.g. wallet on the
    // wrong chain, or viewing a testnet coin while the fallback RPC is mainnet).
    if (!creatorHex || creatorHex.length < 66) {
      el.innerHTML = `<h2 class="memes-h2">Fees (WETH)</h2>` +
        `<p class="sub muted">Connect the creator or treasury wallet to withdraw fees.</p>`;
      return;
    }
    const creator = ("0x" + creatorHex.slice(26)).toLowerCase();
    const treasury = ("0x" + treasuryHex.slice(26)).toLowerCase();
    const pc = readBig(pcHex), pt = readBig(ptHex);
    const me = account ? account.toLowerCase() : null;

    let html = `
      <h2 class="memes-h2">Fees (WETH)</h2>
      <div class="kv"><div class="k">Creator claimable</div><div class="v mono">${fmtEth(pc)} <span class="muted">→ ${addrLink(creator)}</span></div></div>
      <div class="kv"><div class="k">Treasury claimable</div><div class="v mono">${fmtEth(pt)} <span class="muted">→ ${addrLink(treasury)}</span></div></div>`;
    const acts = [];
    if (me && me === creator && pc > 0n) acts.push(`<button class="btn btn-primary" id="wcBtn">Withdraw my creator fees</button>`);
    if (me && me === treasury && pt > 0n) acts.push(`<button class="btn btn-primary" id="wtBtn">Withdraw treasury fees</button>`);
    html += acts.length
      ? `<div class="meme-actions">${acts.join("")}</div>`
      : `<div class="sub muted">${me ? "Connected wallet has nothing to withdraw here." : "Connect the creator or treasury wallet to withdraw."}</div>`;
    el.innerHTML = html;

    const wc = $("#wcBtn");
    if (wc) wc.addEventListener("click", async () => {
      const h = await sendTx(withdrawCreatorTx(token, account), wc);
      if (h) { toast("Withdraw sent", "ok"); setTimeout(() => renderMemeFees(token), 4000); }
    });
    const wt = $("#wtBtn");
    if (wt) wt.addEventListener("click", async () => {
      const h = await sendTx(withdrawTreasuryTx(token, account), wt);
      if (h) { toast("Withdraw sent", "ok"); setTimeout(() => renderMemeFees(token), 4000); }
    });
  } catch (e) {
    el.innerHTML = `<div class="empty muted">Couldn't load fees: ${esc(e.message)}</div>`;
  }
}

function setNav(route) {
  for (const a of document.querySelectorAll("#nav a")) {
    a.classList.toggle("active", a.dataset.route === route);
  }
}

async function router() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  currentUpdate = null;
  navToken++; // 使所有在途的旧页面 update() 失效，避免串页渲染
  listingById = new Map();
  try {
    if (parts.length === 0) { setNav("home"); await pageHome(); }
    else if (parts[0] === "tick" && parts[1]) { setNav("home"); await pageTick(decodeURIComponent(parts[1])); }
    else if (parts[0] === "deploy") { setNav("deploy"); await pageDeploy(); }
    else if (parts[0] === "market") { setNav("market"); await pageMarket(parts[1] ? decodeURIComponent(parts[1]) : null); }
    else if (parts[0] === "me") { setNav("me"); await pageMe(); }
    else if (parts[0] === "memes" && parts[1] === "new") { setNav("memes"); await pageMemesNew(); }
    else if (parts[0] === "memes" && parts[1]) { setNav("memes"); await pageMemesCoin(decodeURIComponent(parts[1])); }
    else if (parts[0] === "memes") { setNav("memes"); await pageMemes(); }
    else { location.hash = "#/"; }
  } catch (e) {
    app.innerHTML = `<div class="card error-card">Failed to load page: ${esc(e.message)}<br><span class="small muted">Make sure the indexer is running locally</span></div>`;
  }
}

// ---------------- 启动 ----------------
(async function init() {
  $("#walletBtn").addEventListener("click", async (e) => {
    if (account) { e.stopPropagation(); walletMenuEl ? closeWalletMenu() : openWalletMenu(); return; }
    try { await connectWallet(); router(); } catch (e) { txError(e); }
  });

  window.addEventListener("hashchange", router);

  // 被动检测已连接账户：优先上次用过的钱包（记住 rdns），否则回退注入钱包。
  // 给 6963 广播一个 tick 收集完再判断。
  await new Promise((r) => setTimeout(r, 60));
  let eager = null;
  const opts = walletOptions();
  try {
    const remembered = localStorage.getItem(LS_WALLET);
    if (remembered) eager = opts.find((o) => o.info.rdns === remembered) || null;
  } catch (_) {}
  if (!eager && opts.length === 1) eager = opts[0]; // 只有一个钱包，直接用它做被动检测
  if (eager) {
    wallet = eager.provider;
    bindWalletEvents(wallet);
    try {
      const accs = await wallet.request({ method: "eth_accounts" });
      if (accs && accs[0]) account = accs[0].toLowerCase();
    } catch (_) {}
  }
  updateWalletUI();

  await refreshStatus();
  await router();

  // 实时刷新（节流）：状态栏 + 当前页面数据
  let refreshing = false, lastRefresh = 0;
  async function liveRefresh() {
    const now = Date.now();
    if (refreshing || now - lastRefresh < 1200) return; // 节流，避免连续出块时抖动
    refreshing = true; lastRefresh = now;
    try {
      await refreshStatus();
      if (currentUpdate) await currentUpdate();
    } catch (_) {} finally { refreshing = false; }
  }

  // SSE：索引器每扫完一批推送新区块，前端实时刷新；断线自动重连
  function connectStream() {
    try {
      const es = new EventSource("/api/stream");
      es.onmessage = () => liveRefresh();
      es.onerror = () => { es.close(); setTimeout(connectStream, 3000); };
    } catch (_) { /* 无 EventSource 时退回轮询 */ }
  }
  connectStream();

  // 兜底轮询（SSE 不可用/漏推时）
  setInterval(liveRefresh, 15000);
})();
