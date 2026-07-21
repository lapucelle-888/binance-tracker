const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.static("public"));
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = "https://fapi.binance.com";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_HOURS = 2; // berapa jam token login valid sebelum minta login ulang
const LOGIN_MAX_FAILS = 5;             // berapa kali salah sebelum kekunci
const LOGIN_LOCK_MS = 5 * 60 * 1000;   // lama lockout (5 menit)
const loginAttempts = {};              // { ip: { count, lockUntil } }

const ROI_THRESHOLDS = [-200, -100, -50, 50, 100, 200, 500];
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastAlerted = {};
let alertRunning = false;

let exchangeInfoCache = null;
let exchangeInfoAt = 0;
const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60 * 1000; // refresh tiap 6 jam

function sign(query) {
  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}
function signToken(expiry) {
  return crypto.createHmac("sha256", "session:" + (APP_PASSWORD || "")).update(String(expiry)).digest("hex");
}
function makeToken() {
  const expiry = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  return expiry + "." + signToken(expiry);
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [expStr, sig] = token.split(".");
  const expiry = Number(expStr);
  if (!expiry || Date.now() > expiry) return false; // token kedaluwarsa → tolak
  const expected = signToken(expiry);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function requireAuth(req, res, next) {
  if (verifyToken(req.headers["x-app-token"])) return next();
  res.status(401).json({ error: "Unauthorized — login dulu." });
}

async function signedRequest(method, path, params = {}) {
  const query = new URLSearchParams({
    ...params,
    timestamp: Date.now(),
    recvWindow: 5000,
  }).toString();
  const signature = sign(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const response = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY },
  });
  return response.json();
}

async function getPrice(symbol) {
  const r = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  const d = await r.json();
  return Number(d.price);
}

async function loadExchangeInfo() {
  const now = Date.now();
  if (!exchangeInfoCache || (now - exchangeInfoAt) > EXCHANGE_INFO_TTL_MS) {
    const r = await fetch(`${BASE_URL}/fapi/v1/exchangeInfo`);
    const data = await r.json();
    if (data && data.symbols) {        // cuma timpa cache kalau respons valid
      exchangeInfoCache = data;
      exchangeInfoAt = now;
    }
  }
  return exchangeInfoCache;
}

async function getMaxQty(symbol, orderType) {
  const info = await loadExchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) return null;
  const wanted = orderType === "MARKET" ? "MARKET_LOT_SIZE" : "LOT_SIZE";
  let f = s.filters.find(x => x.filterType === wanted);
  if (!f) f = s.filters.find(x => x.filterType === "LOT_SIZE"); // fallback
  return f ? Number(f.maxQty) : null;
}

async function getStepSize(symbol) {
  const info = await loadExchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) return null;
  const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
  return lot ? lot.stepSize : null;
}
async function getMaxLeverage(symbol) {
  try {
    const b = await signedRequest("GET", "/fapi/v1/leverageBracket", { symbol });
    const entry = Array.isArray(b) ? (b.find(x => x.symbol === symbol) || b[0]) : b;
    const brackets = entry && entry.brackets;
    if (brackets && brackets.length) {
      return Math.max(...brackets.map(x => Number(x.initialLeverage)));
    }
  } catch (e) {}
  return null;
}

async function getTickSize(symbol) {
  const info = await loadExchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) return null;
  const pf = s.filters.find(f => f.filterType === "PRICE_FILTER");
  return pf ? pf.tickSize : null;
}

function stepDecimals(sizeStr) {
  if (sizeStr.includes(".")) {
    return sizeStr.split(".")[1].replace(/0+$/, "").length;
  }
  return 0;
}

function roundToStep(qty, stepSize) {
  const step = Number(stepSize);
  const dec = stepDecimals(stepSize);
  const floored = Math.floor(qty / step) * step;
  return floored.toFixed(dec);
}

