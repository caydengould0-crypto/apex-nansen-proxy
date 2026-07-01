const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const URL = "https://mcp.nansen.ai/ra/mcp/";

async function call(key, method, params) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "NANSEN-API-KEY": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} }),
  });
  if (!r.ok) throw new Error("Nansen " + r.status + ": " + await r.text());
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const txt = await r.text();
    for (const line of txt.split("\n").filter(l => l.startsWith("data:"))) {
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.result !== undefined) return j;
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      } catch(e) { if (e.message && e.message.length > 10) throw e; }
    }
    return null;
  }
  return r.json();
}

app.get("/ping", async (req, res) => {
  const key = req.headers["nansen-api-key"];
  if (!key) return res.status(401).json({ ok: false, error: "No API key" });
  try {
    const t = Date.now();
    const d = await call(key, "tools/list");
    const tools = d && d.result && d.result.tools ? d.result.tools.map(function(x){ return x.name; }) : [];
    res.json({ ok: true, tools: tools, latency: Date.now() - t });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/tools", async (req, res) => {
  const key = req.headers["nansen-api-key"];
  if (!key) return res.status(401).json({ error: "No API key" });
  try {
    const d = await call(key, "tools/list");
    res.json(d && d.result ? d.result : {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/wallet/:address", async (req, res) => {
  const key = req.headers["nansen-api-key"];
  if (!key) return res.status(401).json({ error: "No API key" });
  const addr = req.params.address;
  try {
    const results = await Promise.allSettled([
      call(key, "tools/call", { name: "address_portfolio", arguments: { request: { wallet_address: addr } } }),
      call(key, "tools/call", { name: "wallet_pnl_summary", arguments: { request: { address: addr } } }),
    ]);
    const pData = results[0].status === "fulfilled" && results[0].value ? results[0].value.result : null;
    const pnlData = results[1].status === "fulfilled" && results[1].value ? results[1].value.result : null;
    if (!pData && !pnlData) return res.status(404).json({ error: "No data from Nansen for this address" });
    const holdings = (pData && (pData.holdings || pData.portfolio)) || [];
    const positions = holdings.map(function(h) {
      return { token: h.symbol || h.tokenSymbol || h.name, chain: h.chain || h.chainId, size: h.valueUsd || h.value_usd, entry: h.avgCost || h.avg_cost || null, current: h.currentPrice || h.price || null, pnl: h.unrealizedPnlPct || h.unrealized_pnl_pct || null };
    });
    res.json({
      address: addr, source: "nansen", sourceList: ["nansen"], dataQuality: "real",
      lastUpdated: new Date().toISOString(), label: (pData && pData.label) || (pnlData && pnlData.label) || null,
      openPositions: positions, closedTrades: [],
      realizedPnl: pnlData ? (pnlData.realizedPnl || pnlData.realized_pnl || null) : null,
      unrealizedPnl: pnlData ? (pnlData.unrealizedPnl || pnlData.unrealized_pnl || null) : null,
      winRate: pnlData ? (pnlData.winRate || pnlData.win_rate || null) : null,
      roi: pnlData ? (pnlData.roi || pnlData.totalRoi || null) : null,
      _raw: { pnlSummary: pnlData },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/wallet/:address/positions", async (req, res) => {
  const key = req.headers["nansen-api-key"];
  if (!key) return res.status(401).json({ error: "No API key" });
  try {
    const d = await call(key, "tools/call", { name: "address_portfolio", arguments: { request: { wallet_address: req.params.address } } });
    const h = d && d.result ? (d.result.holdings || d.result.portfolio || []) : [];
    res.json({ positions: h, address: req.params.address });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/smartmoney", async (req, res) => {
  const key = req.headers["nansen-api-key"];
  if (!key) return res.status(401).json({ error: "No API key" });
  try {
    const d = await call(key, "tools/call", { name: "smart_money_token_flow", arguments: { request: { limit: parseInt(req.query.limit) || 20 } } });
    const w = d && d.result ? (d.result.wallets || []) : [];
    res.json({ wallets: w, count: w.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", function(req, res) {
  res.json({ service: "Apex Alpha Nansen Proxy", version: "3.1.0", status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Nansen proxy running on port " + PORT); });
