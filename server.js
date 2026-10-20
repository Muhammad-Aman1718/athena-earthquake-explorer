import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = "ui://widget/quakes.html";
// Pre-generated summary feeds: CDN-cached and much faster than the FDSN query API
const FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
const PERIODS = new Set(["hour", "day", "week", "month"]);
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_QUAKES = 300;

// Read once at startup; served from memory on every request
const WIDGET_HTML = readFileSync(join(__dirname, "public", "widget.html"), "utf8");

// ---- Data: USGS Earthquake Hazards Program (public, no API key) ----
function feedUrl(timeRange, minMagnitude) {
  const period = PERIODS.has(timeRange) ? timeRange : "day";
  const level =
    minMagnitude >= 4.5 ? "4.5" : minMagnitude >= 2.5 ? "2.5" : minMagnitude >= 1 ? "1.0" : "all";
  return `${FEED_BASE}/${level}_${period}.geojson`;
}

const cache = new Map(); // url -> { features, fetchedAt }
const inFlight = new Map(); // url -> Promise<{ features, fetchedAt }>

async function downloadFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "athena-quake-explorer" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`USGS responded ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.features))
      throw new Error("Unexpected USGS response format");
    const entry = { features: json.features, fetchedAt: Date.now() };
    cache.set(url, entry);
    return entry;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(`USGS did not respond within ${FETCH_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { features, fetchedAt, stale }. Falls back to stale cache if USGS fails.
async function getFeed(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return { ...hit, stale: false };

  let pending = inFlight.get(url);
  if (!pending) {
    pending = downloadFeed(url).finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
  }
  try {
    return { ...(await pending), stale: false };
  } catch (e) {
    const old = cache.get(url);
    if (old) {
      console.warn(`USGS fetch failed (${e.message}); serving stale cache for ${url}`);
      return { ...old, stale: true };
    }
    throw e;
  }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function toQuake(f) {
  const p = f && f.properties;
  const c = f && f.geometry && f.geometry.coordinates;
  if (!p || !Array.isArray(c) || !isNum(c[0]) || !isNum(c[1])) return null;
  if (!isNum(p.mag) || !isNum(p.time)) return null;
  return {
    id: String(f.id ?? `${p.time}-${c[0]}-${c[1]}`),
    mag: Math.round(p.mag * 10) / 10,
    place: typeof p.place === "string" && p.place ? p.place : "Unknown location",
    time: p.time,
    depth: Math.round((isNum(c[2]) ? c[2] : 0) * 10) / 10,
    lon: c[0],
    lat: c[1],
    tsunami: p.tsunami === 1,
    alert: p.alert ?? null,
    felt: p.felt ?? null,
    url: typeof p.url === "string" ? p.url : "",
  };
}

async function fetchQuakes({
  timeRange = "day",
  minMagnitude = 2.5,
  place = "",
}) {
  const minMag = isNum(minMagnitude) ? minMagnitude : 2.5;
  const feed = await getFeed(feedUrl(timeRange, minMag));

  const needle = (place || "").trim().toLowerCase();
  const quakes = [];
  for (const f of feed.features) {
    const q = toQuake(f);
    if (!q || q.mag < minMag) continue;
    if (needle && !q.place.toLowerCase().includes(needle)) continue;
    quakes.push(q);
  }
  quakes.sort((a, b) => b.time - a.time);
  const capped = quakes.slice(0, MAX_QUAKES);

  const data = {
    query: { timeRange, minMagnitude: minMag, place: place || null },
    count: capped.length,
    fetchedAt: new Date(feed.fetchedAt).toISOString(),
    source: "USGS Earthquake Hazards Program",
    quakes: capped,
  };
  if (feed.stale) data.stale = true;
  return data;
}

function summary(data) {
  const { count, query, quakes } = data;
  const where = query.place ? ` matching "${query.place}"` : "";
  if (!count)
    return `No earthquakes of M${query.minMagnitude}+ in the past ${query.timeRange}${where}.`;
  const top = quakes.reduce((a, b) => (b.mag > a.mag ? b : a));
  return `${count} earthquakes of M${query.minMagnitude}+ in the past ${query.timeRange}${where}. Strongest: M${top.mag} ${top.place}, depth ${top.depth} km.`;
}

// ---- MCP server ----
function buildServer() {
  const server = new McpServer({
    name: "earthquake-explorer",
    version: "1.0.0",
  });

  server.registerResource(
    "quake-widget",
    WIDGET_URI,
    { title: "Earthquake Explorer widget", mimeType: "text/html+skybridge" },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html+skybridge",
          text: WIDGET_HTML,
        },
      ],
    }),
  );

  server.registerTool(
    "get_recent_earthquakes",
    {
      title: "Get recent earthquakes",
      description:
        "Fetch recent earthquakes from the USGS public feed and show them in the interactive Earthquake Explorer widget. Filter by time range, minimum magnitude and place name (e.g. 'Japan', 'Alaska', 'California').",
      inputSchema: {
        timeRange: z
          .enum(["hour", "day", "week", "month"])
          .default("day")
          .describe("How far back to look"),
        minMagnitude: z
          .number()
          .min(0)
          .max(9)
          .default(2.5)
          .describe("Minimum magnitude"),
        place: z
          .string()
          .optional()
          .describe("Optional place/region text to match, e.g. 'Japan'"),
      },
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Reading the seismograph…",
        "openai/toolInvocation/invoked": "Earthquakes loaded",
      },
    },
    async (args) => {
      let data;
      try {
        data = await fetchQuakes(args);
      } catch (e) {
        console.error("get_recent_earthquakes failed:", e.message);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Couldn't reach the USGS earthquake feed right now (${e.message}). Please try again in a moment.`,
            },
          ],
        };
      }
      const text = summary(data) + (data.stale ? " (Showing cached data; USGS is temporarily unreachable.)" : "");
      return {
        content: [{ type: "text", text }],
        structuredContent: data,
        _meta: { "openai/outputTemplate": WIDGET_URI },
      };
    },
  );

  return server;
}

// ---- HTTP ----
const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) =>
  res
    .type("text")
    .send("Earthquake Explorer MCP server is running. MCP endpoint: POST /mcp"),
);

// Standalone preview of the widget with live data (for local testing only)
app.get("/widget", (_req, res) => res.type("html").send(WIDGET_HTML));
app.get("/api/quakes", async (req, res) => {
  try {
    res.json(
      await fetchQuakes({
        timeRange: req.query.timeRange || "day",
        minMagnitude: Number(req.query.minMagnitude ?? 2.5),
        place: req.query.place || "",
      }),
    );
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent)
      res
        .status(500)
        .json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
  }
});
app.all("/mcp", (_req, res) =>
  res
    .status(405)
    .json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    }),
);

// Global error handler (also catches malformed JSON bodies)
app.use((err, req, res, _next) => {
  console.error(`Error on ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (req.path === "/mcp") {
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? "Parse error" : "Internal error" },
      id: null,
    });
  } else {
    res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
  }
});

process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () =>
  console.log(`Earthquake Explorer MCP on http://localhost:${PORT}/mcp`),
);
