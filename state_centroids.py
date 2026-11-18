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


# Approximate (lat, lon) for every city in CITY_TO_STATE, so a cohort whose
# location names a specific U.S. city gets its own map pin instead of its
# state's centroid (see participant_location.py). Keys match CITY_TO_STATE
# exactly; a check at the bottom of this module enforces that, so adding a
# city to CITY_TO_STATE without a centroid fails loudly.
US_CITY_CENTROIDS = {
    "new york city": (40.7128, -74.0060), "new york": (40.7128, -74.0060),
    "nyc": (40.7128, -74.0060), "brooklyn": (40.6782, -73.9442),
    "buffalo": (42.8864, -78.8784), "rochester": (43.1566, -77.6088),
    "los angeles": (34.0522, -118.2437), "san francisco": (37.7749, -122.4194),
    "san diego": (32.7157, -117.1611), "san jose": (37.3382, -121.8863),
    "sacramento": (38.5816, -121.4944), "oakland": (37.8044, -122.2712),
    "long beach": (33.7701, -118.1937), "fresno": (36.7378, -119.7871),
    "chicago": (41.8781, -87.6298),
    "houston": (29.7604, -95.3698), "dallas": (32.7767, -96.7970),
    "austin": (30.2672, -97.7431), "san antonio": (29.4241, -98.4936),
    "fort worth": (32.7555, -97.3308), "el paso": (31.7619, -106.4850),
    "phoenix": (33.4484, -112.0740), "tucson": (32.2226, -110.9747),
    "philadelphia": (39.9526, -75.1652), "pittsburgh": (40.4406, -79.9959),
    "boston": (42.3601, -71.0589), "cambridge": (42.3736, -71.1097),
    "worcester": (42.2626, -71.8023),
    "seattle": (47.6062, -122.3321), "spokane": (47.6588, -117.4260),
    "tacoma": (47.2529, -122.4443),
    "denver": (39.7392, -104.9903), "boulder": (40.0150, -105.2705),
    "aurora": (39.7294, -104.8319),
    "washington": (38.9072, -77.0369),
    "nashville": (36.1627, -86.7816), "memphis": (35.1495, -90.0490),
    "knoxville": (35.9606, -83.9207),
    "portland": (45.5152, -122.6784), "eugene": (44.0521, -123.0868),
    "atlanta": (33.7490, -84.3880), "augusta": (33.4735, -82.0105),
    "savannah": (32.0809, -81.0912),
    "miami": (25.7617, -80.1918), "orlando": (28.5383, -81.3792),
    "tampa": (27.9506, -82.4572), "jacksonville": (30.3322, -81.6557),
    "gainesville": (29.6516, -82.3248),
    "baltimore": (39.2904, -76.6122), "bethesda": (38.9847, -77.0947),
    "annapolis": (38.9784, -76.4922),
    "detroit": (42.3314, -83.0458), "ann arbor": (42.2808, -83.7430),
    "grand rapids": (42.9634, -85.6681),
    "minneapolis": (44.9778, -93.2650), "saint paul": (44.9537, -93.0900),
    "st paul": (44.9537, -93.0900), "rochester mn": (44.0121, -92.4802),
    "st louis": (38.6270, -90.1994), "saint louis": (38.6270, -90.1994),
    "kansas city": (39.0997, -94.5786),
    "cleveland": (41.4993, -81.6944), "columbus": (39.9612, -82.9988),
    "cincinnati": (39.1031, -84.5120), "toledo": (41.6528, -83.5379),
    "dayton": (39.7589, -84.1916),
    "las vegas": (36.1699, -115.1398), "reno": (39.5296, -119.8138),
    "new orleans": (29.9511, -90.0715), "baton rouge": (30.4515, -91.1871),
    "charlotte": (35.2271, -80.8431), "raleigh": (35.7796, -78.6382),
    "durham": (35.9940, -78.8986), "chapel hill": (35.9132, -79.0558),
    "indianapolis": (39.7684, -86.1581),
    "milwaukee": (43.0389, -87.9065), "madison": (43.0731, -89.4012),
    "salt lake city": (40.7608, -111.8910), "provo": (40.2338, -111.6585),
    "albuquerque": (35.0844, -106.6504),
    "honolulu": (21.3069, -157.8583),
    "anchorage": (61.2181, -149.9003),
    "richmond": (37.5407, -77.4360), "norfolk": (36.8508, -76.2859),
    "charlottesville": (38.0293, -78.4767), "arlington": (38.8816, -77.0910),
    "birmingham": (33.5186, -86.8104), "montgomery": (32.3792, -86.3077),
    "mobile": (30.6954, -88.0399),
    "little rock": (34.7465, -92.2896),
    "oklahoma city": (35.4676, -97.5164), "tulsa": (36.1540, -95.9928),
    "wichita": (37.6872, -97.3301),
    "omaha": (41.2565, -95.9345), "lincoln": (40.8136, -96.7026),
    "des moines": (41.5868, -93.6250), "iowa city": (41.6611, -91.5302),
    "louisville": (38.2527, -85.7585), "lexington": (38.0406, -84.5037),
    "jackson": (32.2988, -90.1848),
    "columbia": (34.0007, -81.0348), "charleston": (32.7765, -79.9311),
    "providence": (41.8240, -71.4128),
    "hartford": (41.7658, -72.6734), "new haven": (41.3083, -72.9279),
    "burlington": (44.4759, -73.2121),
    "manchester": (42.9956, -71.4548),
    "wilmington": (39.7391, -75.5398),
    "newark": (40.7357, -74.1724), "princeton": (40.3573, -74.6672),
    "trenton": (40.2206, -74.7597),
    "boise": (43.6150, -116.2023),
    "billings": (45.7833, -108.5007), "bozeman": (45.6770, -111.0429),
    "fargo": (46.8772, -96.7898),
    "sioux falls": (43.5446, -96.7311),
    "cheyenne": (41.1400, -104.8202),
    "san juan": (18.4655, -66.1057),
}

