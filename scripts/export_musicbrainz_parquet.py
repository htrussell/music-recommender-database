#!/usr/bin/env python3
"""Export a compact recording and artist-credit index from MusicBrainz PostgreSQL."""

import argparse
import os
from pathlib import Path

import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq


BATCH_SIZE = 50_000
SCHEMA = pa.schema(
    [
        ("recording_mbid", pa.string()),
        ("title", pa.string()),
        ("title_key", pa.string()),
        ("artist", pa.string()),
        ("duration_ms", pa.int64()),
    ]
)


def export_recordings(dsn: str, output_path: Path) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f"{output_path.name}.tmp")
    query = """
        SELECT
            recording.gid::text,
            recording.name,
            regexp_replace(lower(recording.name), '[^a-z0-9]+', '', 'g') AS title_key,
            artist_credit.name,
            recording.length
        FROM recording
        JOIN artist_credit ON artist_credit.id = recording.artist_credit
        WHERE recording.name IS NOT NULL
          AND artist_credit.name IS NOT NULL
        ORDER BY title_key, artist_credit.name, recording.gid
    """

    rows_written = 0
    try:
        with psycopg2.connect(dsn) as postgres:
            with postgres.cursor(name="musicbrainz_recordings") as cursor:
                cursor.itersize = BATCH_SIZE
                cursor.execute(query)
                with pq.ParquetWriter(
                    temporary_path,
                    SCHEMA,
                    compression="zstd",
                ) as writer:
                    while rows := cursor.fetchmany(BATCH_SIZE):
                        records = [
                            {
                                "recording_mbid": recording_mbid,
                                "title": title,
                                "title_key": title_key,
                                "artist": artist,
                                "duration_ms": duration_ms,
                            }
                            for recording_mbid, title, title_key, artist, duration_ms in rows
                        ]
                        writer.write_table(
                            pa.Table.from_pylist(records, schema=SCHEMA),
                            row_group_size=BATCH_SIZE,
                        )
                        rows_written += len(records)
        os.replace(temporary_path, output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    return rows_written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dsn",
        default=os.getenv("MUSICBRAINZ_DSN"),
        help="DSN for a separately imported MusicBrainz PostgreSQL database "
        "(defaults to MUSICBRAINZ_DSN).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "musicbrainz" / "recordings.parquet",
        help="Destination Parquet file.",
    )
    arguments = parser.parse_args()
    if not arguments.dsn:
        parser.error("provide --dsn or set MUSICBRAINZ_DSN")

    count = export_recordings(arguments.dsn, arguments.output)
    print(f"Exported {count:,} recordings to {arguments.output}")


if __name__ == "__main__":
    main()
