"""
country_centroids.py

A static lookup table of approximate country centroid coordinates
(lat, lon), plus common name aliases. Used to place cohorts on the map
from a plain country name in the "Location" column -- no external
geocoding API call needed, which keeps the pipeline reliable (no network
dependency / rate limits inside GitHub Actions) and fast.

These are approximate geographic centroids (or, for a few irregularly
shaped countries, a representative interior point) -- good enough for a
summary world map where multiple cohorts per country get jittered apart
anyway. Not intended for precision GIS use.

If a country/location string isn't found here, `geocode_country()` returns
None and the caller should log it so it can be added.
"""

import re

# Canonical country name -> (latitude, longitude)
COUNTRY_CENTROIDS = {
    "afghanistan": (33.9, 67.7),
    "albania": (41.2, 20.2),
    "algeria": (28.0, 2.6),
    "argentina": (-35.4, -65.2),
    "armenia": (40.3, 45.0),
    "australia": (-25.3, 133.8),
    "austria": (47.6, 14.1),
    "azerbaijan": (40.4, 47.6),
    "bahrain": (26.0, 50.6),
    "bangladesh": (23.7, 90.4),
    "belarus": (53.7, 28.0),
    "belgium": (50.6, 4.6),
    "bolivia": (-16.7, -64.6),
    "bosnia and herzegovina": (43.9, 17.7),
    "brazil": (-10.3, -53.2),
    "brunei": (4.5, 114.7),
    "bulgaria": (42.7, 25.3),
    "cambodia": (12.6, 104.9),
    "cameroon": (5.7, 12.7),
    "canada": (56.1, -106.3),
    "chile": (-35.7, -71.5),
    "china": (35.9, 104.2),
    "colombia": (4.6, -74.3),
    "costa rica": (9.7, -83.8),
    "croatia": (45.1, 15.2),
    "cuba": (21.5, -79.5),
    "cyprus": (35.1, 33.4),
    "czech republic": (49.8, 15.5),
    "czechia": (49.8, 15.5),
    "denmark": (56.3, 9.5),
    "ecuador": (-1.8, -78.2),
    "egypt": (26.8, 30.8),
    "estonia": (58.6, 25.0),
    "ethiopia": (9.1, 40.5),
    "finland": (61.9, 25.7),
    "france": (46.6, 2.2),
    "georgia": (42.3, 43.4),
    "germany": (51.2, 10.4),
    "ghana": (7.9, -1.0),
    "greece": (39.1, 21.8),
    "guatemala": (15.8, -90.2),
    "honduras": (15.2, -86.2),
    "hong kong": (22.3, 114.2),
    "hungary": (47.2, 19.5),
    "iceland": (64.9, -19.0),
    "india": (22.4, 78.6),
    "indonesia": (-0.8, 113.9),
    "iran": (32.4, 53.7),
    "iraq": (33.2, 43.7),
    "ireland": (53.4, -8.2),
    "israel": (31.0, 34.9),
    "italy": (42.8, 12.8),
    "jamaica": (18.1, -77.3),
    "japan": (36.2, 138.3),
    "jordan": (31.2, 36.8),
    "kazakhstan": (48.0, 66.9),
    "kenya": (0.0, 37.9),
    "kuwait": (29.3, 47.5),
    "kyrgyzstan": (41.2, 74.8),
    "laos": (19.9, 102.5),
    "latvia": (56.9, 24.6),
    "lebanon": (33.9, 35.9),
    "libya": (26.3, 17.2),
    "lithuania": (55.2, 23.9),
    "luxembourg": (49.8, 6.1),
    "malaysia": (4.2, 101.9),
    "malta": (35.9, 14.4),
    "mexico": (23.6, -102.6),
    "moldova": (47.4, 28.4),
    "mongolia": (46.9, 103.8),
    "montenegro": (42.7, 19.4),
    "morocco": (31.8, -7.1),
    "myanmar": (21.9, 96.0),
    "nepal": (28.4, 84.1),
    "netherlands": (52.1, 5.3),
    "new zealand": (-41.0, 174.9),
    "nicaragua": (12.9, -85.2),
    "nigeria": (9.1, 8.7),
    "north macedonia": (41.6, 21.7),
    "norway": (60.5, 8.5),
    "oman": (21.5, 55.9),
    "pakistan": (30.4, 69.3),
    "panama": (8.5, -80.8),
    "paraguay": (-23.4, -58.4),
    "peru": (-9.2, -75.0),
    "philippines": (12.9, 121.8),
    "poland": (51.9, 19.1),
    "portugal": (39.4, -8.2),
    "puerto rico": (18.2, -66.6),
    "qatar": (25.4, 51.2),
    "romania": (45.9, 25.0),
    "russia": (61.5, 105.3),
    "rwanda": (-1.9, 30.0),
    "saudi arabia": (23.9, 45.1),
    "senegal": (14.5, -14.5),
    "serbia": (44.0, 21.0),
    "singapore": (1.35, 103.8),
    "slovakia": (48.7, 19.7),
    "slovenia": (46.1, 14.8),
    "south africa": (-30.6, 22.9),
    "south korea": (35.9, 127.8),
    "korea": (35.9, 127.8),
    "spain": (40.5, -3.7),
    "sri lanka": (7.9, 80.8),
    "sudan": (12.9, 30.2),
    "sweden": (60.1, 18.6),
    "switzerland": (46.8, 8.2),
    "syria": (34.8, 39.0),
    "taiwan": (23.7, 121.0),
    "tajikistan": (38.9, 71.3),
    "tanzania": (-6.4, 34.9),
    "thailand": (15.9, 100.9),
    "trinidad and tobago": (10.7, -61.2),
    "tunisia": (33.9, 9.5),
    "turkey": (38.9, 35.2),
    "turkiye": (38.9, 35.2),
    "uganda": (1.4, 32.3),
    "ukraine": (48.4, 31.2),
    "united arab emirates": (23.4, 53.8),
    "uae": (23.4, 53.8),
    "united kingdom": (54.0, -2.5),
    "uk": (54.0, -2.5),
    "england": (52.5, -1.5),
    "scotland": (56.5, -4.2),
    "wales": (52.3, -3.8),
    "northern ireland": (54.6, -6.7),
    "great britain": (54.0, -2.5),
    "britain": (54.0, -2.5),
    "united states": (39.8, -98.6),
    "united states of america": (39.8, -98.6),
    "usa": (39.8, -98.6),
    "us": (39.8, -98.6),
    "u.s.": (39.8, -98.6),
    "u.s.a.": (39.8, -98.6),
    "america": (39.8, -98.6),
    "uruguay": (-32.5, -55.8),
    "uzbekistan": (41.4, 64.6),
    "venezuela": (6.4, -66.6),
    "vietnam": (14.1, 108.3),
    "yemen": (15.6, 48.5),
    "zambia": (-13.1, 27.8),
    "zimbabwe": (-19.0, 29.2),
}

# Common variant spellings / punctuation -> canonical key above.
ALIASES = {
    "holland": "netherlands",
    "the netherlands": "netherlands",
    "republic of korea": "south korea",
    "south-korea": "south korea",
    "s. korea": "south korea",
    "russian federation": "russia",
    "peoples republic of china": "china",
    "people's republic of china": "china",
    "prc": "china",
    "cote d'ivoire": "ivory coast",
    "ivory coast": "ivory coast",
    "viet nam": "vietnam",
    "czechoslovakia": "czech republic",
}


def _normalize(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[.,]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name


def geocode_country(name: str):
    """
    Looks up an approximate (lat, lon) centroid for a country name string.
    Returns None if not found (caller should log/handle that case rather
    than silently dropping the cohort from the map).
    """
    if not name or not str(name).strip():
        return None

    key = _normalize(str(name))
    key = ALIASES.get(key, key)

    if key in COUNTRY_CENTROIDS:
        return COUNTRY_CENTROIDS[key]

    # Fall back to a loose "starts with" / "contains" match for strings
    # like "USA (multi-site)" or "Australia - Victoria".
    for candidate, coords in COUNTRY_CENTROIDS.items():
        if key.startswith(candidate) or candidate in key:
            return coords

    return None
