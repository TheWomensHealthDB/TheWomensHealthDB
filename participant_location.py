"""
participant_location.py

Resolves a single, geocodable "where is this cohort's map pin" location for
each cohort from two raw, free-text spreadsheet columns:

  - "Subject population location" (SPL): where the study's participants
    actually are. Formatted inconsistently -- sometimes "City, State",
    sometimes just a state or a country, sometimes several locations listed
    together, sometimes literally "Nationwide", sometimes just a bare city
    with no state attached.
  - "State/Territory (*location of PI/study, not necessarily where the
    data/cohort is collected)" (PI location): used as a fallback whenever
    SPL doesn't name one clear, single state/region.

Resolution rules (see resolve_participant_location()):
  1. If SPL is blank, or says "Nationwide" (in any of a few common
     spellings), or names more than one distinct state/region/country ->
     fall back to the PI location column, using the *first* state/region it
     names.
  2. Otherwise, if SPL names exactly one state/region/country -> use that
     (ignoring any city name that comes along with it, e.g. "Los Angeles,
     CA" resolves to California).
  3. Otherwise, if SPL names no recognizable state/region but does name a
     known city -> use that city's state (best-effort, see
     state_centroids.CITY_TO_STATE).
  4. If none of the above resolves anything, the cohort is left unplaced on
     the map (same as an ungeocodable "Location" value previously) and a
     warning is emitted so it can be investigated/added to the lookup
     tables.

This module figures out *which* place a cohort should be geocoded to,
returning its canonical display name -- turning that into map coordinates
is normally done via state_centroids.geocode_state() /
country_centroids.geocode_country(), same as before. The one exception:
when a value names a specific *non-U.S. city* that's in
country_centroids.CITY_CENTROIDS (e.g. "Melbourne", or "Melbourne,
Australia"), this module also returns that city's own precise (lat, lon)
directly, so the caller can place the cohort there instead of falling all
the way back to its country's much coarser centroid. U.S. locations
intentionally stay state-level only, even when a city is named (see
resolve_participant_location() rule 2) -- there's no equivalent U.S.
city-level centroid table, since state-level precision was the original,
deliberate design for U.S. cohorts.
"""

import re

from country_centroids import (
    city_display_name,
    country_display_name,
    country_from_city,
    geocode_city,
)
from state_centroids import state_display_name, state_from_city

# Recognized spellings of "this study recruited from all over, not one
# place" -- treated the same as a blank Subject population location.
NATIONWIDE_TOKENS = {
    "nationwide",
    "nation-wide",
    "national",
    "us nationwide",
    "usa nationwide",
    "nationwide (us)",
    "nationwide (usa)",
    "multi-site (nationwide)",
    "national (us)",
}

# Splits a location cell into individual candidate locations. Handles the
# common separators seen in free-text location fields: commas, semicolons,
# slashes, "and"/"&"/"or", and newlines. NOTE: a plain "City, State" is
# still split into two segments here ("City" and "State") -- that's fine,
# because _resolve_segment() below independently resolves each segment, and
# both segments of a "City, State" pair resolve to the *same* state, so
# de-duplication downstream collapses them back into a single location.
_SPLIT_RE = re.compile(r"\s*(?:,|;|/|\band\b|&|\bor\b|[\r\n])\s*", re.IGNORECASE)

# Matches "Nationwide (CAN)", "Nationwide (AUS)", "Nationwide (US)", etc. --
# a "Nationwide" value with a parenthetical country hint attached. Checked
# before the plain NATIONWIDE_TOKENS set below so the country hint can be
# used directly instead of always falling back to the PI/study location
# (which may not even be filled in).
_NATIONWIDE_HINT_RE = re.compile(
    r"^(?:nationwide|nation-wide|national)\s*\(\s*([^)]+?)\s*\)\.?$",
    re.IGNORECASE,
)


def _normalize(text) -> str:
    if text is None:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def _resolve_segment_place(segment: str):
    """
    Resolves one segment to a country or U.S. state/territory name *only* --
    i.e. the segment itself has to be a recognizable country/state/territory
    name (ignoring case/punctuation/abbreviations). Does NOT consult the
    best-effort city lookup table. Returns None if the segment isn't a
    recognizable place name on its own.
    """
    segment = segment.strip().strip(".")
    if not segment:
        return None

    country = country_display_name(segment)
    if country:
        return country

    return state_display_name(segment)


def _resolve_segment_international_city(segment: str):
    """
    If `segment` names a recognized non-U.S. city (see
    country_centroids.CITY_CENTROIDS), returns (display_name, (lat, lon))
    using that city's own precise centroid -- e.g. "Melbourne" ->
    ("Melbourne, Australia", (-37.8136, 144.9631)). Returns None if the
    segment isn't a recognized city, or is recognized in
    country_centroids.CITY_TO_COUNTRY but doesn't (yet) have a matching
    entry in CITY_CENTROIDS.

    Deliberately doesn't consult state_centroids.CITY_TO_STATE -- U.S.
    locations intentionally stay state-level only (see module docstring),
    so this only ever returns a *non-U.S.* city.
    """
    segment = segment.strip().strip(".")
    if not segment:
        return None
    country = country_from_city(segment)
    city = city_display_name(segment)
    coords = geocode_city(segment)
    if not (country and city and coords):
        return None
    return f"{city}, {country}", coords


