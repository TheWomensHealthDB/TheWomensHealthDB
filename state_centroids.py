"""
state_centroids.py

A static lookup table of approximate U.S. state/territory centroid
coordinates (lat, lon), plus common name/abbreviation aliases and a
best-effort "major city -> state" table. Used to place cohorts on the map
from a resolved state/territory name (see participant_location.py) -- no
external geocoding API call needed, mirroring the approach in
country_centroids.py.

These are approximate geographic centroids -- good enough for a summary
world map where multiple cohorts per state get jittered apart anyway. Not
intended for precision GIS use.

If a state/territory string isn't found here, `geocode_state()` returns
None and the caller should log it so it can be added. Likewise, if a city
isn't in CITY_TO_STATE, `state_from_city()` returns None -- add more
entries there as real cohort data surfaces cities this table doesn't know
about yet.
"""

import re

# Canonical state/territory name (lowercase) -> (latitude, longitude)
STATE_CENTROIDS = {
    "alabama": (32.8, -86.8),
    "alaska": (64.2, -149.5),
    "arizona": (34.2, -111.9),
    "arkansas": (34.9, -92.4),
    "california": (37.2, -119.7),
    "colorado": (39.0, -105.5),
    "connecticut": (41.6, -72.7),
    "delaware": (39.0, -75.5),
    "district of columbia": (38.9, -77.0),
    "florida": (28.6, -82.4),
    "georgia": (32.6, -83.4),
    "hawaii": (20.3, -156.4),
    "idaho": (44.4, -114.6),
    "illinois": (40.0, -89.2),
    "indiana": (39.9, -86.3),
    "iowa": (42.0, -93.5),
    "kansas": (38.5, -98.4),
    "kentucky": (37.5, -85.3),
    "louisiana": (31.0, -92.0),
    "maine": (45.4, -69.2),
    "maryland": (39.0, -76.7),
    "massachusetts": (42.3, -71.8),
    "michigan": (44.3, -85.4),
    "minnesota": (46.3, -94.3),
    "mississippi": (32.7, -89.7),
    "missouri": (38.5, -92.5),
    "montana": (47.0, -109.6),
    "nebraska": (41.5, -99.8),
    "nevada": (39.3, -117.0),
    "new hampshire": (43.7, -71.6),
    "new jersey": (40.1, -74.7),
    "new mexico": (34.5, -106.1),
    "new york": (42.9, -75.5),
    "north carolina": (35.6, -79.4),
    "north dakota": (47.5, -100.5),
    "ohio": (40.4, -82.8),
    "oklahoma": (35.6, -97.5),
    "oregon": (44.0, -120.6),
    "pennsylvania": (40.9, -77.8),
    "rhode island": (41.7, -71.6),
    "south carolina": (33.9, -80.9),
    "south dakota": (44.4, -100.2),
    "tennessee": (35.9, -86.3),
    "texas": (31.5, -99.3),
    "utah": (39.3, -111.7),
    "vermont": (44.1, -72.7),
    "virginia": (37.5, -78.9),
    "washington": (47.4, -120.8),
    "west virginia": (38.6, -80.6),
    "wisconsin": (44.6, -89.9),
    "wyoming": (43.0, -107.5),
    # Territories / other jurisdictions with their own postal abbreviation.
    "puerto rico": (18.2, -66.6),
    "guam": (13.4, 144.8),
    "american samoa": (-14.3, -170.7),
    "u.s. virgin islands": (18.3, -64.9),
    "northern mariana islands": (15.1, 145.7),
}

