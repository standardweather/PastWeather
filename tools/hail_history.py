#!/usr/bin/env python3
"""Build the severe weather history index for PastWeather's History view.

Answers "how often has damaging hail, wind or a tornado hit near this address?" without the browser reading
75 years of NCEI files. Every hail (1 inch or larger), thunderstorm wind (58 mph or stronger) and tornado report
with a point location is written into 1-degree tiles:

    data/history/index.json           NCEI files used, the last day NCEI covers, the SPC days added after it
    data/history/N35W098.json          {"rows": [[time, type, magnitude, lat, lon, source], ...]}

    time       "YYYYMMDDHHMM" UTC
    type       "H" hail (inches), "W" thunderstorm wind (mph), "T" tornado (EF/F rating, or "" if unrated)
    source     "N" NCEI Storm Events (official), "S" SPC preliminary report

A tile is named for its south-west corner, so a report at 35.4, -97.6 lands in N35W098. NCEI publishes about
3-4 months behind, so the days after its last day come from SPC's preliminary daily reports and are replaced
on every run. Only NCEI years whose file changed are re-read. Standard library only.

    python3 tools/hail_history.py                  # update data/history
    python3 tools/hail_history.py --years 2024     # re-read only these NCEI years
"""

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import math
import sys
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from storm_events import BASE, detail_files, fetch, num, utc  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "data" / "history"
SPC = "https://www.spc.noaa.gov/climo/reports"
HAIL_MIN_IN = 1.0
WIND_MIN_MPH = 58
KT_TO_MPH = 1.15078
# Before 2006 CZ_TIMEZONE is a bare abbreviation ("CST") rather than "CST-6".
ZONES = {"AST": -4, "ADT": -3, "EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6,
         "PST": -8, "PDT": -7, "AKST": -9, "AKDT": -8, "HST": -10, "SST": -11, "GST": 10, "CHST": 10}

csv.field_size_limit(sys.maxsize)


def get(url, tries=4):
    """fetch() with a few retries; NCEI and SPC sometimes drop connections mid-download."""
    for i in range(tries):
        try:
            return fetch(url)
        except urllib.error.HTTPError:
            raise
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))


def tile_name(lat, lon):
    la, lo = math.floor(lat), math.floor(lon)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def row_for(kind, when, mag, lat, lon, source):
    return [when.strftime("%Y%m%d%H%M"), kind, mag, round(lat, 3), round(lon, 3), source]


def ncei_rows(name):
    """Qualifying rows from one NCEI yearly details file."""
    text = io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(get(BASE + name))), "utf-8", "replace")
    rows, last_month = [], ""
    for r in csv.DictReader(text):
        last_month = max(last_month, r["BEGIN_YEARMONTH"])
        t = r["EVENT_TYPE"]
        lat, lon = num(r["BEGIN_LAT"]), num(r["BEGIN_LON"])
        if lat is None or lon is None or (lat == 0 and lon == 0):
            continue
        zone = r["CZ_TIMEZONE"].strip().upper()
        if zone in ZONES:
            zone = f"{zone}{ZONES[zone]}"
        when = utc(r["BEGIN_YEARMONTH"], r["BEGIN_DAY"], r["BEGIN_TIME"], zone)
        if when is None:
            continue
        mag = num(r["MAGNITUDE"])
        if t == "Hail" and mag is not None and mag >= HAIL_MIN_IN:
            rows.append(row_for("H", when, mag, lat, lon, "N"))
        elif t == "Thunderstorm Wind" and mag is not None and mag * KT_TO_MPH >= WIND_MIN_MPH:
            rows.append(row_for("W", when, round(mag * KT_TO_MPH), lat, lon, "N"))
        elif t == "Tornado":
            scale = r["TOR_F_SCALE"] if r["TOR_F_SCALE"] not in ("EFU", "") else ""
            rows.append(row_for("T", when, scale, lat, lon, "N"))
    return rows, last_month


