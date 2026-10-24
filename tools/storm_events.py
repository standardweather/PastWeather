#!/usr/bin/env python3
"""Split NOAA NCEI Storm Events yearly CSVs into small per-day JSON files for ForensicWeather (formerly PastWeather).

NCEI publishes one gzipped CSV per year (10+ MB), which is too large for a browser or phone to fetch for a single
lookup. This script downloads the yearly "details" files, keeps events that have a point location, converts their
times to UTC, and writes one file per UTC day of the event's start:

    data/storm-events/index.json            source files used and the last day covered
    data/storm-events/YYYY/YYYYMMDD.json     {"events": [...], "episodes": {id: narrative}}

Only years whose NCEI file has changed since the last run are rewritten. Standard library only.

    python3 tools/storm_events.py            # update data/storm-events
    python3 tools/storm_events.py --years 2024
"""

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

BASE = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/"
FIRST_DAY = dt.date(2020, 10, 14)  # start of NOAA's MRMS radar archive on AWS; nothing earlier is shown
OUT = Path(__file__).resolve().parent.parent / "data" / "storm-events"
UA = {"User-Agent": "StandardWeather PastWeather storm-events builder"}

csv.field_size_limit(sys.maxsize)

# Storm Events gives state names in full; reports elsewhere in the app use postal codes.
STATES = dict(zip(
    "ALABAMA ALASKA ARIZONA ARKANSAS CALIFORNIA COLORADO CONNECTICUT DELAWARE FLORIDA GEORGIA HAWAII IDAHO ILLINOIS "
    "INDIANA IOWA KANSAS KENTUCKY LOUISIANA MAINE MARYLAND MASSACHUSETTS MICHIGAN MINNESOTA MISSISSIPPI MISSOURI "
    "MONTANA NEBRASKA NEVADA NEW_HAMPSHIRE NEW_JERSEY NEW_MEXICO NEW_YORK NORTH_CAROLINA NORTH_DAKOTA OHIO OKLAHOMA "
    "OREGON PENNSYLVANIA RHODE_ISLAND SOUTH_CAROLINA SOUTH_DAKOTA TENNESSEE TEXAS UTAH VERMONT VIRGINIA WASHINGTON "
    "WEST_VIRGINIA WISCONSIN WYOMING DISTRICT_OF_COLUMBIA PUERTO_RICO VIRGIN_ISLANDS GUAM AMERICAN_SAMOA".split(),
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA "
    "RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS".split(),
))


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def detail_files():
    """Map year -> current NCEI details filename (the c-date in the name changes when NCEI revises a year)."""
    html = fetch(BASE).decode("utf-8", "replace")
    names = set(re.findall(r"StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz", html))
    latest = {}
    for year, cdate in names:
        if year not in latest or cdate > latest[year][0]:
            latest[year] = (cdate, f"StormEvents_details-ftp_v1.0_d{year}_c{cdate}.csv.gz")
    return {int(y): name for y, (_, name) in latest.items()}