def _distinct_resolved_locations(text: str):
    """
    Splits `text` into segments and resolves them to distinct places, in the
    order first seen. Each returned item is a (display_name, coords) tuple,
    where `coords` is a precise (lat, lon) pair for a recognized non-U.S.
    city (see _resolve_segment_international_city()), or None for a
    country/U.S. state-level result (the caller geocodes those the same way
    as before, via state_centroids.geocode_state()/
    country_centroids.geocode_country()).

    Resolves in three passes:
      1. Precise non-U.S. city matches. Tried first so that when a segment
         names a specific known city (e.g. "Melbourne"), the result is that
         city's own centroid rather than the coarser country-level one a
         second pass would otherwise find.
      2. Plain country/U.S. state segment matches (the original "is this
         segment itself a state/country name" pass), *excluding* any
         country already implied by a pass-1 city match -- e.g. for
         "Melbourne, Australia", the "Australia" segment shouldn't count as
         a second, distinct location on top of "Melbourne, Australia";
         it's the same one place, just restated.
      3. A best-effort city-only fallback (unchanged from before), only
         reached if neither pass above found anything -- e.g. a bare U.S.
         city name with no state attached.

    A named city is inherently ambiguous with a same-named U.S. state/city
    (e.g. "Rochester" could be Rochester, NY or Rochester, MN) or a country
    substring match, which is why an explicit state/country name always
    wins over a same-cell city guess for anything pass 1 doesn't already
    resolve precisely.
    """
    text = _normalize(text)
    if not text:
        return []
    segments = _SPLIT_RE.split(text)

    city_matches = []  # [(display_name, (lat, lon)), ...]
    city_countries = set()
    for segment in segments:
        match = _resolve_segment_international_city(segment)
        if match and match[0] not in [m[0] for m in city_matches]:
            city_matches.append(match)
            city_countries.add(match[0].rsplit(", ", 1)[-1])

    place_matches = []
    for segment in segments:
        resolved = _resolve_segment_place(segment)
        if resolved and resolved not in city_countries and resolved not in place_matches:
            place_matches.append(resolved)

    combined = city_matches + [(p, None) for p in place_matches]
    if combined:
        return combined

    cities = []
    for segment in segments:
        seg = segment.strip().strip(".")
        # Try the U.S. city table first (larger/most common in this
        # dataset), then fall back to the international city table (only
        # reachable here for a city missing from CITY_CENTROIDS, since
        # anything present there was already handled by pass 1 above).
        resolved = state_from_city(seg) or country_from_city(seg)
        if resolved and resolved not in cities:
            cities.append(resolved)
    return [(c, None) for c in cities]


def _first_from_pi(pi_text: str):
    """Resolves the PI/study location column, taking the first (display,
    coords) result it names (per "if it lists multiple, just use the first
    one listed")."""
    locations = _distinct_resolved_locations(pi_text)
    return locations[0] if locations else None


def resolve_participant_location(subject_population_location: str, pi_location: str):
    """
    Returns (display_name, source, precise_coords) for a single cohort,
    where `source` is a short string describing which column/rule produced
    the answer (useful for debugging/warnings), and `precise_coords` is a
    (lat, lon) pair when `display_name` resolved to a specific recognized
    non-U.S. city (see _resolve_segment_international_city()) or None when
    it's a country/U.S.-state-level result -- the caller geocodes those the
    usual way, via state_centroids.geocode_state()/
    country_centroids.geocode_country(). Returns (None, None, None) if
    nothing could be resolved at all.
    """
    spl = _normalize(subject_population_location)

    if spl:
        hint_match = _NATIONWIDE_HINT_RE.match(spl)
        if hint_match:
            country = country_display_name(hint_match.group(1))
            if country:
                return country, "subject_population_location (nationwide, country given)", None
            # Parenthetical hint isn't a country we recognize -- fall
            # through to the standard blank/nationwide handling below
            # (PI/study location fallback), same as plain "Nationwide".

    if not spl or spl.lower() in NATIONWIDE_TOKENS or _NATIONWIDE_HINT_RE.match(spl):
        result = _first_from_pi(pi_location)
        if not result:
            return None, None, None
        display, coords = result
        return display, "pi_location (subject location blank/nationwide)", coords

    locations = _distinct_resolved_locations(spl)

    if len(locations) == 1:
        display, coords = locations[0]
        return display, "subject_population_location", coords

    if len(locations) >= 2:
        result = _first_from_pi(pi_location)
        if not result:
            return None, None, None
        display, coords = result
        return display, "pi_location (subject location listed multiple)", coords

    # SPL was non-empty but nothing in it resolved (e.g. an unrecognized
    # city, or free text with no state/country/city we know about). Don't
    # silently fall back to the PI location here -- that would mask a gap
    # in state_centroids.CITY_TO_STATE that's worth surfacing instead.
    return None, None, None
