# PastWeather

Client-side web app: look up **archived NOAA MRMS radar** and **NOAA storm reports** for a place and time. Every data source is a US government source.

**Live:** https://standardweather.github.io/PastWeather/

## Features

- Place + UTC date/time → nearest MRMS radar frame + nearby SPC and NCEI Storm Events reports
- Radar archive starts **October 14, 2020** (start of NOAA's MRMS archive on AWS)
- Leaflet map (Esri basemap + MRMS decoded in the browser by `mrms.js`)
- Time step ±5 / 15 / 30 / 60 minutes
- Soft handoff to [Standard Weather](https://standardweather.github.io/)

No backend, no API keys. NCEI Storm Events are pre-split into per-day files under `data/storm-events/` by `tools/storm_events.py`, which a weekly GitHub Actions job (`.github/workflows/storm-events.yml`) reruns and commits.

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
| Place search | US Census TIGERweb places, USGS GNIS populated places, Census Geocoder (street addresses, via JSONP) |
| Radar | NOAA MRMS SeamlessHSR GRIB2 from `noaa-mrms-pds` on AWS (2-minute cadence, 2020-10-14 onward) |
| Storm reports (preliminary) | NOAA SPC filtered daily CSV |
| Storm reports (official) | NOAA NCEI Storm Events Database, published about 3–4 months after each month |

Times are **UTC**. Not a substitute for a certified weather analysis.
