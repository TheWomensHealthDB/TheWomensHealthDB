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

This module only figures out *which state/region/country* a cohort should
be geocoded to (returning its canonical display name); turning that into
map coordinates is still done via state_centroids.geocode_state() /
country_centroids.geocode_country(), same as before.
"""

import re

from country_centroids import country_display_name
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


def _distinct_resolved_locations(text: str):
    """
    Splits `text` into segments and resolves them to distinct places, in the
    order first seen.

    This resolves in two passes rather than resolving each segment
    independently and merging the results, because the two lookup
    strategies -- "is this segment itself a state/country name" vs. "is this
    segment a city we can map to a state" -- can genuinely disagree, and a
    named city is inherently ambiguous (e.g. "Rochester" could be Rochester,
    NY or Rochester, MN). If any segment is itself a recognizable
    state/region/country, that always wins: a plain "City, State" pair (e.g.
    "Rochester, Minnesota") should resolve to that one named state, not get
    miscounted as two different locations just because "Rochester" also
    happens to be a major city in a *different* state per
    state_centroids.CITY_TO_STATE. The city lookup is only consulted as a
    fallback when *no* segment in the cell names a recognizable
    state/region/country at all.
    """
    text = _normalize(text)
    if not text:
        return []
    segments = _SPLIT_RE.split(text)

    places = []
    for segment in segments:
        resolved = _resolve_segment_place(segment)
        if resolved and resolved not in places:
            places.append(resolved)
    if places:
        return places

    cities = []
    for segment in segments:
        resolved = state_from_city(segment.strip().strip("."))
        if resolved and resolved not in cities:
            cities.append(resolved)
    return cities


def _first_from_pi(pi_text: str):
    """Resolves the PI/study location column, taking the first state/region/
    country it names (per "if it lists multiple, just use the first one
    listed")."""
    locations = _distinct_resolved_locations(pi_text)
    return locations[0] if locations else None


def resolve_participant_location(subject_population_location: str, pi_location: str):
    """
    Returns (display_name, source) for a single cohort, where `source` is a
    short string describing which column/rule produced the answer (useful
    for debugging/warnings) -- or (None, None) if nothing could be
    resolved at all.
    """
    spl = _normalize(subject_population_location)

    if not spl or spl.lower() in NATIONWIDE_TOKENS:
        result = _first_from_pi(pi_location)
        return (result, "pi_location (subject location blank/nationwide)") if result else (None, None)

    locations = _distinct_resolved_locations(spl)

    if len(locations) == 1:
        return locations[0], "subject_population_location"

    if len(locations) >= 2:
        result = _first_from_pi(pi_location)
        return (result, "pi_location (subject location listed multiple)") if result else (None, None)

    # SPL was non-empty but nothing in it resolved (e.g. an unrecognized
    # city, or free text with no state/country/city we know about). Don't
    # silently fall back to the PI location here -- that would mask a gap
    # in state_centroids.CITY_TO_STATE that's worth surfacing instead.
    return None, None
