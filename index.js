import express from "express";
import cors from "cors";

const app = express();
const PORT = 3001;

// ---------------------------------------------------------------------------
// Flight category helpers
// ---------------------------------------------------------------------------

/**
 * Parse visibility in statute miles from a raw METAR string.
 * Handles: "10SM", "3SM", "2 1/2SM", "3/4SM", "M1/4SM" (return 0).
 * Returns null if no visibility token found.
 */
function parseVisibility(metar) {
  // "M1/4SM" → less-than-quarter mile, treat as 0
  if (/\bM\d+\/\d+SM\b/.test(metar)) return 0;

  // Whole + fraction: "2 1/2SM"
  const mixedMatch = metar.match(/\b(\d+)\s+(\d+)\/(\d+)SM\b/);
  if (mixedMatch) {
    return parseInt(mixedMatch[1]) + parseInt(mixedMatch[2]) / parseInt(mixedMatch[3]);
  }

  // Fraction only: "3/4SM"
  const fracMatch = metar.match(/\b(\d+)\/(\d+)SM\b/);
  if (fracMatch) {
    return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
  }

  // Whole number: "10SM"
  const wholeMatch = metar.match(/\b(\d+)SM\b/);
  if (wholeMatch) return parseInt(wholeMatch[1]);

  return null;
}

/**
 * Parse ceiling in feet from a raw METAR string.
 * Ceiling = lowest BKN or OVC layer. SCT/FEW are ignored.
 * Returns null if no ceiling layer found (sky clear or only SCT/FEW).
 */
function parseCeiling(metar) {
  const layerRe = /\b(BKN|OVC)(\d{3})\b/g;
  let lowestFt = null;
  let match;

  while ((match = layerRe.exec(metar)) !== null) {
    const ft = parseInt(match[2]) * 100;
    if (lowestFt === null || ft < lowestFt) lowestFt = ft;
  }

  return lowestFt;
}

/**
 * Determine FAA flight category from a raw METAR string.
 * Returns { category, visibilitySM, ceilingFt }.
 */
function getFlightCategory(metarString) {
  const vis = parseVisibility(metarString);
  const ceil = parseCeiling(metarString);

  // LIFR: ceiling < 500 ft OR vis < 1 SM
  if ((ceil !== null && ceil < 500) || (vis !== null && vis < 1)) {
    return { category: "LIFR", visibilitySM: vis, ceilingFt: ceil };
  }

  // IFR: ceiling < 1000 ft OR vis < 3 SM
  if ((ceil !== null && ceil < 1000) || (vis !== null && vis < 3)) {
    return { category: "IFR", visibilitySM: vis, ceilingFt: ceil };
  }

  // MVFR: ceiling 1000–3000 ft OR vis 3–5 SM
  if ((ceil !== null && ceil <= 3000) || (vis !== null && vis <= 5)) {
    return { category: "MVFR", visibilitySM: vis, ceilingFt: ceil };
  }

  // VFR: ceiling > 3000 ft AND vis > 5 SM (or sky clear)
  return { category: "VFR", visibilitySM: vis, ceilingFt: ceil };
}

// ---------------------------------------------------------------------------
// METAR / TAF translation
// ---------------------------------------------------------------------------

const SKY_COVER = { FEW: "few clouds", SCT: "scattered clouds", BKN: "broken clouds", OVC: "overcast" };