# Display names that plain title-casing gets wrong.
_US_CITY_DISPLAY_OVERRIDES = {
    "new york": "New York City", "nyc": "New York City",
    "new york city": "New York City",
    "st louis": "St. Louis", "saint louis": "St. Louis",
    "st paul": "Saint Paul", "rochester mn": "Rochester",
    "washington": "Washington",
}

_missing = set(CITY_TO_STATE) ^ set(US_CITY_CENTROIDS)
assert not _missing, f"CITY_TO_STATE / US_CITY_CENTROIDS keys differ: {sorted(_missing)}"


def us_city_key(name: str):
    """Normalized CITY_TO_STATE key for a city name, or None if unknown."""
    if not name or not str(name).strip():
        return None
    key = _normalize(str(name))
    return key if key in CITY_TO_STATE else None


def us_city_state(key: str):
    """Canonical display name of the state a CITY_TO_STATE key belongs to."""
    return state_display_name(CITY_TO_STATE[key])


def us_city_display_name(key: str):
    """e.g. "los angeles" -> "Los Angeles, California"."""
    city = _US_CITY_DISPLAY_OVERRIDES.get(key, key.title())
    state = us_city_state(key)
    if state == "District of Columbia":
        return "Washington, D.C."
    return f"{city}, {state}"


def geocode_us_city(key: str):
    """(lat, lon) for a CITY_TO_STATE key."""
    return US_CITY_CENTROIDS[key]


def is_exact_state_name(name: str) -> bool:
    """True only when `name` is itself a state/territory name or
    abbreviation ("New York", "NY"), not merely a longer string containing
    one ("New York City")."""
    if not name or not str(name).strip():
        return False
    key = _normalize(str(name))
    return ALIASES.get(key, key) in STATE_CENTROIDS
