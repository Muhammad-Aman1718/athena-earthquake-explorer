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
const USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const RANGES = { hour: 1, day: 24, week: 24 * 7, month: 24 * 30 };

const readWidget = () =>
  readFileSync(join(__dirname, "public", "widget.html"), "utf8");

// ---- Data: USGS Earthquake Hazards Program (public, no API key) ----
async function fetchQuakes({
  timeRange = "day",
  minMagnitude = 2.5,
  place = "",
}) {
  const hours = RANGES[timeRange] ?? 24;
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const url = new URL(USGS);
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", start);
  url.searchParams.set("minmagnitude", String(minMagnitude));
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", "400");

  const res = await fetch(url, {
    headers: { "User-Agent": "athena-quake-explorer" },
  });
  if (!res.ok) throw new Error(`USGS responded ${res.status}`);
  const json = await res.json();

  const needle = place.trim().toLowerCase();
  const quakes = json.features
    .map((f) => ({
      id: f.id,
      mag:
        f.properties.mag == null
          ? null
          : Math.round(f.properties.mag * 10) / 10,
      place: f.properties.place || "Unknown location",
      time: f.properties.time,
      depth: Math.round((f.geometry.coordinates[2] ?? 0) * 10) / 10,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      tsunami: f.properties.tsunami === 1,
      alert: f.properties.alert,
      felt: f.properties.felt,
      url: f.properties.url,
    }))
    .filter((q) => q.mag != null)
    .filter((q) => !needle || q.place.toLowerCase().includes(needle));

  return {
    query: { timeRange, minMagnitude, place: place || null },
    count: quakes.length,
    fetchedAt: new Date().toISOString(),
    source: "USGS Earthquake Hazards Program",
    quakes,
  };
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
          text: readWidget(),
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
      const data = await fetchQuakes(args);
      return {
        content: [{ type: "text", text: summary(data) }],
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
app.get("/widget", (_req, res) => res.type("html").send(readWidget()));
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

const PORT = process.env.PORT || 8787;
app.listen(PORT, () =>
  console.log(`Earthquake Explorer MCP on http://localhost:${PORT}/mcp`),
);
