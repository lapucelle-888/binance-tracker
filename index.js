const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.static("public"));
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = "https://testnet.binancefuture.com";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_HOURS = 8; // berapa jam token login valid sebelum minta login ulang

const ROI_THRESHOLDS = [-100, -50, -30, -10, 10, 30, 50, 100];
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const lastAlerted = {};
let alertRunning = false;

let exchangeInfoCache = null;

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
  if (!exchangeInfoCache) {
    const r = await fetch(`${BASE_URL}/fapi/v1/exchangeInfo`);
    exchangeInfoCache = await r.json();
  }
  return exchangeInfoCache;
}

async function getStepSize(symbol) {
  const info = await loadExchangeInfo();
  const s = info.symbols.find(x => x.symbol === symbol);
  if (!s) return null;
  const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
  return lot ? lot.stepSize : null;
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

async function checkAlerts() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    const risk = await signedRequest("GET", "/fapi/v2/positionRisk");
    const open = risk.filter(p => Number(p.positionAmt) !== 0);
    const liveIds = new Set();
    const now = Date.now();

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
      lastAlerted[key] = now;

      const pnl = Number(p.unRealizedProfit);
      const emoji = band > 0 ? "🟢" : "🔴";
      const sgn = roi >= 0 ? "+" : "";
      const text =
        `${emoji} ${p.symbol} ${sideLabel}\n` +
        `ROI ${sgn}${roi.toFixed(2)}% (threshold ${band > 0 ? "+" : ""}${band}%)\n` +
        `PNL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;
      await sendTelegram(text);
    }

    for (const key of Object.keys(lastAlerted)) {
      const posId = key.split("_").slice(0, 2).join("_");
      if (!liveIds.has(posId)) delete lastAlerted[key];
    }
  } catch (e) {
  } finally {
    alertRunning = false;
  }
}

// --- LOGIN GATE ---
app.post("/api/login", (req, res) => {
  if (!APP_PASSWORD) return res.status(500).json({ ok: false, error: "APP_PASSWORD belum diset di Secrets" });
  if (req.body.password === APP_PASSWORD) {
    res.json({ ok: true, token: makeToken() });
  } else {
    res.status(401).json({ ok: false, error: "Password salah" });
  }
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
        return {
          symbol: p.symbol, side, size: Math.abs(amt),
          entryPrice: entry, markPrice: Number(p.markPrice),
          pnl, roi, liqPrice: Number(p.liquidationPrice),
          leverage: lev, marginType: p.marginType,
          margin: initialMargin,
          positionSide: p.positionSide,
        };
      });
    res.json({
      marginBalance: Number(account.totalMarginBalance),
      unrealizedPnl: Number(account.totalUnrealizedProfit),
      availableBalance: Number(account.availableBalance),
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

    if (leverage) {
      await signedRequest("POST", "/fapi/v1/leverage", { symbol: sym, leverage });
    }

    let quantity;
    if (usdt) {
      const price = await getPrice(sym);
      const stepSize = await getStepSize(sym);
      if (!price || !stepSize) return res.json({ error: "Cannot get price/stepSize for " + sym });
      const lev = Number(leverage) || 1;
      const notional = Number(usdt) * lev;
      quantity = roundToStep(notional / price, stepSize);
      if (Number(quantity) <= 0) {
        return res.json({ error: "Margin too small (qty rounds to 0). Naikkan margin atau leverage." });
      }
    } else {
      quantity = req.body.quantity;
    }

    const entryParams = { symbol: sym, side, type: "MARKET", quantity };
    if (hedge) entryParams.positionSide = positionSide;
    const entry = await signedRequest("POST", "/fapi/v1/order", entryParams);
    if (!entry.orderId) return res.json(entry);

    const closeSide = side === "BUY" ? "SELL" : "BUY";
    const extra = [];

    let tickSize = null;
    if (tp || sl) tickSize = await getTickSize(sym);

    if (tp) {
      const trigger = tickSize ? roundToTick(Number(tp), tickSize) : tp;
      const tpParams = {
        symbol: sym, algoType: "CONDITIONAL", side: closeSide,
        type: "TAKE_PROFIT_MARKET", triggerPrice: trigger, closePosition: "true",
      };
      if (hedge) tpParams.positionSide = positionSide;
      const tpRes = await signedRequest("POST", "/fapi/v1/algoOrder", tpParams);
      extra.push(tpRes.algoId ? "TP ✓" : ("TP failed: " + (tpRes.msg || "")));
    }

    if (sl) {
      const trigger = tickSize ? roundToTick(Number(sl), tickSize) : sl;
      const slParams = {
        symbol: sym, algoType: "CONDITIONAL", side: closeSide,
        type: "STOP_MARKET", triggerPrice: trigger, closePosition: "true",
      };
      if (hedge) slParams.positionSide = positionSide;
      const slRes = await signedRequest("POST", "/fapi/v1/algoOrder", slParams);
      extra.push(slRes.algoId ? "SL ✓" : ("SL failed: " + (slRes.msg || "")));
    }

    res.json({ orderId: entry.orderId, quantity, extra });
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

app.post("/api/test-telegram", async (req, res) => {
  const r = await sendTelegram("✅ Test from Binance Tracker — Telegram connected!");
  res.json(r);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server nyala!");
  setInterval(checkAlerts, 5000);
});
