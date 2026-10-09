// ===================== 台股選股引擎（168 AI 一人公司）=====================
// 資料來源：臺灣證券交易所（上市）、證券櫃檯買賣中心（上櫃）、Yahoo Finance（美股參考）
// 本引擎只做「條件篩選」與「自我追蹤勝率」，不構成投資建議。

const CFG = {
  KEEP_DAYS: 130,          // 保留幾個交易日的收盤價（約半年）
  KEEP_CHIP_DAYS: 20,      // 保留幾天的三大法人資料
  MIN_AVG_VOL: 500000,     // 20 日均量至少 500 張（股），太冷門的不選
  DELAY_MS: 4000,          // 證交所有頻率限制，每次請求間隔 4 秒
  TOP_N: 40,               // 每個清單最多保留幾檔（網頁再依上市/上櫃篩選，各顯示前 15）
  TRACK_HOLD: 10,          // 追蹤勝率：選出後第幾個交易日結算
  codeFilter: (code) => /^[1-9]\d{3}$/.test(code), // 只看一般股票（排除 ETF、權證）
};

const LENS = {
  pick: { name: '推薦', checks: [] },
  swing: { name: '波段', checks: ['均線多頭排列', '月線往上', '今天量增', '沒有追太高'] },
  chips: { name: '籌碼', checks: ['投信連買 3 天', '投信 3 日買超 ≥ 100 張', '外資 5 日買超', '三大法人 5 日買超'] },
};

// ---------- 小工具 ----------
function rocToISO(s) {
  s = String(s || '').replace(/\D/g, '');
  if (s.length < 7) return null;
  const y = +s.slice(0, s.length - 4) + 1911;
  return `${y}-${s.slice(-4, -2)}-${s.slice(-2)}`;
}
function ymd(iso) { return iso.replace(/-/g, ''); }
function num(x) {
  if (x == null) return null;
  const s = String(x).replace(/,/g, '').replace(/<[^>]*>/g, '').trim();
  if (s === '' || s === '--' || s === '---' || s === 'X') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function col(fields, ...keys) {
  return fields.findIndex((f) => keys.some((k) => String(f).includes(k)));
}
function tableOf(j, mustHave) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j.fields) && Array.isArray(j.data) && col(j.fields, mustHave) >= 0) return j;
  if (Array.isArray(j.tables)) {
    for (const t of j.tables) {
      if (t && Array.isArray(t.fields) && Array.isArray(t.data) && col(t.fields, mustHave) >= 0) return t;
    }
  }
  return null;
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const lots = (shares) => Math.round(shares / 1000).toLocaleString('en-US'); // 股 → 張

// ---------- 抓資料 ----------
async function fetchDayPrices(http, iso) {
  const j = await http(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${ymd(iso)}&response=json`);
  const t = tableOf(j, '收盤價');
  if (!t || !t.data.length) return null;
  const f = t.fields;
  const ic = col(f, '證券代號'), inm = col(f, '證券名稱'), iv = col(f, '成交股數'), ip = col(f, '收盤價');
  const io = col(f, '開盤價'), ih = col(f, '最高價'), il = col(f, '最低價');
  const out = { c: {}, v: {}, names: {}, ohl: {} };
  for (const row of t.data) {
    const code = String(row[ic]).trim();
    const p = num(row[ip]), v = num(row[iv]);
    if (p == null) continue;
    out.c[code] = p; out.v[code] = v || 0; out.names[code] = String(row[inm]).trim();
    out.ohl[code] = [io >= 0 ? num(row[io]) : null, ih >= 0 ? num(row[ih]) : null, il >= 0 ? num(row[il]) : null];
  }
  return out;
}

async function fetchLatestPricesOpenApi(http) {
  const arr = await http('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = { d: rocToISO(arr[0].Date), c: {}, v: {}, names: {}, ohl: {} };
  for (const r of arr) {
    const p = num(r.ClosingPrice);
    if (p == null) continue;
    out.c[r.Code] = p; out.v[r.Code] = num(r.TradeVolume) || 0; out.names[r.Code] = r.Name;
    out.ohl[r.Code] = [num(r.OpeningPrice), num(r.HighestPrice), num(r.LowestPrice)];
  }
  return out;
}

async function fetchChips(http, iso) {
  const j = await http(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(iso)}&selectType=ALLBUT0999&response=json`);
  const t = tableOf(j, '投信買賣超');
  if (!t || !t.data.length) return null;
  const f = t.fields;
  const ic = col(f, '證券代號');
  const ifo = col(f, '外陸資買賣超股數(不含外資自營商)', '外陸資買賣超', '外資買賣超');
  const it = col(f, '投信買賣超');
  const ia = col(f, '三大法人買賣超');
  const out = { t: {}, f: {}, a: {} };
  for (const row of t.data) {
    const code = String(row[ic]).trim();
    out.t[code] = num(row[it]) || 0;
    out.f[code] = ifo >= 0 ? num(row[ifo]) || 0 : 0;
    out.a[code] = ia >= 0 ? num(row[ia]) || 0 : 0;
  }
  return out;
}

