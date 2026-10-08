#!/usr/bin/env python3
"""
CSV to ERD tables

Transforms `dataset.csv`, `album_ratings.csv`, and `artists.csv` into the eight tables in `ERD.pdf`, 
then writes one CSV per table under `transformed/`.

Duplicate Spotify track IDs are reduced to one row: popularity uses the maximum observed value and 
genre uses the most frequent label (alphabetical tie-break). Collaborating artists are retained in 
the track/artist bridge. Album ratings are matched by title and a credited artist; unmatched rating 
albums remain standalone rows. Artist popularity uses Last.fm listener counts, and artist genres use 
the source artist tags. Other CSVs in `csv/` do not map to this ERD.
"""

from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
import calendar
import pandas as pd


def find_project_root(start: Path = Path.cwd()) -> Path:
    for candidate in (start.resolve(), *start.resolve().parents):
        if (candidate / 'csv' / 'dataset.csv').is_file():
            return candidate
    raise FileNotFoundError('Could not find csv/dataset.csv in the current directory or its parents')


def clean_key(value) -> str:
    if pd.isna(value):
        return ''
    return ' '.join(str(value).strip().casefold().split())


def split_credits(value) -> list[str]:
    if pd.isna(value):
        return []
    return [part.strip() for part in str(value).split(';') if part.strip()]


# --- Load Source CSVs ---
PROJECT_ROOT = find_project_root()
CSV_DIR = PROJECT_ROOT / 'csv'
OUTPUT_DIR = PROJECT_ROOT / 'transformed'

music_source = pd.read_csv(CSV_DIR / 'dataset.csv', low_memory=False)
album_source = pd.read_csv(CSV_DIR / 'album_ratings.csv', low_memory=False)
artist_source = pd.read_csv(
    CSV_DIR / 'artists.csv',
    usecols=[
        'artist_mb', 'artist_lastfm', 'country_mb', 'country_lastfm',
        'listeners_lastfm', 'tags_mb', 'tags_lastfm',
    ],
    low_memory=False,
)

print(f'Loaded {len(music_source):,} track rows, {len(album_source):,} album-rating rows, '
      f'and {len(artist_source):,} artist rows.')

# --- Artists and Genres ---
artist_display_candidates = defaultdict(set)
for value in music_source['artists'].dropna():
    for artist_name in split_credits(value):
        artist_display_candidates[clean_key(artist_name)].add(artist_name)
for artist_name in album_source['Artist'].dropna():
    artist_display_candidates[clean_key(artist_name)].add(str(artist_name).strip())
artist_display_candidates.pop('', None)

artist_keys = set(artist_display_candidates)
source_matches = []
for alias_column in ['artist_mb', 'artist_lastfm']:
    alias_keys = artist_source[alias_column].map(clean_key)
    matched = artist_source.loc[alias_keys.isin(artist_keys)].copy()
    matched['artist_key'] = alias_keys.loc[matched.index]
    matched['_source_order'] = matched.index
    source_matches.append(matched)

source_matches = pd.concat(source_matches, ignore_index=True)
source_matches['listeners_lastfm'] = pd.to_numeric(source_matches['listeners_lastfm'], errors='coerce')
source_matches['_listener_rank'] = source_matches['listeners_lastfm'].fillna(-1)
artist_source_selected = (
    source_matches.sort_values(
        ['artist_key', '_listener_rank', '_source_order'],
        ascending=[True, False, True],
        kind='stable',
    )
    .drop_duplicates('artist_key')
)

artist_display = {
    key: min(names, key=lambda name: (name.casefold(), name))
    for key, names in artist_display_candidates.items()
}
artist_id_map = {key: index for index, key in enumerate(sorted(artist_keys), start=1)}

genre_labels = defaultdict(Counter)

def add_genre(value):
    if pd.isna(value):
        return
    display = str(value).strip()
    key = clean_key(display)
    if key:
        genre_labels[key][display] += 1

for value in music_source['track_genre']:
    add_genre(value)
for value in album_source['Genre']:
    add_genre(value)
for row in artist_source_selected.itertuples(index=False):
    for column in ['tags_mb', 'tags_lastfm']:
        for tag in split_credits(getattr(row, column)):
            add_genre(tag)

genre_display = {
    key: sorted(counts, key=lambda label: (-counts[label], label.casefold(), label))[0]
    for key, counts in genre_labels.items()
}
genre_id_map = {key: index for index, key in enumerate(sorted(genre_display), start=1)}
genres = pd.DataFrame([
    {'genre_id': genre_id_map[key], 'genre_name': genre_display[key]}
    for key in sorted(genre_display)
])

artist_country_by_key = {}
artist_popularity_by_key = {}
for row in artist_source_selected.itertuples(index=False):
    country = row.country_mb if pd.notna(row.country_mb) else row.country_lastfm
    artist_country_by_key[row.artist_key] = country if pd.notna(country) else pd.NA
    artist_popularity_by_key[row.artist_key] = (
        row.listeners_lastfm if pd.notna(row.listeners_lastfm) else pd.NA
    )