function roundToTick(price, tickSize) {
  const tick = Number(tickSize);
  const dec = stepDecimals(tickSize);
  return (Math.round(price / tick) * tick).toFixed(dec);
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in Secrets" };
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    const d = await r.json();
    return d.ok ? { ok: true } : { ok: false, error: d.description || JSON.stringify(d) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function closeOnePosition(p) {
  const amt = Number(p.positionAmt);
  if (amt === 0) return { symbol: p.symbol, skipped: true };
  const closeSide = amt > 0 ? "SELL" : "BUY";
  const params = {
    symbol: p.symbol, side: closeSide, type: "MARKET", quantity: Math.abs(amt),
  };
  if (p.positionSide && p.positionSide !== "BOTH") {
    params.positionSide = p.positionSide;
  } else {
    params.reduceOnly = "true";
  }
  return signedRequest("POST", "/fapi/v1/order", params);
}

function roiOf(p) {
  const amt = Number(p.positionAmt);
  const entry = Number(p.entryPrice);
  const lev = Number(p.leverage);
  const pnl = Number(p.unRealizedProfit);
  const initialMargin = (entry * Math.abs(amt)) / lev;
  return initialMargin > 0 ? (pnl / initialMargin) * 100 : 0;
}

function currentBand(roi) {
  let hit = null;
  for (const t of ROI_THRESHOLDS) {
    if (t > 0 && roi >= t) { if (hit === null || t > hit) hit = t; }
    else if (t < 0 && roi <= t) { if (hit === null || t < hit) hit = t; }
  }
  return hit;
}

let prevOpen = null; // snapshot posisi polling sebelumnya (null = baru nyala)

async function checkAlerts() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const open = risk.filter(p => Number(p.positionAmt) !== 0);
    const liveIds = new Set();
    const now = Date.now();
    const openNow = {};
    for (const p of open) {
      const sideLabel = (p.positionSide && p.positionSide !== "BOTH")
        ? p.positionSide
        : (Number(p.positionAmt) > 0 ? "LONG" : "SHORT");
      openNow[`${p.symbol}_${sideLabel}`] = {
        symbol: p.symbol,
        side: sideLabel,
        pnl: Number(p.unRealizedProfit),
        roi: roiOf(p)
      };
    }

    for (const p of open) {
      const sideLabel = (p.positionSide && p.positionSide !== "BOTH")
        ? p.positionSide
        : (Number(p.positionAmt) > 0 ? "LONG" : "SHORT");
      const posId = `${p.symbol}_${sideLabel}`;
      liveIds.add(posId);

      const roi = roiOf(p);
      const band = currentBand(roi);
      if (band === null) continue;

      const key = `${posId}_${band}`;
      const last = lastAlerted[key];
      if (last && (now - last) < ALERT_COOLDOWN_MS) continue;

      const pnl = Number(p.unRealizedProfit);
      const emoji = band > 0 ? "🟢" : "🔴";
      const sgn = roi >= 0 ? "+" : "";
      const text =
        `${emoji} ${p.symbol} ${sideLabel}\n` +
        `ROI ${sgn}${roi.toFixed(2)}% (threshold ${band > 0 ? "+" : ""}${band}%)\n` +
        `PNL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;
      const sent = await sendTelegram(text);
      if (sent && sent.ok) lastAlerted[key] = now; // stempel CUMA kalau beneran terkirim
    }

    for (const key of Object.keys(lastAlerted)) {
      const posId = key.split("_").slice(0, 2).join("_");
      if (!liveIds.has(posId)) delete lastAlerted[key];
    }
        // --- CLOSED POSITION ALERT (TP/SL/Liq/manual) ---
    if (prevOpen) {
      for (const posId of Object.keys(prevOpen)) {
        if (!liveIds.has(posId)) {
          const q = prevOpen[posId];
          const win = q.pnl >= 0;
          const text =
            `${win ? "✅" : "❌"} ${q.symbol} ${q.side} CLOSED\n` +
            `PNL ≈ ${win ? "+" : ""}${q.pnl.toFixed(2)} USDT ` +
            `(ROI ${q.roi >= 0 ? "+" : ""}${q.roi.toFixed(2)}%)\n` +
            `Last seen before close — check History for exact figure`;
          await sendTelegram(text);
        }
      }
    }
    prevOpen = openNow;

  } catch (e) {
  } finally {
    alertRunning = false;
  }
}

// --- LOGIN GATE ---
app.post("/api/login", (req, res) => {
  if (!APP_PASSWORD) return res.status(500).json({ ok: false, error: "APP_PASSWORD belum diset di Secrets" });

  const now = Date.now();
  // prune entri basi biar map gak numpuk
  for (const k in loginAttempts) {
    if (loginAttempts[k].lockUntil < now && loginAttempts[k].count === 0) delete loginAttempts[k];
  }

  const parts = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : (req.ip || "unknown");
  const rec = loginAttempts[key] || { count: 0, lockUntil: 0 };

  // lagi kekunci?
  if (rec.lockUntil > now) {
    const sisa = Math.ceil((rec.lockUntil - now) / 1000);
    return res.status(429).json({ ok: false, error: "Kebanyakan salah. Coba lagi " + sisa + " detik." });
  }

  if (req.body.password === APP_PASSWORD) {
    delete loginAttempts[key]; // sukses → reset hitungan
    return res.json({ ok: true, token: makeToken() });
  }

  // salah → tambah hitungan
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.lockUntil = now + LOGIN_LOCK_MS;
    rec.count = 0;
    loginAttempts[key] = rec;
    return res.status(429).json({ ok: false, error: "Kebanyakan salah. Kekunci " + (LOGIN_LOCK_MS / 60000) + " menit." });
  }
  loginAttempts[key] = rec;
  return res.status(401).json({ ok: false, error: "Password salah. Sisa " + (LOGIN_MAX_FAILS - rec.count) + " percobaan." });
});

// semua /api/* di bawah baris ini WAJIB token valid (kecuali /api/login di atas)
app.use("/api", requireAuth);
// --- END LOGIN GATE ---
app.get("/api/balance", async (req, res) => {
  try { res.json(await signedRequest("GET", "/fapi/v2/balance")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/price", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const price = await getPrice(symbol);
    res.json({ symbol, price });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/data", async (req, res) => {
  try {
    const account = await signedRequest("GET", "/fapi/v2/account");
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");

    const marginBalance = Number(account.totalMarginBalance);
    const totalMaintMargin = Number(account.totalMaintMargin);
    const accountMarginRatio = marginBalance > 0 ? (totalMaintMargin / marginBalance) * 100 : 0;

    const acctPos = {};
    (account.positions || []).forEach(p => { acctPos[p.symbol + "_" + p.positionSide] = p; });

    const positions = risk
      .filter(p => Number(p.positionAmt) !== 0)
      .map(p => {
        const amt = Number(p.positionAmt);
        const entry = Number(p.entryPrice);
        const lev = Number(p.leverage);
        const pnl = Number(p.unRealizedProfit);
        const initialMargin = (entry * Math.abs(amt)) / lev;
        const roi = initialMargin > 0 ? (pnl / initialMargin) * 100 : 0;
        const side = p.positionSide && p.positionSide !== "BOTH"
          ? p.positionSide
          : (amt > 0 ? "LONG" : "SHORT");

        const ap = acctPos[p.symbol + "_" + p.positionSide];
        let marginRatio = null;
        if (ap && marginBalance > 0) marginRatio = (Number(ap.maintMargin) / marginBalance) * 100;

        return {
          symbol: p.symbol, side, size: Math.abs(amt),
          entryPrice: entry, markPrice: Number(p.markPrice),
          pnl, roi, liqPrice: Number(p.liquidationPrice),
          leverage: lev, marginType: p.marginType,
          margin: initialMargin,
          marginRatio,
          positionSide: p.positionSide,
        };
      });

    res.json({
      marginBalance,
      unrealizedPnl: Number(account.totalUnrealizedProfit),
      availableBalance: Number(account.availableBalance),
      marginRatio: accountMarginRatio,
      positions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leverage", async (req, res) => {
  try {
    const { symbol, leverage } = req.body;
    res.json(await signedRequest("POST", "/fapi/v1/leverage", {
      symbol: String(symbol).toUpperCase(), leverage,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/margin", async (req, res) => {
  try {
    const { symbol, marginType } = req.body;
    res.json(await signedRequest("POST", "/fapi/v1/marginType", {
      symbol: String(symbol).toUpperCase(), marginType,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/margin-type", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "").toUpperCase();
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk", { symbol: sym });
    const entry = Array.isArray(risk) ? (risk.find(p => p.symbol === sym) || risk[0]) : risk;
    const mt = entry && entry.marginType ? entry.marginType : null; // "cross" | "isolated"
    res.json({ symbol: sym, marginType: mt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/mode", async (req, res) => {
  try {
    res.json(await signedRequest("GET", "/fapi/v1/positionSide/dual"));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/mode", async (req, res) => {
  try {
    const { hedge } = req.body;
    res.json(await signedRequest("POST", "/fapi/v1/positionSide/dual", {
      dualSidePosition: hedge ? "true" : "false",
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/order", async (req, res) => {
  try {
    const { symbol, side, usdt, leverage, tp, sl, positionSide } = req.body;
    const sym = String(symbol).toUpperCase();
    const hedge = positionSide && positionSide !== "BOTH";
    const orderType = (req.body.orderType || "MARKET").toUpperCase(); // MARKET | LIMIT
    const note = [];

    // 1) Set leverage + tau leverage ASLI yang dipakai Binance
    let effectiveLev = Number(leverage) || 1;
    if (leverage) {
      let levRes = await signedRequest("POST", "/fapi/v1/leverage", { symbol: sym, leverage });
      if (levRes.leverage) {
        effectiveLev = Number(levRes.leverage);
      } else {
        const maxLev = await getMaxLeverage(sym);
        if (maxLev && Number(leverage) > maxLev) {
          levRes = await signedRequest("POST", "/fapi/v1/leverage", { symbol: sym, leverage: maxLev });
          if (!levRes.leverage) {
            return res.json({ error: "Set leverage gagal buat " + sym + ": " + (levRes.msg || JSON.stringify(levRes)) });
          }
          effectiveLev = Number(levRes.leverage);
          note.push("⚠️ " + sym + " max " + effectiveLev + "x — di-cap dari " + leverage + "x");
        } else {
          return res.json({ error: "Set leverage gagal buat " + sym + ": " + (levRes.msg || JSON.stringify(levRes)) });
        }
      }
    }

    // 2) Tick size (buat bulatin limit price & TP/SL)
    const tickSize = await getTickSize(sym);

    // 3) Limit price (kalau LIMIT)
    let limitPx = null;
    if (orderType === "LIMIT") {
      const raw = Number(req.body.limitPrice);
      if (!raw || raw <= 0) return res.json({ error: "Limit price wajib diisi & > 0." });
      limitPx = tickSize ? roundToTick(raw, tickSize) : String(raw);
    }

    // 4) Quantity dari leverage ASLI + harga acuan (limit pakai limitPx)
    let quantity;
    if (usdt) {
      const stepSize = await getStepSize(sym);
      const basePrice = orderType === "LIMIT" ? Number(limitPx) : await getPrice(sym);
      if (!basePrice || !stepSize) return res.json({ error: "Cannot get price/stepSize for " + sym });
      const notional = Number(usdt) * effectiveLev;
      quantity = roundToStep(notional / basePrice, stepSize);
      if (Number(quantity) <= 0) {
        return res.json({ error: "Margin too small (qty rounds to 0). Naikkan margin atau leverage." });
      }
    } else {
      quantity = req.body.quantity;
    }

    // 4b) Cap qty ke max quantity symbol (MARKET_LOT_SIZE / LOT_SIZE)
    const maxQty = await getMaxQty(sym, orderType);
    if (maxQty && Number(quantity) > maxQty) {
      const stepSize = await getStepSize(sym);
      const capped = stepSize ? roundToStep(maxQty, stepSize) : String(maxQty);
      note.push("⚠️ " + sym + " max qty " + maxQty + " — di-cap dari " + quantity + " → " + capped);
      quantity = capped;
    }

    // 5) Entry order (MARKET atau LIMIT GTC)
    const entryParams = { symbol: sym, side, quantity };
    if (orderType === "LIMIT") {
      entryParams.type = "LIMIT";
      entryParams.price = limitPx;
      entryParams.timeInForce = "GTC";
    } else {
      entryParams.type = "MARKET";
    }
    if (hedge) entryParams.positionSide = positionSide;
    const entry = await signedRequest("POST", "/fapi/v1/order", entryParams);
    if (!entry.orderId) return res.json(entry);

    // 6) TP/SL conditional via algoOrder
    const closeSide = side === "BUY" ? "SELL" : "BUY";
    const extra = [];

    if (tp) {
      const trigger = tickSize ? roundToTick(Number(tp), tickSize) : tp;
      const tpParams = { symbol: sym, algoType: "CONDITIONAL", side: closeSide, type: "TAKE_PROFIT_MARKET", triggerPrice: trigger, closePosition: "true" };
      if (hedge) tpParams.positionSide = positionSide;
      const tpRes = await signedRequest("POST", "/fapi/v1/algoOrder", tpParams);
      extra.push(tpRes.algoId ? "TP ✓" : ("TP failed: " + (tpRes.msg || "")));
    }

    if (sl) {
      const trigger = tickSize ? roundToTick(Number(sl), tickSize) : sl;
      const slParams = { symbol: sym, algoType: "CONDITIONAL", side: closeSide, type: "STOP_MARKET", triggerPrice: trigger, closePosition: "true" };
      if (hedge) slParams.positionSide = positionSide;
      const slRes = await signedRequest("POST", "/fapi/v1/algoOrder", slParams);
      extra.push(slRes.algoId ? "SL ✓" : ("SL failed: " + (slRes.msg || "")));
    }

    res.json({ orderId: entry.orderId, quantity, leverage: effectiveLev, type: orderType, extra: extra.concat(note) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/api/close", async (req, res) => {
  try {
    const { symbol, positionSide } = req.body;
    const sym = String(symbol).toUpperCase();
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const target = risk.find(p =>
      p.symbol === sym &&
      Number(p.positionAmt) !== 0 &&
      (!positionSide || p.positionSide === positionSide)
    );
    if (!target) return res.json({ msg: "No matching open position" });
    res.json(await closeOnePosition(target));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/close-all", async (req, res) => {
  try {
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const open = risk.filter(p => Number(p.positionAmt) !== 0);
    const closed = [];
    for (const p of open) {
      const r = await closeOnePosition(p);
      closed.push({
        symbol: p.symbol,
        side: p.positionSide,
        ok: !!r.orderId,
        msg: r.msg || null,
      });
    }
    res.json({ closed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/close-partial", async (req, res) => {
  try {
    const { symbol, positionSide, percent } = req.body;
    const sym = String(symbol).toUpperCase();
    const pct = Number(percent);
    if (!pct || pct <= 0 || pct > 100) return res.json({ error: "Percent harus 1–100." });

    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const pos = risk.find(p =>
      p.symbol === sym &&
      Number(p.positionAmt) !== 0 &&
      (!positionSide || positionSide === "BOTH" || p.positionSide === positionSide)
    );
    if (!pos) return res.json({ error: "Posisi " + sym + " gak ketemu." });

    const amt = Number(pos.positionAmt);
    const closeSide = amt > 0 ? "SELL" : "BUY";
    const stepSize = await getStepSize(sym);
    let qty = Math.abs(amt) * (pct / 100);
    qty = stepSize ? roundToStep(qty, stepSize) : String(qty);
    if (Number(qty) <= 0) return res.json({ error: "Qty partial kebuletin jadi 0. Pakai % lebih gede." });

    const params = { symbol: sym, side: closeSide, type: "MARKET", quantity: qty };
    if (pos.positionSide && pos.positionSide !== "BOTH") params.positionSide = pos.positionSide;
    else params.reduceOnly = "true";

    const r = await signedRequest("POST", "/fapi/v1/order", params);
    if (r.orderId) res.json({ ok: true, orderId: r.orderId, qty, percent: pct });
    else res.json({ error: r.msg || JSON.stringify(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/close-limit", async (req, res) => {
  try {
    const { symbol, positionSide, quantity, price } = req.body;
    const sym = String(symbol).toUpperCase();
    const px = Number(price);
    if (!px || px <= 0) return res.json({ error: "Price wajib > 0." });
    const qtyReq = Number(quantity);
    if (!qtyReq || qtyReq <= 0) return res.json({ error: "Quantity wajib > 0." });

    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const pos = risk.find(p =>
      p.symbol === sym &&
      Number(p.positionAmt) !== 0 &&
      (!positionSide || positionSide === "BOTH" || p.positionSide === positionSide)
    );
    if (!pos) return res.json({ error: "Posisi " + sym + " gak ketemu." });

    const amt = Number(pos.positionAmt);
    const isLong = pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0);
    const closeSide = isLong ? "SELL" : "BUY";
    const hedge = pos.positionSide && pos.positionSide !== "BOTH";

    const tickSize = await getTickSize(sym);
    const limitPx = tickSize ? roundToTick(px, tickSize) : String(px);

    const stepSize = await getStepSize(sym);
    const qty = stepSize ? roundToStep(qtyReq, stepSize) : String(qtyReq);
    if (Number(qty) <= 0) return res.json({ error: "Quantity kebuletin jadi 0." });

    const params = {
      symbol: sym, side: closeSide, type: "LIMIT",
      quantity: qty, price: limitPx, timeInForce: "GTC",
    };
    if (hedge) params.positionSide = pos.positionSide;
    else params.reduceOnly = "true";

    const r = await signedRequest("POST", "/fapi/v1/order", params);
    if (r.orderId) res.json({ ok: true, orderId: r.orderId, price: limitPx, qty });
    else res.json({ error: r.msg || JSON.stringify(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/open-orders", async (req, res) => {
  try {
    const orders = await signedRequest("GET", "/fapi/v1/openOrders");
    if (!Array.isArray(orders)) return res.json({ error: orders.msg || JSON.stringify(orders) });
    res.json({
      orders: orders.map(o => ({
        symbol: o.symbol,
        orderId: o.orderId,
        side: o.side,
        type: o.type,
        price: Number(o.price),
        stopPrice: Number(o.stopPrice),
        qty: o.origQty,
        positionSide: o.positionSide,
        status: o.status,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/cancel-order", async (req, res) => {
  try {
    const { symbol, orderId } = req.body;
    res.json(await signedRequest("DELETE", "/fapi/v1/order", {
      symbol: String(symbol).toUpperCase(),
      orderId,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/algo-orders", async (req, res) => {
  try {
    const orders = await signedRequest("GET", "/fapi/v1/openAlgoOrders");
    if (!Array.isArray(orders)) return res.json({ error: orders.msg || JSON.stringify(orders) });
    res.json({
      orders: orders.map(o => ({
        algoId: o.algoId,
        symbol: o.symbol,
        orderType: o.orderType,        // TAKE_PROFIT_MARKET / STOP_MARKET
        side: o.side,
        positionSide: o.positionSide,
        triggerPrice: Number(o.triggerPrice),
        closePosition: o.closePosition,
        quantity: o.quantity,
        status: o.algoStatus,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/cancel-algo", async (req, res) => {
  try {
    const { algoId } = req.body;
    res.json(await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/cancel-all-orders", async (req, res) => {
  try {
    let cancelled = 0, failed = 0;
    // limit entry orders
    const open = await signedRequest("GET", "/fapi/v1/openOrders");
    if (Array.isArray(open)) {
      for (const o of open) {
        const r = await signedRequest("DELETE", "/fapi/v1/order", { symbol: o.symbol, orderId: o.orderId });
        if (r.orderId || r.status === "CANCELED") cancelled++; else failed++;
      }
    }
    // TP/SL conditional (algo) orders
    const algos = await signedRequest("GET", "/fapi/v1/openAlgoOrders");
    if (Array.isArray(algos)) {
      for (const a of algos) {
        const r = await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId: a.algoId });
        if (r.code === "200" || r.code === 200 || r.algoId) cancelled++; else failed++;
      }
    }
    res.json({ ok: true, cancelled, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post("/api/set-stop", async (req, res) => {
  try {
    const { symbol, positionSide, kind, triggerPrice } = req.body;
    const sym = String(symbol).toUpperCase();
    const k = String(kind).toUpperCase(); // "TP" | "SL"
    if (!triggerPrice || Number(triggerPrice) <= 0) return res.json({ error: "Trigger price wajib > 0." });

    // cari posisi yang dimaksud
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const pos = risk.find(p =>
      p.symbol === sym &&
      Number(p.positionAmt) !== 0 &&
      (!positionSide || positionSide === "BOTH" || p.positionSide === positionSide)
    );
    if (!pos) return res.json({ error: "Posisi " + sym + " gak ketemu." });

    const amt = Number(pos.positionAmt);
    const isLong = pos.positionSide === "LONG" || (pos.positionSide === "BOTH" && amt > 0);
    const closeSide = isLong ? "SELL" : "BUY";
    const hedge = pos.positionSide && pos.positionSide !== "BOTH";

    const tickSize = await getTickSize(sym);
    const trigger = tickSize ? roundToTick(Number(triggerPrice), tickSize) : String(triggerPrice);

    // cancel TP/SL lama yang sejenis buat posisi ini → biar jadi "update", bukan numpuk
    const wantType = k === "TP" ? "TAKE_PROFIT" : "STOP";
    let cancelled = 0;
    try {
      const algos = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: sym });
      if (Array.isArray(algos)) {
        for (const a of algos) {
          const sameKind = (a.orderType || "").includes(wantType);
          const samePos = !hedge || a.positionSide === pos.positionSide;
          if (sameKind && samePos && a.algoId) {
            await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId: a.algoId });
            cancelled++;
          }
        }
      }
    } catch (e) {}

    // pasang yang baru (closePosition: nutup full pas trigger)
    const params = {
      symbol: sym,
      algoType: "CONDITIONAL",
      side: closeSide,
      type: k === "TP" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET",
      triggerPrice: trigger,
      closePosition: "true",
    };
    if (hedge) params.positionSide = pos.positionSide;
    const r = await signedRequest("POST", "/fapi/v1/algoOrder", params);
    if (r.algoId) res.json({ ok: true, algoId: r.algoId, kind: k, trigger, replaced: cancelled });
    else res.json({ error: (r.msg || JSON.stringify(r)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/history", async (req, res) => {
  try {
    const days = 7;
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const income = await signedRequest("GET", "/fapi/v1/income", { startTime, limit: 1000 });
    if (!Array.isArray(income)) return res.json({ error: income.msg || JSON.stringify(income) });

    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const todayStart = d.getTime();

    let todayPnl = 0, todayFees = 0, todayFunding = 0;
    const trades = [];

    for (const it of income) {
      const amt = Number(it.income);
      const t = Number(it.time);
      const isToday = t >= todayStart;
      if (it.incomeType === "REALIZED_PNL") {
        if (isToday) todayPnl += amt;
        trades.push({ symbol: it.symbol, amount: amt, time: t });
      } else if (it.incomeType === "COMMISSION" && isToday) {
        todayFees += amt;
      } else if (it.incomeType === "FUNDING_FEE" && isToday) {
        todayFunding += amt;
      }
    }
    trades.sort((a, b) => b.time - a.time);

    res.json({
      today: { pnl: todayPnl, fees: todayFees, funding: todayFunding, net: todayPnl + todayFees + todayFunding },
      trades: trades.slice(0, 50),
      days,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/test-telegram", async (req, res) => {
  const r = await sendTelegram("✅ Test from Binance Tracker — Telegram connected!");
  res.json(r);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server nyala!");
  setInterval(checkAlerts, 5000);
});