async function fetchValuation(http) {
  const arr = await http('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL');
  if (!Array.isArray(arr) || !arr.length) return null;
  const rows = {};
  for (const r of arr) rows[r.Code] = [num(r.PEratio), num(r.DividendYield), num(r.PBratio)];
  return { d: rocToISO(arr[0].Date), rows };
}

// ---------- 上櫃（櫃買中心）----------
// 櫃買 OpenAPI 的欄位名稱沒有在這裡實測過，所以用「候選名稱 → 關鍵字」兩層比對，認不到就回傳 null，不會讓整個流程壞掉。
function keyOf(obj, exact, tokenSets) {
  const keys = Object.keys(obj || {});
  for (const e of exact) if (keys.includes(e)) return e;
  for (const toks of tokenSets || []) {
    const k = keys.find((key) => toks.every((t) => (t.startsWith('!') ? !key.toLowerCase().includes(t.slice(1).toLowerCase()) : key.toLowerCase().includes(t.toLowerCase()))));
    if (k) return k;
  }
  return null;
}
function tpexDate(arr) {
  const r = arr[0] || {};
  const k = keyOf(r, ['Date', '日期', '資料日期'], [['date']]);
  return k ? rocToISO(r[k]) : null;
}

async function fetchTpexLatestPrices(http) {
  const arr = await http('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
  if (!Array.isArray(arr) || !arr.length) return null;
  const r0 = arr[0];
  const kc = keyOf(r0, ['SecuritiesCompanyCode', 'Code', '代號', '證券代號'], [['code']]);
  const kn = keyOf(r0, ['CompanyName', 'Name', '名稱', '證券名稱'], [['name']]);
  const kp = keyOf(r0, ['Close', 'ClosingPrice', '收盤', '收盤價'], [['close']]);
  const kv = keyOf(r0, ['TradingShares', 'TradeVolume', '成交股數'], [['shares', '!transaction'], ['volume']]);
  if (!kc || !kp) return { error: '上櫃行情欄位認不出來：' + Object.keys(r0).join(',') };
  const ko = keyOf(r0, ['Open', 'OpeningPrice', '開盤', '開盤價'], [['open']]);
  const kh = keyOf(r0, ['High', 'HighestPrice', '最高', '最高價'], [['high']]);
  const kl = keyOf(r0, ['Low', 'LowestPrice', '最低', '最低價'], [['low']]);
  const out = { d: tpexDate(arr), c: {}, v: {}, names: {}, ohl: {} };
  for (const r of arr) {
    const code = String(r[kc]).trim(), p = num(r[kp]);
    if (p == null) continue;
    out.c[code] = p; out.v[code] = kv ? num(r[kv]) || 0 : 0; out.names[code] = kn ? String(r[kn]).trim() : code;
    out.ohl[code] = [ko ? num(r[ko]) : null, kh ? num(r[kh]) : null, kl ? num(r[kl]) : null];
  }
  return out;
}

// 歷史行情（回補用）：櫃買舊版查詢網址，欄位用中文名稱或固定位置判讀
async function fetchTpexDayPrices(http, iso) {
  const [y, m, d] = iso.split('-');
  const roc = `${+y - 1911}/${m}/${d}`;
  const j = await http(`https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${roc}&o=json`);
  let rows = null, ic = 0, inm = 1, ip = 2, iv = 8;
  const t = tableOf(j, '收盤');
  if (t) {
    rows = t.data; const f = t.fields;
    ic = col(f, '代號'); inm = col(f, '名稱'); ip = col(f, '收盤'); iv = col(f, '成交股數');
  } else if (j && Array.isArray(j.aaData)) rows = j.aaData;
  if (!rows || !rows.length) return null;
  const out = { c: {}, v: {}, names: {} };
  for (const row of rows) {
    const code = String(row[ic]).trim(), p = num(row[ip]);
    if (p == null) continue;
    out.c[code] = p; out.v[code] = num(row[iv]) || 0; out.names[code] = String(row[inm]).trim();
  }
  return out;
}

async function fetchTpexChips(http) {
  const arr = await http('https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading');
  if (!Array.isArray(arr) || !arr.length) return null;
  const r0 = arr[0];
  const kc = keyOf(r0, ['SecuritiesCompanyCode', 'Code', '代號', '證券代號'], [['code']]);
  const kt = keyOf(r0, [], [['investmenttrust', 'difference'], ['investmenttrust', 'net'], ['投信', '買賣超'], ['trust', 'diff']]);
  const kf = keyOf(r0, [], [['foreign', 'difference', '!dealer', '!total'], ['foreign', 'net', '!dealer'], ['外資', '不含', '買賣超'], ['外資及陸資', '買賣超', '!自營商-'], ['外資', '買賣超', '!自營'], ['外陸資', '買賣超']]);
  const ka = keyOf(r0, [], [['total', 'difference'], ['three', 'difference'], ['三大法人', '買賣超'], ['total', 'net']]);
  if (!kc || !kt) return { error: '上櫃法人欄位認不出來：' + Object.keys(r0).join(',') };
  const out = { d: tpexDate(arr), t: {}, f: {}, a: {} };
  for (const r of arr) {
    const code = String(r[kc]).trim();
    out.t[code] = num(r[kt]) || 0;
    out.f[code] = kf ? num(r[kf]) || 0 : 0;
    out.a[code] = ka ? num(r[ka]) || 0 : 0;
  }
  return out;
}

async function fetchTpexValuation(http) {
  const arr = await http('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis');
  if (!Array.isArray(arr) || !arr.length) return null;
  const r0 = arr[0];
  const kc = keyOf(r0, ['SecuritiesCompanyCode', 'Code', '代號', '股票代號'], [['code']]);
  const kpe = keyOf(r0, ['PriceEarningRatio', 'PEratio', '本益比'], [['earning'], ['pe']]);
  const ky = keyOf(r0, ['YieldRatio', 'DividendYield', '殖利率'], [['yield']]);
  const kpb = keyOf(r0, ['PriceBookRatio', 'PBratio', '股價淨值比'], [['book']]);
  if (!kc || !ky) return { error: '上櫃本益比欄位認不出來：' + Object.keys(r0).join(',') };
  const rows = {};
  for (const r of arr) rows[String(r[kc]).trim()] = [kpe ? num(r[kpe]) : null, num(r[ky]), kpb ? num(r[kpb]) : null];
  return { d: tpexDate(arr), rows };
}

function mergeInto(a, b) {
  if (!b) return a;
  if (!a) return b;
  for (const k of ['c', 'v', 'names', 'ohl', 't', 'f', 'a', 'rows']) if (b[k]) a[k] = Object.assign(a[k] || {}, b[k]);
  return a;
}

async function fetchUS(http) {
  const syms = { sox: '^SOX', nasdaq: '^IXIC', tsm: 'TSM', twd: 'TWD=X' };
  const out = {};
  for (const [k, s] of Object.entries(syms)) {
    try {
      const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=10d&interval=1d`);
      const res = j.chart.result[0];
      const closes = res.indicators.quote[0].close.filter((x) => x != null);
      const last = closes[closes.length - 1], prev = closes[closes.length - 2];
      out[k] = { last: r2(last), chg: prev ? last / prev - 1 : null };
    } catch (e) { out[k] = null; }
  }
  return out;
}

// ---------- 存資料 ----------
function addDay(store, iso, prices, chips) {
  store.days = store.days || [];
  store.names = Object.assign(store.names || {}, prices.names || {});
  const day = { d: iso, c: prices.c, v: prices.v };
  if (chips) Object.assign(day, chips);
  const idx = store.days.findIndex((x) => x.d === iso);
  if (idx >= 0) store.days[idx] = day; else store.days.push(day);
  store.days.sort((a, b) => (a.d < b.d ? -1 : 1));
  // 只保留一般股票與 0050（追蹤勝率的比較基準），控制資料量
  for (const dd of store.days) {
    for (const key of ['c', 'v']) {
      if (!dd[key]) continue;
      for (const code of Object.keys(dd[key])) if (!(CFG.codeFilter(code) || code === '0050')) delete dd[key][code];
    }
  }
  while (store.days.length > CFG.KEEP_DAYS) store.days.shift();
  const n = store.days.length;
  store.days.forEach((dd, i) => { if (i < n - CFG.KEEP_CHIP_DAYS) { delete dd.t; delete dd.f; delete dd.a; } });
}

// ---------- 計算 ----------
function ma(D, code, i, n) {
  if (i - n + 1 < 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) { const x = D[k].c[code]; if (x == null) return null; s += x; }
  return s / n;
}
function avgVol(D, code, from, to) {
  if (from < 0) return null;
  let s = 0, n = 0;
  for (let k = from; k <= to; k++) { const x = D[k].v ? D[k].v[code] : null; if (x == null) continue; s += x; n++; }
  return n ? s / n : null;
}

function evaluate(store, i, val) {
  const D = store.days, day = D[i], prev = D[i - 1];
  const stocks = {};
  let universe = 0, bullish = 0, withMA = 0;
  const chipsReady = i >= 4 && [0, 1, 2, 3, 4].every((k) => D[i - k].t);

  for (const code of Object.keys(day.c)) {
    if (!CFG.codeFilter(code)) continue;
    const close = day.c[code];
    const av20 = avgVol(D, code, Math.max(0, i - 19), i);
    if (!close || av20 == null || av20 < CFG.MIN_AVG_VOL) continue;
    universe++;
    const s = { n: (store.names || {})[code] || code, m: (store.mkt || {})[code] === 'O' ? '櫃' : '市', p: close, ch: prev && prev.c[code] ? close / prev.c[code] - 1 : null };

    // 波段（技術面）
    const m20 = ma(D, code, i, 20), m60 = ma(D, code, i, 60), m20p = ma(D, code, i - 5, 20);
    if (m20 != null && m60 != null && m20p != null) {
      const v = day.v[code] || 0, v5 = avgVol(D, code, i - 5, i - 1);
      const vr = v5 ? v / v5 : 0;
      const ok = [close > m20 && m20 > m60, m20 > m20p, vr >= 1.5, close <= m20 * 1.1];
      withMA++; if (ok[0]) bullish++;
      s.swing = {
        ok,
        t: [
          `收盤 ${close} ${close > m20 ? '>' : '≤'} 月線 ${r1(m20)} ${m20 > m60 ? '>' : '≤'} 季線 ${r1(m60)}`,
          `月線一週前 ${r1(m20p)} → 現在 ${r1(m20)}`,
          `今天成交量是前 5 日平均的 ${vr.toFixed(1)} 倍`,
          `離月線 ${pct(close / m20 - 1)}`,
        ],
        k: vr,
      };
    }

    // 基本面健檢：只用來排除虧損公司（近四季本益比無法計算＝虧損）
    if (val && val.rows[code]) s.pe = val.rows[code][0];

    // 籌碼
    if (chipsReady) {
      const t = (k) => D[i - k].t[code] || 0;
      const sum = (key, days) => { let x = 0; for (let k = 0; k < days; k++) x += D[i - k][key][code] || 0; return x; };
      const t3 = t(0) + t(1) + t(2), f5 = sum('f', 5), a5 = sum('a', 5);
      let streak = 0; for (let k = 0; k <= Math.min(i, CFG.KEEP_CHIP_DAYS) && D[i - k] && D[i - k].t; k++) { if ((D[i - k].t[code] || 0) > 0) streak++; else break; }
      s.chips = {
        ok: [streak >= 3, t3 >= 100000, f5 > 0, a5 > 0],
        t: [
          streak ? `投信已連買 ${streak} 天` : '投信今天沒有買超',
          `投信近 3 日合計 ${t3 >= 0 ? '買超' : '賣超'} ${lots(Math.abs(t3))} 張`,
          `外資近 5 日合計 ${f5 >= 0 ? '買超' : '賣超'} ${lots(Math.abs(f5))} 張`,
          `三大法人近 5 日合計 ${a5 >= 0 ? '買超' : '賣超'} ${lots(Math.abs(a5))} 張`,
        ],
        k: t3 / av20,
      };
    }
    // 推薦分數：波段 4 項＋籌碼 4 項，每項 12.5 分
    if (s.swing && s.chips) {
      const okAll = s.swing.ok.concat(s.chips.ok);
      s.pick = { score: okAll.filter(Boolean).length * 12.5, trend: close > m60, profit: val && val.rows[code] ? (s.pe != null && s.pe > 0) : null };
    }
    stocks[code] = s;
  }

  const lists = {};
  lists.pick = Object.keys(stocks)
    .filter((c) => { const p = stocks[c].pick; return p && p.score >= 75 && p.trend && p.profit !== false; })
    .sort((a, b) => stocks[b].pick.score - stocks[a].pick.score || stocks[b].swing.k - stocks[a].swing.k)
    .slice(0, CFG.TOP_N);
  for (const lens of ['swing', 'chips']) {
    lists[lens] = Object.keys(stocks)
      .filter((c) => stocks[c][lens] && stocks[c][lens].ok.every(Boolean))
      .sort((a, b) => stocks[b][lens].k - stocks[a][lens].k)
      .slice(0, CFG.TOP_N);
  }
  for (const c of Object.keys(stocks)) for (const l of ['swing', 'chips']) if (stocks[c][l]) delete stocks[c][l].k;

  return {
    date: day.d,
    universe,
    breadth: withMA ? bullish / withMA : null,
    ready: { pick: withMA > 0 && chipsReady, swing: withMA > 0, chips: chipsReady },
    lists,
    stocks,
  };
}

// 價格明細、參考價位、走勢小圖資料（只在每日更新時算，回測不需要）
function enrichPrices(store, i, result, val, ohl) {
  const D = store.days;
  const listed = new Set([].concat(...Object.values(result.lists)));
  for (const [code, s] of Object.entries(result.stocks)) {
    const closes = [];
    for (let k = Math.max(0, i - 59); k <= i; k++) { const x = D[k].c[code]; if (x != null) closes.push(x); }
    // 清單上的股票給完整 60 日，其他股票每 3 日取一點，控制網頁大小
    s.h = listed.has(code) ? closes : closes.filter((_, k) => (closes.length - 1 - k) % 3 === 0);
    let hi = null, lo = null;
    for (const dd of D) { const x = dd.c[code]; if (x == null) continue; if (hi == null || x > hi) hi = x; if (lo == null || x < lo) lo = x; }
    const m20 = ma(D, code, i, 20);
    s.lv = { ma20: r2(m20), stop: m20 ? r2(m20 * 0.97) : null, hi60: closes.length ? Math.max(...closes) : null, hi, lo };
    const o = ohl && ohl[code];
    if (o) { s.o = o[0]; s.hh = o[1]; s.ll = o[2]; }
    s.vol = Math.round((D[i].v[code] || 0) / 1000);
  }
  result.histDays = D.length;
}

function weather(us, breadth) {
  const sox = us && us.sox ? us.sox.chg : null;
  let level = 'cloudy', label = '陰天：多看少動', note = '美股和台股訊號不一致，進場分批、資金不要一次用完。';
  if ((sox != null && sox <= -0.02) || (breadth != null && breadth < 0.25)) {
    level = 'rain'; label = '雨天：保守為主'; note = '費半大跌或多數股票走空頭，新手先觀察，持股設好停損。';
  } else if ((sox == null || sox >= 0) && breadth != null && breadth >= 0.4) {
    level = 'sunny'; label = '晴天：可以積極'; note = '美股科技股穩、多數台股在多頭排列，順勢操作較容易。';
  }
  return { level, label, note };
}

function adrPremium(us, store) {
  const last = store.days[store.days.length - 1];
  const tw = last && last.c['2330'];
  if (!us || !us.tsm || !us.twd || !tw) return null;
  return (us.tsm.last * us.twd.last) / 5 / tw - 1; // 1 股 ADR = 5 股台積電
}

function track(store) {
  const D = store.days, H = CFG.TRACK_HOLD;
  const idx = {}; D.forEach((d, i) => (idx[d.d] = i));
  const agg = {};
  for (const p of store.picks || []) {
    const i = idx[p.d];
    if (i == null || i + H >= D.length) continue;
    const b0 = D[i].c['0050'], b1 = D[i + H].c['0050'];
    const bench = b0 && b1 ? b1 / b0 - 1 : null;
    for (const lens of ['pick', 'swing', 'chips']) {
      if (!p[lens]) continue;
      const key = lens + (p.retro ? '_retro' : '');
      const a = (agg[key] = agg[key] || { n: 0, win: 0, beat: 0, sum: 0, from: p.d, to: p.d });
      for (const code of p[lens]) {
        const c0 = D[i].c[code], c1 = D[i + H].c[code];
        if (!c0 || !c1) continue;
        const r = c1 / c0 - 1;
        a.n++; a.sum += r; if (r > 0) a.win++; if (bench != null && r > bench) a.beat++;
        if (p.d < a.from) a.from = p.d; if (p.d > a.to) a.to = p.d;
      }
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(agg)) out[k] = { n: a.n, winRate: a.n ? a.win / a.n : null, beatRate: a.n ? a.beat / a.n : null, avg: a.n ? a.sum / a.n : null, from: a.from, to: a.to };
  return { hold: H, stats: out };
}

function recordPicks(store, result, retro) {
  store.picks = (store.picks || []).filter((p) => p.d !== result.date);
  store.picks.push({ d: result.date, retro: !!retro, pick: result.ready.pick ? result.lists.pick : null, swing: result.ready.swing ? result.lists.swing : null, chips: result.ready.chips ? result.lists.chips : null });
  store.picks.sort((a, b) => (a.d < b.d ? -1 : 1));
  const first = store.days[0] && store.days[0].d;
  store.picks = store.picks.filter((p) => p.d >= first);
}

function buildLineText(latest, pageUrl) {
  const L = latest, S = L.stocks, us = L.us || {};
  const name = (c) => `${c} ${S[c].n}${S[c].m === '櫃' ? '(櫃)' : ''}`;
  const f = (x) => (x == null ? '—' : pct(x));
  const lines = [];
  lines.push(`📊 台股選股日報 ${L.date.replace(/-/g, '/')}`);
  lines.push(`🇺🇸 費半 ${f(us.sox && us.sox.chg)}｜那斯達克 ${f(us.nasdaq && us.nasdaq.chg)}${L.adr != null ? `｜台積電ADR溢價 ${(L.adr * 100).toFixed(1)}%` : ''}`);
  const icon = { sunny: '☀️', cloudy: '⛅', rain: '🌧️' }[L.weather.level];
  lines.push(`${icon} ${L.weather.label}${L.breadth != null ? `（多頭排列 ${(L.breadth * 100).toFixed(0)}%）` : ''}`);
  const block = (title, codes, detail, n) => {
    lines.push('', `【${title}】${codes.length ? '' : '今天沒有符合的股票'}`);
    codes.slice(0, n || 3).forEach((c) => lines.push(`・${name(c)}　${detail(c)}`));
  };
  if (L.ready.pick) {
    lines.push('', `【今日推薦】技術＋籌碼 8 項條件過 6 項以上${L.lists.pick.length ? '' : '：今天沒有'}`);
    L.lists.pick.slice(0, 5).forEach((c, k) => {
      const s = S[c], lv = s.lv || {};
      lines.push(`${k + 1}. ${name(c)}　${s.pick.score} 分`);
      lines.push(`　收 ${s.p}｜月線 ${lv.ma20 != null ? lv.ma20 : '—'}｜停損 ${lv.stop != null ? lv.stop : '—'}`);
    });
  } else lines.push('', '【今日推薦】法人資料累積中（需要 5 個交易日）');
  if (L.ready.swing) block('波段強勢', L.lists.swing, (c) => S[c].swing.t[2].replace('今天成交量是前 5 日平均的 ', '量 ').replace(' 倍', '倍'));
  if (L.ready.chips) block('投信認養', L.lists.chips, (c) => S[c].chips.t[0]);
  const src = L.sources || {};
  const miss = { twseChips: '上市法人', tpexPrice: '上櫃行情', tpexChips: '上櫃法人', tpexVal: '上櫃本益比', us: '美股' };
  const missing = Object.keys(miss).filter((k) => L.sources && !src[k]).map((k) => miss[k]);
  if (missing.length) lines.push('', `ℹ️ 今天這些資料沒抓到：${missing.join('、')}`);
  if (pageUrl) lines.push('', `📱 完整清單與個股體檢：${pageUrl}`);
  lines.push('⚠️ 條件篩選結果，僅供學習參考，不構成投資建議');
  return lines.join('\n');
}

// ---------- 主流程：每日更新（含第一次自動回補歷史）----------
async function safe(p, log, label) {
  try { const r = await p; if (r && r.error) { log(r.error); return { value: null, error: r.error }; } return { value: r }; }
  catch (e) { log(`${label}失敗：${e.message}`); return { value: null, error: e.message }; }
}
function markOTC(store, codes) {
  store.mkt = store.mkt || {};
  for (const c of codes) store.mkt[c] = 'O';
}

async function runUpdate(store, http, sleep, log, todayISO, progress) {
  const report = [];
  progress = progress || (() => {});
  store.days = store.days || [];

  // 1) 第一次執行：回補約半年的收盤價（上市＋上櫃，約 15～20 分鐘）
  if (store.days.length < 65) {
    let cursor = new Date(todayISO + 'T12:00:00+08:00');
    let tries = 0, got = 0, otcDays = 0;
    while (got < CFG.KEEP_DAYS && tries < 200) {
      cursor = new Date(cursor.getTime() - 86400000); tries++;
      const dow = cursor.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const iso = cursor.toISOString().slice(0, 10);
      if (store.days.some((d) => d.d === iso)) { got++; continue; }
      progress(`回補歷史資料：${got} / ${CFG.KEEP_DAYS} 個交易日（${iso}）`);
      try {
        const p = await fetchDayPrices(http, iso);
        await sleep(CFG.DELAY_MS);
        if (!p) continue;
        const o = (await safe(fetchTpexDayPrices(http, iso), () => {}, '')).value;
        await sleep(CFG.DELAY_MS);
        if (o) { markOTC(store, Object.keys(o.c)); mergeInto(p, o); otcDays++; }
        let chips = null;
        if (got < 6) { chips = await fetchChips(http, iso).catch(() => null); await sleep(CFG.DELAY_MS); }
        addDay(store, iso, p, chips);
        if (!store.lastOhl || store.lastOhl.d < iso) store.lastOhl = { d: iso, ohl: p.ohl };
        got++;
      } catch (e) { log(`回補 ${iso} 失敗：${e.message}`); await sleep(CFG.DELAY_MS * 2); }
    }
    report.push(`回補歷史 ${got} 個交易日（上櫃 ${otcDays} 日）`);
    for (let i = 64; i < store.days.length; i++) recordPicks(store, evaluate(store, i, null), true);
  }

  // 1b) 補齊中間缺的交易日（例如幾天沒開程式）
  if (store.days.length) {
    let cur = new Date(store.days[store.days.length - 1].d + 'T12:00:00+08:00');
    let filled = 0;
    for (let n = 0; n < 60; n++) {
      cur = new Date(cur.getTime() + 86400000);
      const iso = cur.toISOString().slice(0, 10);
      if (iso >= todayISO) break;
      const dow = cur.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      progress(`補齊缺的交易日：${iso}`);
      try {
        const p = await fetchDayPrices(http, iso);
        await sleep(CFG.DELAY_MS);
        if (!p) continue;
        const o = (await safe(fetchTpexDayPrices(http, iso), () => {}, '')).value;
        await sleep(CFG.DELAY_MS);
        if (o) { markOTC(store, Object.keys(o.c)); mergeInto(p, o); }
        const chips = await fetchChips(http, iso).catch(() => null);
        await sleep(CFG.DELAY_MS);
        addDay(store, iso, p, chips);
        if (!store.lastOhl || store.lastOhl.d < iso) store.lastOhl = { d: iso, ohl: p.ohl };
        filled++;
      } catch (e) { log(`補 ${iso} 失敗：${e.message}`); }
    }
    if (filled) report.push(`補齊 ${filled} 個缺的交易日`);
  }

  // 2) 今天的資料；今天還沒公布（盤中、假日）就用最近一個交易日
  progress('抓取今天的行情與法人資料…');
  const src = {};
  let prices = null, dayISO = todayISO, fresh = true;
  try { prices = await fetchDayPrices(http, todayISO); } catch (e) { log('證交所日行情失敗：' + e.message); }
  if (!prices) {
    const o = await fetchLatestPricesOpenApi(http).catch(() => null);
    if (o && o.d === todayISO) prices = o;
  }
  if (!prices) {
    const last = store.days[store.days.length - 1];
    if (!last || (store.latest && store.latest.date === last.d)) return { skipped: true, report: report.concat('今天沒有新的交易資料（假日或尚未公布）') };
    prices = { c: Object.assign({}, last.c), v: Object.assign({}, last.v), ohl: store.lastOhl && store.lastOhl.d === last.d ? Object.assign({}, store.lastOhl.ohl) : {} };
    dayISO = last.d; fresh = false;
    report.push(`今天資料還沒公布，先用 ${dayISO} 的收盤計算`);
  }
  src.twsePrice = true;
  let chips = null;
  if (fresh) {
    await sleep(CFG.DELAY_MS);
    chips = await fetchChips(http, todayISO).catch(() => null);
    src.twseChips = !!chips;
  } else src.twseChips = !!store.days[store.days.length - 1].t;

  const op = await safe(fetchTpexLatestPrices(http), log, '上櫃行情');
  src.tpexPrice = !!(op.value && op.value.d === dayISO);
  if (src.tpexPrice) { markOTC(store, Object.keys(op.value.c)); mergeInto(prices, op.value); }
  const oc = await safe(fetchTpexChips(http), log, '上櫃法人');
  src.tpexChips = !!(oc.value && oc.value.d === dayISO);
  if (fresh) {
    if (src.tpexChips) chips = mergeInto(chips || { t: {}, f: {}, a: {} }, oc.value);
    addDay(store, todayISO, prices, chips);
  } else {
    const last = store.days[store.days.length - 1];
    if (src.tpexPrice) { Object.assign(last.c, op.value.c); Object.assign(last.v, op.value.v); store.names = Object.assign(store.names || {}, op.value.names); }
    if (src.tpexChips && last.t) { Object.assign(last.t, oc.value.t); Object.assign(last.f, oc.value.f); Object.assign(last.a, oc.value.a); }
  }
  progress('計算推薦清單…');

  let val = await fetchValuation(http).catch(() => null);
  src.twseVal = !!val;
  const ov = await safe(fetchTpexValuation(http), log, '上櫃本益比');
  src.tpexVal = !!ov.value;
  if (ov.value) val = mergeInto(val || { rows: {} }, ov.value);
  const us = await fetchUS(http).catch(() => ({}));
  src.us = !!(us && us.sox);
  src.errors = [op.error, oc.error, ov.error].filter(Boolean);

  const i = store.days.length - 1;
  const result = evaluate(store, i, val);
  result.us = us;
  result.adr = adrPremium(us, store);
  result.weather = weather(us, result.breadth);
  result.valDate = val ? val.d : null;
  result.sources = src;
  enrichPrices(store, i, result, val, prices.ohl);
  const miss = { twseChips: '上市法人', tpexPrice: '上櫃行情', tpexChips: '上櫃法人', tpexVal: '上櫃本益比', us: '美股' };
  const missing = Object.keys(miss).filter((k) => !src[k]).map((k) => miss[k]);
  if (missing.length) report.push('今天缺少：' + missing.join('、'));
  recordPicks(store, result, false);
  store.latest = result;
  store.track = track(store);
  store.updatedAt = new Date().toISOString();
  return { skipped: false, report, result };
}

if (typeof module !== 'undefined') module.exports = { CFG, LENS, evaluate, track, recordPicks, weather, adrPremium, addDay, buildLineText, runUpdate, rocToISO, num, tableOf };