artists = pd.DataFrame([
    {
        'artist_id': artist_id_map[key],
        'artist_name': artist_display[key],
        'artist_country': artist_country_by_key.get(key, pd.NA),
        'artist_popularity': artist_popularity_by_key.get(key, pd.NA),
    }
    for key in sorted(artist_keys)
])

artist_genre_pairs = set()
for row in artist_source_selected.itertuples(index=False):
    artist_id = artist_id_map[row.artist_key]
    for column in ['tags_mb', 'tags_lastfm']:
        for tag in split_credits(getattr(row, column)):
            genre_id = genre_id_map.get(clean_key(tag))
            if genre_id is not None:
                artist_genre_pairs.add((artist_id, genre_id))
artist_genres = pd.DataFrame(
    sorted(artist_genre_pairs), columns=['artist_id', 'genre_id']
)

print(f'Created {len(artists):,} artists and {len(genres):,} genre rows; '
      f'{len(artist_genres):,} artist/genre links have source tags.')


# --- Albums and Scores ---
music_source['_genre_key'] = music_source['track_genre'].map(clean_key)
track_genre_counts = (
    music_source.groupby(['track_id', '_genre_key'], dropna=False)
    .size()
    .rename('genre_count')
    .reset_index()
    .sort_values(
        ['track_id', 'genre_count', '_genre_key'],
        ascending=[True, False, True],
        kind='stable',
    )
)
track_genre_by_id = track_genre_counts.drop_duplicates('track_id').set_index('track_id')['_genre_key']

music_unique = (
    music_source.sort_values('popularity', ascending=False, kind='stable')
    .drop_duplicates('track_id')
    .copy()
)
music_unique['_title_key'] = music_unique['album_name'].map(clean_key)
music_unique['_lead_artist_key'] = music_unique['artists'].map(
    lambda value: clean_key(split_credits(value)[0]) if split_credits(value) else ''
)
music_unique['_album_key'] = list(zip(music_unique['_title_key'], music_unique['_lead_artist_key']))

album_names_by_key = defaultdict(set)
album_artists_by_key = defaultdict(set)
album_track_genres = defaultdict(Counter)
for album_key, album_name, artist_credit, track_id in zip(
    music_unique['_album_key'], music_unique['album_name'],
    music_unique['artists'], music_unique['track_id'],
):
    if pd.notna(album_name) and str(album_name).strip():
        album_names_by_key[album_key].add(str(album_name).strip())
    else:
        album_names_by_key[album_key].add('')
    for artist_name in split_credits(artist_credit):
        album_artists_by_key[album_key].add(clean_key(artist_name))
    album_track_genres[album_key][track_genre_by_id.loc[track_id]] += 1

album_keys_by_title = defaultdict(set)
for album_key in album_names_by_key:
    album_keys_by_title[album_key[0]].add(album_key)

rating_album_keys = []
for row in album_source[['Title', 'Artist']].itertuples(index=False, name=None):
    title_key, artist_key = clean_key(row[0]), clean_key(row[1])
    if not title_key:
        rating_album_keys.append(None)
        continue
    candidates = [
        key for key in album_keys_by_title.get(title_key, set())
        if artist_key and artist_key in album_artists_by_key[key]
    ]
    if len(candidates) == 1:
        rating_album_keys.append(candidates[0])
    elif len(candidates) > 1:
        rating_album_keys.append((title_key, artist_key, 'rating'))
    else:
        rating_album_keys.append((title_key, artist_key))
    album_names_by_key[rating_album_keys[-1]].add(str(row[0]).strip())

ratings_work = album_source.copy()
ratings_work['_album_key'] = rating_album_keys
ratings_work = ratings_work[ratings_work['_album_key'].notna()].copy()
rating_value_columns = [
    'Release Month', 'Release Day', 'Release Year', 'Format', 'Label', 'Genre',
    'Metacritic Critic Score', 'Metacritic Reviews', 'Metacritic User Score',
    'Metacritic User Reviews', 'AOTY Critic Score', 'AOTY Critic Reviews',
    'AOTY User Score', 'AOTY User Reviews',
]
ratings_work['_completeness'] = ratings_work[rating_value_columns].notna().sum(axis=1)
rating_by_album = (
    ratings_work.sort_values('_completeness', ascending=False, kind='stable')
    .drop_duplicates('_album_key')
    .set_index('_album_key')
)

all_album_keys = sorted(set(album_names_by_key) | set(rating_by_album.index))
album_id_map = {key: index for index, key in enumerate(all_album_keys, start=1)}

month_numbers = {name.casefold(): number for number, name in enumerate(calendar.month_name) if name}
month_numbers.update({name.casefold(): number for number, name in enumerate(calendar.month_abbr) if name})

invalid_release_day_count = {'count': 0}

