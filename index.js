const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.static("public"));
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = "https://testnet.binancefuture.com";

function sign(query) {
  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
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

app.get("/api/balance", async (req, res) => {
  try { res.json(await signedRequest("GET", "/fapi/v2/balance")); }
  catch (err) { res.status(500).json({ error: err.message }); }
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

// === 3D: baca position mode akun sekarang (one-way / hedge) ===
app.get("/api/mode", async (req, res) => {
  try {
    res.json(await signedRequest("GET", "/fapi/v1/positionSide/dual"));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// === 3D: nyalain / matiin hedge mode ===
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
    const { symbol, side, quantity, leverage, tp, sl, positionSide } = req.body;
    const sym = String(symbol).toUpperCase();
    const hedge = positionSide && positionSide !== "BOTH";

    if (leverage) {
      await signedRequest("POST", "/fapi/v1/leverage", { symbol: sym, leverage });
    }

    // 1) Buka posisi market
    const entryParams = { symbol: sym, side, type: "MARKET", quantity };
    if (hedge) entryParams.positionSide = positionSide;
    const entry = await signedRequest("POST", "/fapi/v1/order", entryParams);
    if (!entry.orderId) return res.json(entry);

    const closeSide = side === "BUY" ? "SELL" : "BUY";
    const extra = [];

    // 2) Take Profit -> algoOrder
    if (tp) {
      const tpParams = {
        symbol: sym, algoType: "CONDITIONAL", side: closeSide,
        type: "TAKE_PROFIT_MARKET", triggerPrice: tp, closePosition: "true",
      };
      if (hedge) tpParams.positionSide = positionSide;
      const tpRes = await signedRequest("POST", "/fapi/v1/algoOrder", tpParams);
      extra.push(tpRes.algoId ? "TP ✓" : ("TP failed: " + (tpRes.msg || "")));
    }

    // 3) Stop Loss -> algoOrder
    if (sl) {
      const slParams = {
        symbol: sym, algoType: "CONDITIONAL", side: closeSide,
        type: "STOP_MARKET", triggerPrice: sl, closePosition: "true",
      };
      if (hedge) slParams.positionSide = positionSide;
      const slRes = await signedRequest("POST", "/fapi/v1/algoOrder", slParams);
      extra.push(slRes.algoId ? "SL ✓" : ("SL failed: " + (slRes.msg || "")));
    }

    res.json({ orderId: entry.orderId, extra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("✅ Server nyala!"));
