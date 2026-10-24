# PastWeather data

PastWeather is now part of **[ForensicWeather](https://standardweather.github.io/ForensicWeather/)**, whose page and code (`ForensicWeather/index.html`, `app.js`, `glm.js`) live in the `standardweather/standardweather.github.io` repo.

This repo still does two jobs:

- **Data.** It builds and serves the files ForensicWeather and the property weather profile read from `/PastWeather/data/`: NCEI Storm Events split into per-day files under `data/storm-events/` (`tools/storm_events.py`), and the History view's 1° tiles of hail, wind and tornado reports since 1950 under `data/history/` (`tools/hail_history.py`). A weekly GitHub Actions job (`.github/workflows/storm-events.yml`) reruns both and commits. Keep the `data/` paths stable.
- **Redirect.** `index.html` sends `/PastWeather/` to `/ForensicWeather/`, keeping the query string and hash, so shared links like `/PastWeather/?loc=Moore, OK&date=2024-05-01&time=2215` still open the same view.

## Local preview

```bash
# any static server from this folder
npx --yes serve .
# or: python3 -m http.server 8080
```

The data files are served at `/PastWeather/data/…` on GitHub Pages.

## GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.

## Data sources (ForensicWeather's lookup)

| Data | Source |
|------|--------|
| Place search | US Census TIGERweb places, USGS GNIS populated places, Census Geocoder (street addresses, via JSONP) |
| Radar | NOAA MRMS SeamlessHSR GRIB2 from `noaa-mrms-pds` on AWS (2-minute cadence, 2020-10-14 onward) |
| Rain | NOAA MRMS MultiSensor_QPE_24H_Pass2 (radar and gauges, 24-hour totals) |
| History | NCEI Storm Events 1950 onward (hail, thunderstorm wind, tornado) plus SPC preliminary reports since NCEI's last month |
| Storm reports (preliminary) | NOAA SPC filtered daily CSV |
| Storm reports (official) | NOAA NCEI Storm Events Database, published about 3–4 months after each month |
| Warnings | NWS VTEC products, from the Iowa Environmental Mesonet archive (`vtec_events_bypoint`, `sbw_by_point`, `sbw.geojson`) |
| Lightning | NOAA GOES-16/17/18/19 Geostationary Lightning Mapper (GLM-L2-LCFA) on AWS, 2018 onward |
| Time zone | NWS API points service (for local times in the written account) |
| Climate | NOAA Regional Climate Centers' ACIS (`StnMeta`, `StnData`): daily records and 1991–2020 normals |

Times are **UTC**. Not a substitute for a certified weather analysis.
