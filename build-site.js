// 168 台股選股：GitHub 雲端版
// 由 GitHub Actions 每個交易日傍晚執行：抓資料 → 計算推薦 → 產生 site/index.html
// 資料存在 store/store.json（由 GitHub 的快取保存，不會塞爆儲存庫）
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const ROOT = __dirname;
const STORE_FILE = path.join(ROOT, 'store', 'store.json');
const SITE_DIR = path.join(ROOT, 'site');
const UA = 'Mozilla/5.0 (168AI stock picker)';
const QUOTE_URL = 'https://tw-stock-quote.pt520530.workers.dev/'; // 盤中即時報價（Cloudflare Worker）

function load() { try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { return {}; } }
function save(store) { fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true }); fs.writeFileSync(STORE_FILE, JSON.stringify(store)); }

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return null; }
  } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayTPE = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function render(store) {
  const page = fs.readFileSync(path.join(ROOT, 'page.html'), 'utf8');
  const data = store.latest ? Object.assign({}, store.latest, { track: store.track, generatedAt: store.updatedAt }) : null;
  const js = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
  const body = page.replace('/*__DATA__*/null', js(data)).replace('/*__QURL__*/null', js(QUOTE_URL))
    .replace('/*__STATUS__*/null', js(data ? null : '雲端還在準備第一次的資料，請等 GitHub 的排程跑完再回來看。'));
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="168選股"><meta name="mobile-web-app-capable" content="yes">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1D4F91"/><path d="M12 44 L26 30 L36 38 L52 18" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
}

function summary(store, out) {
  const L = store.latest || {};
  const src = L.sources || {};
  const names = [['twsePrice', '上市行情'], ['twseChips', '上市法人'], ['twseVal', '上市本益比'], ['tpexPrice', '上櫃行情'], ['tpexChips', '上櫃法人'], ['tpexVal', '上櫃本益比'], ['us', '美股']];
  const lines = ['## 168 台股選股：本次執行結果', ''];
  lines.push(`- 資料日期：${L.date || '—'}`);
  lines.push(`- 歷史資料：${(store.days || []).length} 個交易日`);
  lines.push(`- 今日推薦：${L.lists ? L.lists.pick.length : 0} 檔`);
  lines.push('', '| 資料來源 | 狀態 |', '|---|---|');
  for (const [k, n] of names) lines.push(`| ${n} | ${src[k] ? '✅ 有抓到' : '❌ 沒抓到'} |`);
  lines.push('', '### 過程紀錄', ...out.report.map((m) => `- ${m}`));
  if (src.errors && src.errors.length) lines.push('', '### 錯誤訊息', ...src.errors.map((m) => `- ${m}`));
  return lines.join('\n');
}

(async () => {
  const store = load();
  let saves = 0; // 每 10 個進度存一次，執行被中斷也不會全部重來
  let out = { report: [] };
  try {
    out = await E.runUpdate(store, getJSON, sleep, (m) => console.log(m), todayTPE(), (m) => { console.log('…' + m); if (++saves % 10 === 0) save(store); });
  } catch (e) {
    out.report.push('執行失敗：' + e.message);
    console.error(e);
  }
  save(store);
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SITE_DIR, 'index.html'), render(store));
  fs.writeFileSync(path.join(SITE_DIR, '.nojekyll'), '');
  const sum = summary(store, out);
  console.log(sum);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, sum + '\n');
  fs.writeFileSync(path.join(ROOT, 'last-update.txt'), `${new Date().toISOString()}\n資料日期：${(store.latest || {}).date || '—'}\n`);
})();