# Common variant spellings / abbreviations -> canonical key above.
ALIASES = {
    "al": "alabama", "ala": "alabama",
    "ak": "alaska",
    "az": "arizona", "ariz": "arizona",
    "ar": "arkansas", "ark": "arkansas",
    "ca": "california", "calif": "california", "cal": "california",
    "co": "colorado", "colo": "colorado",
    "ct": "connecticut", "conn": "connecticut",
    "de": "delaware", "del": "delaware",
    "dc": "district of columbia", "d.c.": "district of columbia",
    "washington dc": "district of columbia", "washington d.c.": "district of columbia",
    "washington, dc": "district of columbia",
    "fl": "florida", "fla": "florida",
    "ga": "georgia",
    "hi": "hawaii",
    "id": "idaho",
    "il": "illinois", "ill": "illinois",
    "in": "indiana", "ind": "indiana",
    "ia": "iowa",
    "ks": "kansas", "kan": "kansas", "kans": "kansas",
    "ky": "kentucky",
    "la": "louisiana",
    "me": "maine",
    "md": "maryland",
    "ma": "massachusetts", "mass": "massachusetts",
    "mi": "michigan", "mich": "michigan",
    "mn": "minnesota", "minn": "minnesota",
    "ms": "mississippi", "miss": "mississippi",
    "mo": "missouri",
    "mt": "montana", "mont": "montana",
    "ne": "nebraska", "neb": "nebraska", "nebr": "nebraska",
    "nv": "nevada",
    "nh": "new hampshire",
    "nj": "new jersey",
    "nm": "new mexico", "n mex": "new mexico",
    "ny": "new york",
    "nc": "north carolina",
    "nd": "north dakota", "n dak": "north dakota",
    "oh": "ohio",
    "ok": "oklahoma", "okla": "oklahoma",
    "or": "oregon", "ore": "oregon", "oreg": "oregon",
    "pa": "pennsylvania", "penn": "pennsylvania", "penna": "pennsylvania",
    "ri": "rhode island",
    "sc": "south carolina",
    "sd": "south dakota", "s dak": "south dakota",
    "tn": "tennessee", "tenn": "tennessee",
    "tx": "texas", "tex": "texas",
    "ut": "utah",
    "vt": "vermont",
    "va": "virginia",
    "wa": "washington", "wash": "washington",
    "wv": "west virginia", "w va": "west virginia",
    "wi": "wisconsin", "wis": "wisconsin", "wisc": "wisconsin",
    "wy": "wyoming", "wyo": "wyoming",
    "pr": "puerto rico",
    "gu": "guam",
    "as": "american samoa",
    "vi": "u.s. virgin islands", "usvi": "u.s. virgin islands",
    "virgin islands": "u.s. virgin islands",
    "mp": "northern mariana islands",
}

