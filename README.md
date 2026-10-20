# PastWeather

Client-side web app: look up **archived NOAA MRMS radar** and **NOAA storm reports** for a place and time. Every data source is a US government source.

**Live:** https://standardweather.github.io/PastWeather/

## Features

- Place + UTC date/time → nearest MRMS radar frame + nearby SPC and NCEI Storm Events reports
- Radar archive starts **October 14, 2020** (start of NOAA's MRMS archive on AWS)
- Leaflet map (Esri basemap + MRMS decoded in the browser by `mrms.js`)
- Time step ±5 / 15 / 30 / 60 minutes
- Optional **through date** (up to 31 days): peak wind, station rain and MRMS radar-and-gauge rain totals over the period
- **History** (leave the date blank): every day since 1950 with hail ≥ 1", wind ≥ 58 mph or a tornado reported within 1–25 mi, with an optional check of MRMS estimated hail at the spot for days since October 2020
- **Print summary** (one page per event, with the map) and **CSV downloads** of reports, observations and history
- **Request a certified report** fills in the contact form on the home page with the event
- Soft handoff to [Standard Weather](https://standardweather.github.io/)

No backend, no API keys. NCEI Storm Events are pre-split into per-day files under `data/storm-events/` by `tools/storm_events.py`, and the History view's 1° tiles under `data/history/` are built by `tools/hail_history.py`. A weekly GitHub Actions job (`.github/workflows/storm-events.yml`) reruns both and commits.

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
| Rain | NOAA MRMS MultiSensor_QPE_24H_Pass2 (radar and gauges, 24-hour totals) |
| History | NCEI Storm Events 1950 onward (hail, thunderstorm wind, tornado) plus SPC preliminary reports since NCEI's last month |
| Storm reports (preliminary) | NOAA SPC filtered daily CSV |
| Storm reports (official) | NOAA NCEI Storm Events Database, published about 3–4 months after each month |

Times are **UTC**. Not a substitute for a certified weather analysis.