function translateMetar(metarString) {
  const parts = [];

  // Wind: 28012KT, 28012G18KT, 00000KT, VRB05KT
  const windMatch = metarString.match(/\b(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT\b/);
  if (windMatch) {
    const dir = windMatch[1] === "VRB" ? "variable" : `${windMatch[1]}°`;
    const spd = parseInt(windMatch[2]);
    const gust = windMatch[4] ? ` gusting ${parseInt(windMatch[4])} knots` : "";
    parts.push(spd === 0 ? "Winds calm." : `Wind ${dir} at ${spd} knots${gust}.`);
  }

  // Visibility
  const vis = parseVisibility(metarString);
  if (vis !== null) {
    parts.push(`Visibility ${vis % 1 === 0 ? vis : vis.toFixed(2)} statute mile${vis === 1 ? "" : "s"}.`);
  }

  // Weather phenomena (rain, snow, fog, etc.)
  const wxCodes = {
    RA: "rain", SN: "snow", DZ: "drizzle", TS: "thunderstorm", FG: "fog",
    BR: "mist", HZ: "haze", SQ: "squalls", GR: "hail", GS: "snow pellets",
    UP: "unknown precipitation", FU: "smoke", SA: "sand", DU: "dust",
  };
  const wxIntensity = { "-": "light ", "+": "heavy ", VC: "in vicinity " };
  const wxRe = /\b([-+]|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(RA|SN|DZ|FG|BR|HZ|SQ|GR|GS|UP|FU|SA|DU|TS)\b/g;
  const wxFound = [];
  let wxMatch;
  while ((wxMatch = wxRe.exec(metarString)) !== null) {
    const intensity = wxIntensity[wxMatch[1]] ?? "";
    const phenom = wxCodes[wxMatch[3]] ?? wxMatch[3].toLowerCase();
    wxFound.push(`${intensity}${phenom}`);
  }
  if (wxFound.length) {
    const sentence = wxFound.map((w, i) => i === 0 ? w[0].toUpperCase() + w.slice(1) : w).join(", ");
    parts.push(`${sentence}.`);
  }

  // Sky conditions
  const skyRe = /\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g;
  const layers = [];
  let skyMatch;
  while ((skyMatch = skyRe.exec(metarString)) !== null) {
    const cover = SKY_COVER[skyMatch[1]] ?? skyMatch[1];
    const alt = parseInt(skyMatch[2]) * 100;
    const cb = skyMatch[3] === "CB" ? " with cumulonimbus" : skyMatch[3] === "TCU" ? " with towering cumulus" : "";
    layers.push(`${cover} at ${alt.toLocaleString()} feet${cb}`);
  }
  if (/\b(CLR|SKC|CAVOK)\b/.test(metarString)) layers.push("sky clear");
  if (layers.length) {
    const first = layers[0][0].toUpperCase() + layers[0].slice(1);
    parts.push(`${first}${layers.length > 1 ? ", " + layers.slice(1).join(", ") : ""}.`);
  }

  // Temperature / dewpoint: 05/M01 or M03/M08
  const tempMatch = metarString.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  if (tempMatch) {
    const parse = (s) => (s.startsWith("M") ? -parseInt(s.slice(1)) : parseInt(s));
    parts.push(`Temperature ${parse(tempMatch[1])}°C, dewpoint ${parse(tempMatch[2])}°C.`);
  }

  // Altimeter: A2992
  const altMatch = metarString.match(/\bA(\d{4})\b/);
  if (altMatch) {
    parts.push(`Altimeter ${(parseInt(altMatch[1]) / 100).toFixed(2)} inHg.`);
  }

  return parts.length ? parts.join(" ") : "Unable to translate METAR.";
}

function translateTaf(tafString) {
  if (!tafString || tafString.trim() === "") return "No TAF available.";

  const parts = [];

  // Forecast period: e.g. 2818/2918
  const periodMatch = tafString.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (periodMatch) {
    const fromDay = parseInt(periodMatch[1]);
    const fromHr  = String(parseInt(periodMatch[2])).padStart(2, "0");
    const toDay   = parseInt(periodMatch[3]);
    const toHr    = String(parseInt(periodMatch[4])).padStart(2, "0");
    parts.push(`Forecast valid day ${fromDay} from ${fromHr}:00Z to day ${toDay} ${toHr}:00Z.`);
  }

  // Initial wind
  const windMatch = tafString.match(/\b(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT\b/);
  if (windMatch) {
    const dir = windMatch[1] === "VRB" ? "variable" : `${windMatch[1]}°`;
    const spd = parseInt(windMatch[2]);
    const gust = windMatch[4] ? ` gusting ${parseInt(windMatch[4])} knots` : "";
    parts.push(spd === 0 ? "Winds calm." : `Initial wind ${dir} at ${spd} knots${gust}.`);
  }

  // Initial visibility
  const vis = parseVisibility(tafString);
  if (vis !== null) {
    parts.push(`Visibility ${vis % 1 === 0 ? vis : vis.toFixed(2)} statute mile${vis === 1 ? "" : "s"}.`);
  }

  // First sky layer only (TAF summary)
  const skyRe = /\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/;
  const skyMatch = tafString.match(skyRe);
  if (skyMatch) {
    const cover = SKY_COVER[skyMatch[1]] ?? skyMatch[1];
    const alt = parseInt(skyMatch[2]) * 100;
    const cb = skyMatch[3] === "CB" ? " with cumulonimbus" : skyMatch[3] === "TCU" ? " with towering cumulus" : "";
    const layer = `${cover} at ${alt.toLocaleString()} feet${cb}`;
    parts.push(`${layer[0].toUpperCase() + layer.slice(1)}.`);
  } else if (/\b(SKC|CAVOK)\b/.test(tafString)) {
    parts.push("Sky clear.");
  }

  // Change groups
  const changes = tafString.match(/\b(TEMPO|BECMG|FM\d{6})\b/g) ?? [];
  if (changes.length) {
    parts.push(`Contains ${changes.length} change group${changes.length > 1 ? "s" : ""} (${changes.join(", ")}).`);
  }

  return parts.length ? parts.join(" ") : "Unable to translate TAF.";
}

// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/weather", async (req, res) => {
  const { station } = req.query;

  if (!station || !/^[a-zA-Z]{3,4}$/.test(station)) {
    return res.status(400).json({
      error: "Invalid station. Must be 3–4 letters only (e.g. KORD).",
    });
  }

  const upperStation = station.toUpperCase();
  const BASE = "https://aviationweather.gov/api/data";

  try {
    const [metarRes, tafRes] = await Promise.all([
      fetch(`${BASE}/metar?ids=${upperStation}&format=raw`),
      fetch(`${BASE}/taf?ids=${upperStation}&format=raw`),
    ]);

    if (!metarRes.ok || !tafRes.ok) {
      return res.status(404).json({
        error: `No data found for station "${upperStation}".`,
      });
    }

    const [metar, taf] = await Promise.all([
      metarRes.text(),
      tafRes.text(),
    ]);

    const metarTrimmed = metar.trim();
    const tafTrimmed = taf.trim();
    const { category, visibilitySM, ceilingFt } = getFlightCategory(metarTrimmed);

    res.json({
      station: upperStation,
      metar: metarTrimmed,
      taf: tafTrimmed,
      category,
      visibilitySM,
      ceilingFt,
      translatedMetar: translateMetar(metarTrimmed),
      translatedTaf: translateTaf(tafTrimmed),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Weather fetch error:", err);
    res.status(502).json({ error: "Failed to fetch weather data from AviationWeather.gov." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