# Best-effort "major city -> state" table for Subject population location
# entries that name only a city with no accompanying state (see
# participant_location.py). Not exhaustive -- if a real cohort's city isn't
# found here, add it (normalized, lowercase, no state/punctuation) mapped to
# the STATE_CENTROIDS key it belongs in.
CITY_TO_STATE = {
    "new york city": "new york", "new york": "new york", "nyc": "new york",
    "brooklyn": "new york", "buffalo": "new york", "rochester": "new york",
    "los angeles": "california", "san francisco": "california",
    "san diego": "california", "san jose": "california",
    "sacramento": "california", "oakland": "california",
    "long beach": "california", "fresno": "california",
    "chicago": "illinois",
    "houston": "texas", "dallas": "texas", "austin": "texas",
    "san antonio": "texas", "fort worth": "texas", "el paso": "texas",
    "phoenix": "arizona", "tucson": "arizona",
    "philadelphia": "pennsylvania", "pittsburgh": "pennsylvania",
    "boston": "massachusetts", "cambridge": "massachusetts",
    "worcester": "massachusetts",
    "seattle": "washington", "spokane": "washington", "tacoma": "washington",
    "denver": "colorado", "boulder": "colorado", "aurora": "colorado",
    "washington": "district of columbia",
    "nashville": "tennessee", "memphis": "tennessee", "knoxville": "tennessee",
    "portland": "oregon", "eugene": "oregon",
    "atlanta": "georgia", "augusta": "georgia", "savannah": "georgia",
    "miami": "florida", "orlando": "florida", "tampa": "florida",
    "jacksonville": "florida", "gainesville": "florida",
    "baltimore": "maryland", "bethesda": "maryland", "annapolis": "maryland",
    "detroit": "michigan", "ann arbor": "michigan", "grand rapids": "michigan",
    "minneapolis": "minnesota", "saint paul": "minnesota", "st paul": "minnesota",
    "rochester mn": "minnesota",
    "st louis": "missouri", "saint louis": "missouri", "kansas city": "missouri",
    "cleveland": "ohio", "columbus": "ohio", "cincinnati": "ohio",
    "toledo": "ohio", "dayton": "ohio",
    "las vegas": "nevada", "reno": "nevada",
    "new orleans": "louisiana", "baton rouge": "louisiana",
    "charlotte": "north carolina", "raleigh": "north carolina",
    "durham": "north carolina", "chapel hill": "north carolina",
    "indianapolis": "indiana",
    "milwaukee": "wisconsin", "madison": "wisconsin",
    "salt lake city": "utah", "provo": "utah",
    "albuquerque": "new mexico",
    "honolulu": "hawaii",
    "anchorage": "alaska",
    "richmond": "virginia", "norfolk": "virginia", "charlottesville": "virginia",
    "arlington": "virginia",
    "birmingham": "alabama", "montgomery": "alabama", "mobile": "alabama",
    "little rock": "arkansas",
    "oklahoma city": "oklahoma", "tulsa": "oklahoma",
    "wichita": "kansas",
    "omaha": "nebraska", "lincoln": "nebraska",
    "des moines": "iowa", "iowa city": "iowa",
    "louisville": "kentucky", "lexington": "kentucky",
    "jackson": "mississippi",
    "columbia": "south carolina", "charleston": "south carolina",
    "providence": "rhode island",
    "hartford": "connecticut", "new haven": "connecticut",
    "burlington": "vermont",
    "manchester": "new hampshire",
    "wilmington": "delaware",
    "newark": "new jersey", "princeton": "new jersey", "trenton": "new jersey",
    "boise": "idaho",
    "billings": "montana", "bozeman": "montana",
    "fargo": "north dakota",
    "sioux falls": "south dakota",
    "cheyenne": "wyoming",
    "san juan": "puerto rico",
}


def _normalize(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[.,]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name


def _lookup_key(name: str):
    """Returns the canonical STATE_CENTROIDS key for a name, or None."""
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    key = ALIASES.get(key, key)
    if key in STATE_CENTROIDS:
        return key

    # Fall back to a loose whole-word match for strings like "Subset of
    # women drawn from TREMIN originally in Minnesota", where the state
    # name is only part of a longer free-text sentence. Deliberately only
    # checks the full canonical names in STATE_CENTROIDS here (never the
    # short postal-code/abbreviation entries in ALIASES, like "in", "or",
    # "me", "hi", "la", "ok", "pa", "de", "va", "ma", "co", "id") -- those
    # are far too likely to appear as ordinary English words inside a
    # longer sentence and would falsely match (e.g. the word "in" in
    # "...originally in Minnesota" would otherwise match Indiana).
    for candidate in STATE_CENTROIDS:
        if re.search(rf"\b{re.escape(candidate)}\b", key):
            return candidate

    return None


def geocode_state(name: str):
    """Looks up an approximate (lat, lon) centroid for a state/territory name."""
    key = _lookup_key(name)
    return STATE_CENTROIDS[key] if key else None


def state_display_name(name: str):
    """Returns a nicely-cased canonical state/territory name, or None."""
    key = _lookup_key(name)
    if not key:
        return None
    overrides = {"district of columbia": "District of Columbia", "u.s. virgin islands": "U.S. Virgin Islands"}
    return overrides.get(key, key.title())


def state_from_city(name: str):
    """
    Best-effort city -> canonical state name lookup for Subject population
    location entries that name only a city. Returns None if the city isn't
    in CITY_TO_STATE.
    """
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    state_key = CITY_TO_STATE.get(key)
    return state_display_name(state_key) if state_key else None
