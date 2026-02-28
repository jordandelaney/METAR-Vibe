import { useState, useEffect } from "react";
import "./App.css";

// In dev the Vite proxy handles /api → localhost:3001.
// In production on Vercel, VITE_API_URL is set to the Render backend URL.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

const STORAGE_KEY        = "metar-recent-searches";
const THEME_KEY          = "metar-theme";
const MAX_RECENT         = 6;

const CATEGORY_META = {
  VFR:  { className: "badge-vfr",  cardClass: "card--vfr"  },
  MVFR: { className: "badge-mvfr", cardClass: "card--mvfr" },
  IFR:  { className: "badge-ifr",  cardClass: "card--ifr"  },
  LIFR: { className: "badge-lifr", cardClass: "card--lifr" },
};

function formatFetchedAt(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? []; }
  catch { return []; }
}

function saveRecent(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/* ── Sub-components ─────────────────────────────────────── */

function ThemeToggle({ dark, onToggle }) {
  return (
    <button className="theme-btn" onClick={onToggle} title="Toggle theme">
      {dark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <label className="toggle-label">
      <span className={!checked ? "toggle-opt toggle-opt--active" : "toggle-opt"}>Raw</span>
      <span className="toggle-track" onClick={() => onChange(!checked)}>
        <span className={`toggle-thumb ${checked ? "toggle-thumb--on" : ""}`} />
      </span>
      <span className={checked ? "toggle-opt toggle-opt--active" : "toggle-opt"}>Translated</span>
    </label>
  );
}

function WeatherCard({ title, raw, translated, showTranslated, category }) {
  const tintClass = CATEGORY_META[category]?.cardClass ?? "";
  const content   = showTranslated ? translated : raw;
  return (
    <div className={`card ${tintClass}`}>
      <h2>{title}</h2>
      {showTranslated
        ? <p className="card-translated">{content || `No ${title} available.`}</p>
        : <pre className="card-raw">{content || `No ${title} available.`}</pre>
      }
    </div>
  );
}

/* ── App ────────────────────────────────────────────────── */

export default function App() {
  const [station,        setStation]        = useState("");
  const [weather,        setWeather]        = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState(null);
  const [recent,         setRecent]         = useState(loadRecent);
  const [showTranslated, setShowTranslated] = useState(false);
  const [darkMode,       setDarkMode]       = useState(
    () => (localStorage.getItem(THEME_KEY) ?? "dark") === "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem(THEME_KEY, darkMode ? "dark" : "light");
  }, [darkMode]);

  function addToRecent(code) {
    const updated = [code, ...recent.filter((s) => s !== code)].slice(0, MAX_RECENT);
    setRecent(updated);
    saveRecent(updated);
  }

  async function fetchWeather(code = station) {
    if (!code) return;
    setLoading(true);
    setError(null);
    setWeather(null);
    try {
      const res  = await fetch(`${API_BASE}/api/weather?station=${code}`);
      const data = await res.json();
      if (!res.ok) setError(data.error || "Something went wrong.");
      else { setWeather(data); addToRecent(code); }
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && station && !loading) fetchWeather();
  }

  const { ceilingFt, visibilitySM, category } = weather ?? {};
  const badgeClass = CATEGORY_META[category]?.className ?? "";

  return (
    <div className="app">
      <header>
        <h1>✈ Aviation Weather</h1>
        <p className="subtitle">METAR &amp; TAF lookup by airport code</p>
        <ThemeToggle dark={darkMode} onToggle={() => setDarkMode((d) => !d)} />
      </header>

      <div className="search-row">
        <input
          type="text"
          placeholder="e.g. KORD"
          maxLength={4}
          value={station}
          onChange={(e) => setStation(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          className="station-input"
        />
        <button
          onClick={() => fetchWeather()}
          disabled={!station || loading}
          className="fetch-btn"
        >
          {loading ? "Fetching…" : "Fetch Weather"}
        </button>
      </div>

      {recent.length > 0 && (
        <div className="recent">
          <span className="recent-label">Recent:</span>
          {recent.map((code) => (
            <button
              key={code}
              className="recent-chip"
              onClick={() => { setStation(code); fetchWeather(code); }}
              disabled={loading}
            >
              {code}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="spinner-wrap">
          <div className="spinner" aria-label="Loading" />
          <span className="spinner-label">Fetching weather…</span>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      {weather && (
        <div className="results">

          {/* Centered category hero */}
          <div className="category-hero">
            <span className={`category-badge ${badgeClass}`}>{category}</span>
            <div className="category-meta">
              {visibilitySM !== null && visibilitySM !== undefined && (
                <span className="meta-pill">Vis: <strong>{visibilitySM} SM</strong></span>
              )}
              {ceilingFt !== null && ceilingFt !== undefined
                ? <span className="meta-pill">Ceiling: <strong>{ceilingFt.toLocaleString()} ft</strong></span>
                : <span className="meta-pill">Ceiling: <strong>None reported</strong></span>
              }
            </div>
          </div>

          {/* Toggle */}
          <div className="toggle-row">
            <Toggle checked={showTranslated} onChange={setShowTranslated} />
          </div>

          <WeatherCard
            title="METAR"
            raw={weather.metar}
            translated={weather.translatedMetar}
            showTranslated={showTranslated}
            category={category}
          />
          <WeatherCard
            title="TAF"
            raw={weather.taf}
            translated={weather.translatedTaf}
            showTranslated={showTranslated}
            category={category}
          />

          <p className="fetched-at">
            {weather.station} &middot; {formatFetchedAt(weather.fetchedAt)}
          </p>
        </div>
      )}
    </div>
  );
}