def utc(yearmonth, day, hhmm, zone):
    """Storm Events times are local standard time; CZ_TIMEZONE looks like 'CST-6' or 'AKST-9'."""
    m = re.search(r"(-?\d+)$", zone or "")
    if not (yearmonth and day and m):
        return None
    t = int(hhmm or 0)
    local = dt.datetime(int(yearmonth[:4]), int(yearmonth[4:]), int(day), t // 100, t % 100)
    return local - dt.timedelta(hours=int(m.group(1)))


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def coord(s):
    v = num(s)
    return round(v, 4) if v is not None else None


def place(rng, azimuth, location):
    if not location:
        return ""
    r = num(rng)
    if r and azimuth:
        return f"{r:g} {azimuth} {location.title()}"
    return location.title()


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%MZ")


def events_for_year(name):
    rows = csv.DictReader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(fetch(BASE + name))), "utf-8", "replace"))
    days, last_month = {}, ""
    for r in rows:
        lat, lon = coord(r["BEGIN_LAT"]), coord(r["BEGIN_LON"])
        if lat is None or lon is None:
            continue  # zone- or county-wide events have no point to map
        begin = utc(r["BEGIN_YEARMONTH"], r["BEGIN_DAY"], r["BEGIN_TIME"], r["CZ_TIMEZONE"])
        end = utc(r["END_YEARMONTH"], r["END_DAY"], r["END_TIME"], r["CZ_TIMEZONE"])
        if begin is None or begin.date() < FIRST_DAY:
            continue
        e = {
            "id": int(r["EVENT_ID"]),
            "episode": int(r["EPISODE_ID"]) if r["EPISODE_ID"] else None,
            "type": r["EVENT_TYPE"],
            "begin": iso(begin),
            "end": iso(end) if end else None,
            "lat": lat,
            "lon": lon,
            "endLat": coord(r["END_LAT"]),
            "endLon": coord(r["END_LON"]),
            "magnitude": num(r["MAGNITUDE"]),
            "magnitudeType": r["MAGNITUDE_TYPE"],
            "torScale": r["TOR_F_SCALE"],
            "torLengthMi": num(r["TOR_LENGTH"]),
            "torWidthYd": num(r["TOR_WIDTH"]),
            "damageProperty": r["DAMAGE_PROPERTY"],
            "damageCrops": r["DAMAGE_CROPS"],
            "injuries": int(num(r["INJURIES_DIRECT"]) or 0) + int(num(r["INJURIES_INDIRECT"]) or 0),
            "deaths": int(num(r["DEATHS_DIRECT"]) or 0) + int(num(r["DEATHS_INDIRECT"]) or 0),
            "source": r["SOURCE"],
            "wfo": r["WFO"],
            "state": STATES.get(r["STATE"].replace(" ", "_"), r["STATE"].title()),
            "county": r["CZ_NAME"].title(),
            "location": place(r["BEGIN_RANGE"], r["BEGIN_AZIMUTH"], r["BEGIN_LOCATION"]),
            "narrative": r["EVENT_NARRATIVE"].strip(),
        }
        last_month = max(last_month, r["BEGIN_YEARMONTH"])
        day = days.setdefault(begin.date(), {"events": [], "episodes": {}})
        day["events"].append({k: v for k, v in e.items() if v not in (None, "")})
        if e["episode"] and r["EPISODE_NARRATIVE"].strip():
            day["episodes"][str(e["episode"])] = r["EPISODE_NARRATIVE"].strip()
    return days, last_month


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=int, nargs="*", help="only these years (default: every year with changes)")
    args = ap.parse_args()

    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"files": {}}
    available = {y: n for y, n in detail_files().items() if y >= FIRST_DAY.year}
    years = args.years or [y for y, n in sorted(available.items()) if index["files"].get(str(y)) != n]

    for year in years:
        name = available[year]
        print(f"{year}: {name}", flush=True)
        days, last_month = events_for_year(name)
        year_dir = OUT / str(year)
        year_dir.mkdir(parents=True, exist_ok=True)
        for old in year_dir.glob("*.json"):
            old.unlink()
        for day, data in days.items():
            data["events"].sort(key=lambda e: (e["begin"], e["id"]))
            path = year_dir / f"{day:%Y%m%d}.json"
            path.write_text(json.dumps(data, separators=(",", ":"), sort_keys=True))
        index["files"][str(year)] = name
        index.setdefault("lastMonth", {})[str(year)] = last_month
        print(f"  {sum(len(d['events']) for d in days.values())} events on {len(days)} days", flush=True)

    # NCEI publishes whole months (in local time), so coverage runs to the end of the latest month with events.
    last = max(index.get("lastMonth", {}).values(), default="")
    if last:
        month = dt.date(int(last[:4]), int(last[4:]), 1)
        last_day = (month.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    index.update({
        "source": "NOAA NCEI Storm Events Database, " + BASE,
        "firstDay": FIRST_DAY.isoformat(),
        "lastDay": last_day.isoformat() if last else None,
        "files": dict(sorted(index["files"].items())),
        "lastMonth": dict(sorted(index.get("lastMonth", {}).items())),
    })
    index_path.write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
