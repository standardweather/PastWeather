# PastWeather

Client-side web app: look up **archived radar** (IEM USCOMP) and **SPC storm reports** for a place and time.

**Live:** https://standardweather.github.io/PastWeather/

## Features

- Place + UTC date/time → nearest USCOMP radar + nearby SPC reports
- Leaflet map (Esri basemap + IEM ridge tiles)
- Time step ±5 / 15 / 30 / 60 minutes
- Soft handoff to [Standard Weather](https://standardweather.github.io/)

No backend, no API keys. Data from IEM, SPC, and Nominatim (CORS-friendly).

## Local preview

```bash
# any static server from this folder
npx --yes serve .
# or: python3 -m http.server 8080
```

Open the printed URL. Relative asset paths work on GitHub Pages project site (`/PastWeather/`).

## GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.

## Data sources

| Data | Source |
|------|--------|
| Geocode | OpenStreetMap Nominatim |
| Radar scans | IEM `json/radar.py` (USCOMP N0Q, fallback N0B) |
| Radar tiles | IEM ridge TMS |
| Storm reports | SPC filtered daily CSV |

Times are **UTC**. Not a substitute for a certified weather analysis.
