# Earthquake Activity Explorer — Athena AI Agent (MCP + interactive widget)

An Athena AI agent backed by an MCP server. It pulls **real, live earthquake data** from the
public USGS Earthquake Hazards Program API (no API key) and renders it in an **interactive
widget embedded in the Athena chat**.

## How it works
1. The user asks Athena about earthquakes.
2. Athena calls the MCP tool `get_recent_earthquakes` (time range, minimum magnitude, place).
3. The server fetches the USGS FDSN event API and returns `structuredContent`.
4. Athena loads the widget resource `ui://widget/quakes.html` (`text/html+skybridge`) and the
   widget reads the data from `window.openai.toolOutput`.

## Widget interactions
| Control | What it does |
|---|---|
| Time range buttons (hour / day / week / month) | Calls the MCP tool again via `window.openai.callTool` and re-renders with fresh USGS data |
| Magnitude slider | Filters earthquakes instantly in the widget |
| Depth chips (shallow / 70–300 km / deep) | Filters by depth band; dots are colored by depth |
| Place search | Filters by place name (e.g. "Japan") |
| Sort toggle | Newest first or strongest first |
| Map dot / list row click | Opens a detail panel (time, depth, coordinates, felt reports, tsunami flag, USGS link) |

## Run locally
```bash
npm install
npm start          # http://localhost:8787/mcp
```
`GET /widget` shows a standalone preview of the widget with live data.

## Deploy (Render)
New Web Service → connect this repo → Build: `npm install` → Start: `npm start`.
MCP URL: `https://<your-service>.onrender.com/mcp`

## Data source
USGS Earthquake Hazards Program — https://earthquake.usgs.gov/fdsnws/event/1/
