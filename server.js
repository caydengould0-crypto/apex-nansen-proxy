// ─────────────────────────────────────────────────────────────────────────────
// Apex Alpha — Nansen MCP Proxy
// Deploy on Railway. Bridges browser → Nansen MCP server.
// Research only. No trade execution.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const NANSEN_MCP_URL = "https://mcp.nansen.ai/ra/mcp/";

// Helper: call Nansen MCP with a tool request
async function nansenMCP(apiKey, toolName, toolInput = {}) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: toolInput,
    },
  };

  const res = await fetch(NANSEN_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "NANSEN-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nansen MCP error ${res.status}: ${text}`);
  }

  return res.json();
}

// ── GET /ping ─────────────────────────────────────────────────────────────────
// Test if the proxy is alive and the API key works
app.get("/ping", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ ok: false, error: "No API key" });

  try {
    // List available tools to verify key works
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };

    const r = await fetch(NANSEN_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "NANSEN-API-KEY": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ ok: false, error: `Nansen: ${r.status} ${text}` });
    }

    const data = await r.json();
    const tools = data?.result?.tools?.map((t) => t.name) || [];
    return res.json({ ok: true, tools, credits: data?.result?.meta?.creditsRemaining ?? null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /tools ────────────────────────────────────────────────────────────────
// List all available Nansen MCP tools
app.get("/tools", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  try {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const r = await fetch(NANSEN_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "NANSEN-API-KEY": apiKey },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.json(data?.result || data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /wallet/:address ──────────────────────────────────────────────────────
// Full wallet profile: portfolio + trade history
app.get("/wallet/:address", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  const { address } = req.params;

  try {
    // Try to get wallet portfolio
    const [portfolio, trades] = await Promise.allSettled([
      nansenMCP(apiKey, "get_wallet_portfolio", { address }),
      nansenMCP(apiKey, "get_wallet_trades", { address, limit: 100 }),
    ]);

    const portfolioData = portfolio.status === "fulfilled" ? portfolio.value?.result : null;
    const tradesData = trades.status === "fulfilled" ? trades.value?.result : null;

    if (!portfolioData && !tradesData) {
      return res.status(404).json({ error: "No data found for this wallet" });
    }

    // Normalize to Apex Alpha WalletData shape
    const closedTrades = (tradesData?.trades || tradesData?.content?.[0]?.trades || [])
      .filter((t) => t.status === "CLOSED" || t.exitPrice)
      .map((t) => ({
        token: t.symbol || t.token,
        chain: t.chain,
        size: t.sizeUsd || t.valueUsd,
        entry: t.entryPrice || t.avgCost,
        exit: t.exitPrice,
        pnl: t.pnlPct || (t.exitPrice && t.entryPrice
          ? (((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2)
          : null),
        holdHours: t.holdHours || (t.openedAt && t.closedAt
          ? Math.round((new Date(t.closedAt) - new Date(t.openedAt)) / 3600000)
          : null),
        closedAt: t.closedAt,
      }));

    const openPositions = (
      portfolioData?.holdings ||
      portfolioData?.content?.[0]?.holdings || []
    ).map((h) => ({
      token: h.symbol || h.token,
      chain: h.chain,
      size: h.valueUsd || h.currentValue,
      entry: h.avgCost || h.avgBuyPrice,
      current: h.currentPrice,
      pnl: h.unrealizedPnlPct || h.pnlPct,
      openedAt: h.firstBought || h.openedAt,
    }));

    const label =
      portfolioData?.label ||
      portfolioData?.content?.[0]?.label ||
      tradesData?.label ||
      null;

    res.json({
      address,
      source: "nansen",
      sourceList: ["nansen"],
      dataQuality: "real",
      lastUpdated: new Date().toISOString(),
      label,
      openPositions,
      closedTrades,
      realizedPnl: tradesData?.totalRealizedPnl ?? portfolioData?.realizedPnl ?? null,
      unrealizedPnl: portfolioData?.totalUnrealizedPnl ?? null,
      chains: [...new Set([
        ...closedTrades.map((t) => t.chain),
        ...openPositions.map((p) => p.chain),
      ])].filter(Boolean),
      _raw: { portfolio: portfolioData, trades: tradesData },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /smartmoney ───────────────────────────────────────────────────────────
// Top smart money wallets leaderboard
app.get("/smartmoney", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  const limit = parseInt(req.query.limit) || 20;

  try {
    const result = await nansenMCP(apiKey, "get_smart_money_wallets", { limit });
    const wallets = result?.result?.wallets || result?.result?.content?.[0]?.wallets || [];
    res.json({ wallets, count: wallets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /wallet/:address/positions ────────────────────────────────────────────
// Current open positions only (for alert diffing)
app.get("/wallet/:address/positions", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  try {
    const result = await nansenMCP(apiKey, "get_wallet_portfolio", {
      address: req.params.address,
    });
    const holdings = result?.result?.holdings || result?.result?.content?.[0]?.holdings || [];
    res.json({ positions: holdings, address: req.params.address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /token/:address/holders ───────────────────────────────────────────────
// Smart money holders of a token (for convergence alerts)
app.get("/token/:address/smartmoney", async (req, res) => {
  const apiKey = req.headers["nansen-api-key"];
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  try {
    const result = await nansenMCP(apiKey, "get_token_smart_money", {
      tokenAddress: req.params.address,
    });
    res.json(result?.result || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "Apex Alpha — Nansen Proxy",
    version: "1.0.0",
    status: "running",
    note: "Research only. No trade execution.",
    endpoints: ["/ping", "/tools", "/wallet/:address", "/wallet/:address/positions", "/smartmoney", "/token/:address/smartmoney"],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nansen proxy running on port ${PORT}`));