def spc_rows(day):
    """Qualifying rows from one SPC convective day (12 UTC on `day` to 12 UTC the next)."""
    try:
        text = get(f"{SPC}/{day:%y%m%d}_rpts_filtered.csv").decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    rows, section = [], None
    for cols in csv.reader(io.StringIO(text)):
        if not cols:
            continue
        if cols[0].upper() == "TIME":
            head = ",".join(cols).upper()
            section = "T" if "F_SCALE" in head else "H" if "SIZE" in head else "W" if "SPEED" in head else None
            continue
        if not section or len(cols) < 7 or not cols[0].isdigit():
            continue
        lat, lon = num(cols[5]), num(cols[6])
        if lat is None or lon is None:
            continue
        hhmm = int(cols[0])
        when = dt.datetime(day.year, day.month, day.day, hhmm // 100, hhmm % 100)
        if hhmm < 1200:
            when += dt.timedelta(days=1)
        mag = num(cols[1])
        if section == "H" and mag is not None and mag / 100 >= HAIL_MIN_IN:
            rows.append(row_for("H", when, mag / 100, lat, lon, "S"))
        elif section == "W" and mag is not None and mag >= WIND_MIN_MPH:
            rows.append(row_for("W", when, round(mag), lat, lon, "S"))
        elif section == "T":
            rows.append(row_for("T", when, f"EF{cols[1]}" if cols[1].isdigit() else "", lat, lon, "S"))
    return rows


def load_tiles():
    tiles = {}
    for p in OUT.glob("[NS]*.json"):
        tiles[p.stem] = json.loads(p.read_text())["rows"]
    return tiles


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=int, nargs="*", help="only re-read these NCEI years (default: every year with changes)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"files": {}, "lastMonth": {}}
    available = detail_files()
    years = args.years or [y for y, n in sorted(available.items()) if index["files"].get(str(y)) != n]

    tiles = load_tiles()
    # SPC rows are always rebuilt, and changed NCEI years are replaced whole.
    for k in tiles:
        tiles[k] = [r for r in tiles[k] if r[5] != "S" and int(r[0][:4]) not in years]
    for year in years:
        rows, last_month = ncei_rows(available[year])
        for r in rows:
            tiles.setdefault(tile_name(r[3], r[4]), []).append(r)
        index["files"][str(year)] = available[year]
        if last_month:
            index["lastMonth"][str(year)] = last_month
        print(f"{year}: {len(rows)} reports", flush=True)

    last = max(index["lastMonth"].values(), default="")
    month = dt.date(int(last[:4]), int(last[4:]), 1)
    last_day = (month.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    day, spc_days, spc_count = last_day + dt.timedelta(days=1), 0, 0
    yesterday = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    while day <= yesterday:
        for r in spc_rows(day):
            tiles.setdefault(tile_name(r[3], r[4]), []).append(r)
            spc_count += 1
        spc_days += 1
        day += dt.timedelta(days=1)
    print(f"SPC preliminary: {spc_count} reports on {spc_days} days after {last_day}", flush=True)

    for old in OUT.glob("[NS]*.json"):
        if not tiles.get(old.stem):
            old.unlink()
    for k, rows in tiles.items():
        if rows:
            rows.sort(key=lambda r: (r[0], r[1], r[3], r[4]))
            (OUT / f"{k}.json").write_text(json.dumps({"rows": rows}, separators=(",", ":")))
    index.update({
        "source": "NOAA NCEI Storm Events Database and SPC preliminary storm reports",
        "thresholds": {"hailInches": HAIL_MIN_IN, "windMph": WIND_MIN_MPH},
        "firstYear": min(int(y) for y in index["files"]),
        "lastDay": last_day.isoformat(),
        "spcThrough": yesterday.isoformat(),
        "files": dict(sorted(index["files"].items())),
        "lastMonth": dict(sorted(index["lastMonth"].items())),
    })
    index_path.write_text(json.dumps(index, indent=2) + "\n")
    print(f"wrote {sum(1 for r in tiles.values() if r)} tiles, {sum(len(r) for r in tiles.values())} reports")


if __name__ == "__main__":
    main()
