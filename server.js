// ─────────────────────────────────────────────────────────────────────────────
// Apex Alpha — Nansen MCP Proxy v2
// Handles Nansen's SSE-based MCP protocol correctly.
// Research only. No trade execution.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const NANSEN_MCP_URL = "https://mcp.nansen.ai/ra/mcp/";

async function nansenCall(apiKey, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });

  const res = await fetch(NANSEN_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "NANSEN-API-KEY": apiKey,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nansen ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n").filter(l => l.startsWith("data:"));
    let result = null;
    for (const line of lines) {
      try {
        const json = JSON.parse(line.slice(5).trim());
        if (json.result !== undefined) result = json;
        else if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      } catch (e) {
        if (e.message.includes("Nansen")) throw e;
      }
    }
    return result;
  }

  return res.json();
}

app.get("/ping", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ ok: false, error: "No API key" });
  try {
    const t0 = Date.now();
    const data = await nansenCall(apiKey, "tools/list", {});
    const tools = data?.result?.tools?.map(t => t.name) || [];
    return res.json({ ok: true, tools, latency: Date.now() - t0, credits: data?.result?.meta?.creditsRemaining ?? null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/tools", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });
  try {
    const data = await nansenCall(apiKey, "tools/list", {});
    res.json(data?.result || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/wallet/:address", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });
  const { address } = req.params;
  try {
    const [portfolio, trades] = await Promise.allSettled([
      nansenCall(apiKey, "tools/call", { name: "get_wallet_portfolio", arguments: { address } }),
      nansenCall(apiKey, "tools/call", { name: "get_wallet_trades", arguments: { address, limit: 100 } }),
    ]);
    const pData = portfolio.status === "fulfilled" ? portfolio.value?.result : null;
    const tData = trades.status === "fulfilled" ? trades.value?.result : null;
    if (!pData && !tData) return res.status(404).json({ error: "No data found" });
    const holdings = pData?.holdings || pData?.content?.[0]?.holdings || [];
    const tradeList = tData?.trades || tData?.content?.[0]?.trades || [];
    const closedTrades = tradeList.filter(t => t.status === "CLOSED" || t.exitPrice).map(t => ({
      token: t.symbol || t.token, chain: t.chain, size: t.sizeUsd || t.valueUsd,
      entry: t.entryPrice || t.avgCost, exit: t.exitPrice,
      pnl: t.pnlPct ?? (t.exitPrice && t.entryPrice ? +((t.exitPrice - t.entryPrice) / t.entryPrice * 100).toFixed(2) : null),
      holdHours: t.holdHours ?? (t.openedAt && t.closedAt ? Math.round((new Date(t.closedAt) - new Date(t.openedAt)) / 3600000) : null),
      closedAt: t.closedAt,
    }));
    const openPositions = holdings.map(h => ({
      token: h.symbol || h.token, chain: h.chain, size: h.valueUsd || h.currentValue,
      entry: h.avgCost || h.avgBuyPrice, current: h.currentPrice,
      pnl: h.unrealizedPnlPct ?? h.pnlPct, openedAt: h.firstBought || h.openedAt,
    }));
    res.json({
      address, source: "nansen", sourceList: ["nansen"], dataQuality: "real",
      lastUpdated: new Date().toISOString(), label: pData?.label || tData?.label || null,
      openPositions, closedTrades, realizedPnl: tData?.totalRealizedPnl ?? null,
      unrealizedPnl: pData?.totalUnrealizedPnl ?? null,
      chains: [...new Set([...closedTrades.map(t => t.chain), ...openPositions.map(p => p.chain)])].filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/wallet/:address/positions", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });
  try {
    const data = await nansenCall(apiKey, "tools/call", { name: "get_wallet_portfolio", arguments: { address: req.params.address } });
    const holdings = data?.result?.holdings || data?.result?.content?.[0]?.holdings || [];
    res.json({ positions: holdings, address: req.params.address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/smartmoney", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });
  try {
    const data = await nansenCall(apiKey, "tools/call", { name: "get_smart_money_wallets", arguments: { limit: parseInt(req.query.limit) || 20 } });
    const wallets = data?.result?.wallets || data?.result?.content?.[0]?.wallets || [];
    res.json({ wallets, count: wallets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => {
  res.json({ service: "Apex Alpha — Nansen Proxy", version: "2.0.0", status: "running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nansen proxy v2 running on port ${PORT}`));