def format_release_date(row):
    if pd.isna(row['Release Year']):
        return pd.NA
    year = int(row['Release Year'])
    month_value = row['Release Month']
    if pd.isna(month_value) or not str(month_value).strip():
        return f'{year:04d}'
    month = month_numbers.get(str(month_value).strip().casefold())
    if month is None:
        raise ValueError(f'Unrecognized release month: {month_value!r}')
    day_value = row['Release Day']
    if pd.isna(day_value) or not str(day_value).strip():
        return f'{year:04d}-{month:02d}'
    try:
        return date(year, month, int(float(day_value))).isoformat()
    except (TypeError, ValueError):
        invalid_release_day_count['count'] += 1
        return f'{year:04d}-{month:02d}'

album_records = []
score_records = []
score_columns = {
    'metacritic_critic_score': 'Metacritic Critic Score',
    'metacritic_critic_count': 'Metacritic Reviews',
    'metacritic_user_score': 'Metacritic User Score',
    'metacritic_user_count': 'Metacritic User Reviews',
    'aoty_critic_score': 'AOTY Critic Score',
    'aoty_critic_count': 'AOTY Critic Reviews',
    'aoty_user_score': 'AOTY User Score',
    'aoty_user_count': 'AOTY User Reviews',
}
for album_key in all_album_keys:
    rating = rating_by_album.loc[[album_key]].iloc[0] if album_key in rating_by_album.index else None
    album_genre_key = clean_key(rating['Genre']) if rating is not None else ''
    if not album_genre_key:
        track_genres = album_track_genres.get(album_key, Counter())
        if track_genres:
            album_genre_key = sorted(
                track_genres,
                key=lambda key: (-track_genres[key], key),
            )[0]
    album_records.append({
        'album_id': album_id_map[album_key],
        'genre_id': genre_id_map.get(album_genre_key, pd.NA),
        'album_name': min(
            album_names_by_key.get(album_key, {''}),
            key=lambda name: (name.casefold(), name),
        ) or pd.NA,
        'album_format': rating['Format'] if rating is not None else pd.NA,
        'release_date': format_release_date(rating) if rating is not None else pd.NA,
        'label': rating['Label'] if rating is not None else pd.NA,
    })
    if rating is not None:
        score_record = {'album_id': album_id_map[album_key]}
        score_record.update({
            output_name: rating[source_name]
            for output_name, source_name in score_columns.items()
        })
        score_records.append(score_record)

albums = pd.DataFrame(album_records)
album_scores = pd.DataFrame(score_records, columns=['album_id', *score_columns.keys()])
print(f'Created {len(albums):,} albums; attached ratings for {len(album_scores):,} albums.')
print(f'Kept year/month precision for {invalid_release_day_count["count"]:,} malformed or invalid release days.')


# --- Tracks Export and Checks ---
music_unique['_genre_key'] = music_unique['track_id'].map(track_genre_by_id)
music_unique['_genre_id'] = music_unique['_genre_key'].map(genre_id_map)
music_unique['_album_id'] = music_unique['_album_key'].map(lambda key: album_id_map[key])

tracks = music_unique[[
    'track_id', '_album_id', '_genre_id', 'track_name',
    'popularity', 'duration_ms', 'explicit',
]].rename(columns={
    '_album_id': 'album_id',
    '_genre_id': 'genre_id',
    'duration_ms': 'duration_ms',
})

track_feel = music_unique[[
    'track_id', 'danceability', 'energy', 'key', 'loudness', 'mode',
    'speechiness', 'acousticness', 'instrumentalness', 'liveness',
    'valence', 'tempo', 'time_signature',
]].copy()

track_artist_pairs = set()
for track_id, artist_credit in zip(music_unique['track_id'], music_unique['artists']):
    for artist_name in split_credits(artist_credit):
        artist_id = artist_id_map.get(clean_key(artist_name))
        if artist_id is not None:
            track_artist_pairs.add((track_id, artist_id))
track_artists = pd.DataFrame(
    sorted(track_artist_pairs), columns=['track_id', 'artist_id']
)

tables = {
    'genre': genres,
    'album': albums,
    'album_scores': album_scores,
    'tracks': tracks,
    'track_feel': track_feel,
    'artists': artists,
    'track_artists': track_artists,
    'artist_genres': artist_genres,
}

genre_ids = set(genres['genre_id'])
album_ids = set(albums['album_id'])
track_ids = set(tracks['track_id'])
artist_ids = set(artists['artist_id'])

# Assertions
assert tracks['track_id'].is_unique
assert albums['album_id'].is_unique
assert genres['genre_id'].is_unique
assert artists['artist_id'].is_unique
assert album_scores['album_id'].is_unique
assert track_feel['track_id'].is_unique
assert tracks['album_id'].notna().all() and set(tracks['album_id']) <= album_ids
assert set(tracks['genre_id'].dropna()) <= genre_ids
assert set(albums['genre_id'].dropna()) <= genre_ids
assert set(album_scores['album_id']) <= album_ids
assert set(track_feel['track_id']) <= track_ids
assert set(track_artists['track_id']) <= track_ids