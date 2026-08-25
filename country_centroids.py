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
    # Constituent countries of the UK -- treated as the same map pin as
    # "United Kingdom" rather than their own distinct centroid, so a value
    # like "England, Scotland, and Wales" resolves to one location
    # ("United Kingdom") instead of being mistaken for 3 different places
    # and triggering the PI/study-location fallback.
    "england": "united kingdom",
    "scotland": "united kingdom",
    "wales": "united kingdom",
    "northern ireland": "united kingdom",
    "great britain": "united kingdom",
    "britain": "united kingdom",
    # ISO 3166-1 alpha-3 codes, as seen in values like "Nationwide (CAN)" or
    # "Nationwide (AUS)" -- see the _NATIONWIDE_HINT_RE handling in
    # participant_location.py.
    "can": "canada",
    "aus": "australia",
    "gbr": "united kingdom",
    "nzl": "new zealand",
    "chn": "china",
    "jpn": "japan",
    "deu": "germany",
    "fra": "france",
    "mex": "mexico",
    "bra": "brazil",
    "ind": "india",
    "kor": "south korea",
}


def _normalize(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[.,]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name


def _lookup_key(name: str):
    """Returns the canonical COUNTRY_CENTROIDS key for a name, or None."""
    if not name or not str(name).strip():
        return None

    key = _normalize(str(name))
    key = ALIASES.get(key, key)

    if key in COUNTRY_CENTROIDS:
        return key

    # Fall back to a loose whole-word match for strings like
    # "USA (multi-site)" or "Australia - Victoria", where the country name
    # is only part of a longer string. This is intentionally anchored to
    # word boundaries (\b) rather than a bare substring/startswith check --
    # a bare substring check would let short candidates like "uk"/"us"
    # falsely match *inside* unrelated words (e.g. "uk" inside "Timbuktu").
    for candidate in COUNTRY_CENTROIDS:
        if re.search(rf"\b{re.escape(candidate)}\b", key):
            return candidate

    return None


def geocode_country(name: str):
    """
    Looks up an approximate (lat, lon) centroid for a country name string.
    Returns None if not found (caller should log/handle that case rather
    than silently dropping the cohort from the map).
    """
    key = _lookup_key(name)
    return COUNTRY_CENTROIDS[key] if key else None


_DISPLAY_OVERRIDES = {
    "usa": "USA", "us": "US", "u.s.": "U.S.", "u.s.a.": "U.S.A.",
    "uk": "UK", "uae": "UAE",
}


def country_display_name(name: str):
    """Returns a nicely-cased canonical country name, or None if not found."""
    key = _lookup_key(name)
    if not key:
        return None
    return _DISPLAY_OVERRIDES.get(key, key.title())


# Best-effort "major international city -> country" table, mirroring
# state_centroids.CITY_TO_STATE, for Subject population location entries
# that name only a non-U.S. city with no accompanying country (e.g.
# "Shanghai", "Melbourne"). Not exhaustive -- if a real cohort's city isn't
# found here, add it (normalized, lowercase, no country/punctuation) mapped
# to the COUNTRY_CENTROIDS key it belongs in. Deliberately excludes any city
# that's ambiguous with a same-named U.S. city already in
# state_centroids.CITY_TO_STATE (e.g. "London, Ontario" vs. London, UK) --
# participant_location.py only consults this as a last-resort fallback after
# the U.S. city table comes up empty, so an unambiguous non-U.S. city here is
# safe.
CITY_TO_COUNTRY = {
    "shanghai": "china", "beijing": "china", "guangzhou": "china",
    "shenzhen": "china", "wuhan": "china", "hong kong": "hong kong",
    "melbourne": "australia", "sydney": "australia", "brisbane": "australia",
    "perth": "australia", "adelaide": "australia", "canberra": "australia",
    "toronto": "canada", "vancouver": "canada", "montreal": "canada",
    "ottawa": "canada", "calgary": "canada", "edmonton": "canada",
    "winnipeg": "canada", "quebec city": "canada", "halifax": "canada",
    "tokyo": "japan", "osaka": "japan", "kyoto": "japan", "yokohama": "japan",
    "auckland": "new zealand", "wellington": "new zealand",
    "christchurch": "new zealand",
    "dublin": "ireland",
    "berlin": "germany", "munich": "germany", "hamburg": "germany",
    "paris": "france", "marseille": "france", "lyon": "france",
    "madrid": "spain", "barcelona": "spain",
    "rome": "italy", "milan": "italy",
    "amsterdam": "netherlands", "rotterdam": "netherlands",
    "stockholm": "sweden", "oslo": "norway", "copenhagen": "denmark",
    "helsinki": "finland",
    "seoul": "south korea", "busan": "south korea",
    "singapore": "singapore",
    "mumbai": "india", "delhi": "india", "new delhi": "india",
    "bangalore": "india", "chennai": "india", "kolkata": "india",
    "mexico city": "mexico",
    "sao paulo": "brazil", "rio de janeiro": "brazil",
}


def country_from_city(name: str):
    """
    Best-effort city -> canonical country name lookup for Subject
    population location entries that name only a (non-U.S.) city. Returns
    None if the city isn't in CITY_TO_COUNTRY.
    """
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    country_key = CITY_TO_COUNTRY.get(key)
    return country_display_name(country_key) if country_key else None


# Approximate (lat, lon) centroid for each city in CITY_TO_COUNTRY above,
# keyed identically (normalized, lowercase, no punctuation). Lets a cohort
# whose Subject population location names one of these cities (alone, or
# alongside its country, e.g. "Melbourne, Australia") be placed on the map
# at that city's own location instead of snapping all the way out to its
# country's much coarser centroid -- see geocode_city()/city_display_name()
# and their use in participant_location.py. Not exhaustive -- if a real
# cohort's city isn't found here (or in CITY_TO_COUNTRY), it falls back to
# country-level geocoding exactly as before.
CITY_CENTROIDS = {
    "shanghai": (31.2304, 121.4737), "beijing": (39.9042, 116.4074),
    "guangzhou": (23.1291, 113.2644), "shenzhen": (22.5431, 114.0579),
    "wuhan": (30.5928, 114.3055), "hong kong": (22.3193, 114.1694),
    "melbourne": (-37.8136, 144.9631), "sydney": (-33.8688, 151.2093),
    "brisbane": (-27.4698, 153.0251), "perth": (-31.9505, 115.8605),
    "adelaide": (-34.9285, 138.6007), "canberra": (-35.2809, 149.1300),
    "toronto": (43.6532, -79.3832), "vancouver": (49.2827, -123.1207),
    "montreal": (45.5019, -73.5674), "ottawa": (45.4215, -75.6972),
    "calgary": (51.0447, -114.0719), "edmonton": (53.5461, -113.4938),
    "winnipeg": (49.8951, -97.1384), "quebec city": (46.8139, -71.2080),
    "halifax": (44.6488, -63.5752),
    "tokyo": (35.6762, 139.6503), "osaka": (34.6937, 135.5023),
    "kyoto": (35.0116, 135.7681), "yokohama": (35.4437, 139.6380),
    "auckland": (-36.8485, 174.7633), "wellington": (-41.2865, 174.7762),
    "christchurch": (-43.5321, 172.6362),
    "dublin": (53.3498, -6.2603),
    "berlin": (52.5200, 13.4050), "munich": (48.1351, 11.5820),
    "hamburg": (53.5511, 9.9937),
    "paris": (48.8566, 2.3522), "marseille": (43.2965, 5.3698),
    "lyon": (45.7640, 4.8357),
    "madrid": (40.4168, -3.7038), "barcelona": (41.3874, 2.1686),
    "rome": (41.9028, 12.4964), "milan": (45.4642, 9.1900),
    "amsterdam": (52.3676, 4.9041), "rotterdam": (51.9244, 4.4777),
    "stockholm": (59.3293, 18.0686), "oslo": (59.9139, 10.7522),
    "copenhagen": (55.6761, 12.5683), "helsinki": (60.1699, 24.9384),
    "seoul": (37.5665, 126.9780), "busan": (35.1796, 129.0756),
    "singapore": (1.3521, 103.8198),
    "mumbai": (19.0760, 72.8777), "delhi": (28.7041, 77.1025),
    "new delhi": (28.6139, 77.2090), "bangalore": (12.9716, 77.5946),
    "chennai": (13.0827, 80.2707), "kolkata": (22.5726, 88.3639),
    "mexico city": (19.4326, -99.1332),
    "sao paulo": (-23.5505, -46.6333), "rio de janeiro": (-22.9068, -43.1729),
}

# A handful of cities need a display spelling title() can't produce
# correctly on its own (title() would give "Rio De Janeiro"/"Sao Paulo").
_CITY_DISPLAY_OVERRIDES = {
    "sao paulo": "S\u00e3o Paulo",
    "rio de janeiro": "Rio de Janeiro",
}


def geocode_city(name: str):
    """
    Looks up a precise (lat, lon) centroid for a known non-U.S. city (see
    CITY_CENTROIDS). Returns None if the city isn't found there.
    """
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    return CITY_CENTROIDS.get(key)


def city_display_name(name: str):
    """
    Returns a nicely-cased display name for a known non-U.S. city (see
    CITY_TO_COUNTRY), or None if `name` isn't recognized as one.
    """
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    if key not in CITY_TO_COUNTRY:
        return None
    return _CITY_DISPLAY_OVERRIDES.get(key, key.title())
