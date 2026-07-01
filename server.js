// Apex Alpha — Nansen MCP Proxy v3
// Uses correct Nansen MCP tool names from docs.nansen.ai/mcp/tools
// Research only. No trade execution.

const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const NANSEN_MCP_URL = "https://mcp.nansen.ai/ra/mcp/";

async function nansenCall(apiKey, method, params = {}) {
  const res = await fetch(NANSEN_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "NANSEN-API-KEY": apiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  if (!res.ok) throw new Error(`Nansen ${res.status}: ${await res.text()}`);

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    let result = null;
    for (const line of text.split("\n").filter(l => l.startsWith("data:"))) {
      try {
        const json = JSON.parse(line.slice(5).trim());
        if (json.result !== undefined) result = json;
        else if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      } catch (e) { if (e.message.length > 5) throw e; }
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
    res.json({ ok: true, tools, latency: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
    const [portfolio, pnl, trades] = await Promise.allSettled([
      nansenCall(apiKey, "tools/call", { name: "address_portfolio", arguments: { request: { wallet_address: address } } }),
      nansenCall(apiKey, "tools/call", { name: "wallet_pnl_summary", arguments: { request: { address } } }),
      nansenCall(apiKey, "tools/call", { name: "wallet_trades", arguments: { request: { addresses: [address], limit: 100 } } }),
    ]);
    const pData = portfolio.status === "fulfilled" ? portfolio.value?.result : null;
    const pnlData = pnl.status === "fulfilled" ? pnl.value?.result : null;
    const tData = trades.status === "fulfilled" ? trades.value?.result : null;
    if (!pData && !pnlData && !tData) return res.status(404).json({ error: "No data returned from Nansen" });
    const holdings = pData?.holdings || pData?.portfolio || pData?.content?.[0]?.holdings || [];
    const tradeList = tData?.trades || tData?.content?.[0]?.trades || tData?.data || [];
    const openPositions = holdings.map(h => ({
      token: h.symbol || h.tokenSymbol || h.name, chain: h.chain || h.chainId,
      size: h.valueUsd || h.value_usd || h.balanceUsd,
      entry: h.avgCost || h.avg_cost || null, current: h.currentPrice || h.price || null,
      pnl: h.unrealizedPnlPct || h.unrealized_pnl_pct || null,
      openedAt: h.firstBought || h.first_bought || null,
    }));
    const closedTrades = tradeList.filter(t => t.type === "SELL" || t.side === "SELL" || t.exitPrice || t.exit_price).map(t => ({
      token: t.symbol || t.tokenSymbol, chain: t.chain,
      size: t.valueUsd || t.value_usd || t.sizeUsd,
      entry: t.entryPrice || t.entry_price || t.avgCost,
      exit: t.exitPrice || t.exit_price || t.price,
      pnl: t.pnlPct || t.pnl_pct || null, holdHours: t.holdHours || t.hold_hours || null,
      closedAt: t.closedAt || t.closed_at || t.timestamp,
    }));
    res.json({
      address, source: "nansen", sourceList: ["nansen"], dataQuality: "real",
      lastUpdated:
