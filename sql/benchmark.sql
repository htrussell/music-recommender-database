\timing on

BEGIN;

-- =========================================================
-- 1. BASELINE RUN (Forcing Sequential Scans)
-- =========================================================
SET enable_indexscan = OFF;
SET enable_bitmapscan = OFF;
SET enable_indexonlyscan = OFF;

\echo 'BASELINE Q1 - specific track in album'
EXPLAIN ANALYZE
SELECT
    t.track_id, t.track_name, al.album_name, g.genre_name,
    t.popularity, t.duration_ms, t.explicit,
    tf.danceability, tf.energy, tf.key, tf.loudness, tf.acousticness,
    tf.instrumentalness, tf.liveness, tf.valence, tf.tempo,
    (
        SELECT STRING_AGG(ar.artist_name, ', ' ORDER BY ar.artist_name)
        FROM track_artists ta
        INNER JOIN artists ar ON ta.artist_id = ar.artist_id
        WHERE ta.track_id = t.track_id
    ) AS artists
FROM tracks t
INNER JOIN album al ON t.album_id = al.album_id
LEFT JOIN genre g ON t.genre_id = g.genre_id
LEFT JOIN track_feel tf ON t.track_id = tf.track_id
WHERE t.album_id = 42837 AND t.track_name = 'Lolly';

\echo 'BASELINE Q2 - exact album by title and release date'
EXPLAIN ANALYZE
SELECT
    al.album_id, al.album_name, al.album_format, al.release_date, al.label,
    g.genre_name, s.metacritic_critic_score, s.metacritic_critic_count,
    s.metacritic_user_score, s.metacritic_user_count, s.aoty_critic_score,
    s.aoty_critic_count, s.aoty_user_score, s.aoty_user_count
FROM album al
LEFT JOIN genre g ON al.genre_id = g.genre_id
LEFT JOIN album_scores s ON al.album_id = s.album_id
WHERE al.album_name = '!' AND al.release_date = '1995-10-03';

\echo 'BASELINE Q3 - popular tracks in a genre'
EXPLAIN ANALYZE
SELECT
    t.track_id, t.track_name, g.genre_name, t.popularity, t.duration_ms, t.explicit
FROM tracks t
INNER JOIN genre g ON t.genre_id = g.genre_id
WHERE t.genre_id = 2279 AND t.popularity BETWEEN 0 AND 100
ORDER BY t.popularity DESC;

\echo 'BASELINE Q4 - highly-rated albums in a genre and period'
EXPLAIN ANALYZE
SELECT
    al.album_id, al.album_name, al.release_date, al.album_format, al.label,
    g.genre_name, s.metacritic_critic_score, s.metacritic_user_score
FROM album al
INNER JOIN genre g ON al.genre_id = g.genre_id
INNER JOIN album_scores s ON al.album_id = s.album_id
WHERE al.genre_id = 40119 
  AND al.release_date BETWEEN '2000' AND '2010' 
  AND s.metacritic_critic_score >= 80
ORDER BY s.metacritic_critic_score DESC, al.release_date DESC;

\echo 'BASELINE Q5 - compare musical characteristics of genres'
EXPLAIN ANALYZE
SELECT
    g.genre_id, g.genre_name, COUNT(*) AS track_count,
    ROUND(AVG(t.popularity)::numeric, 2) AS avg_popularity,
    ROUND(AVG(tf.danceability)::numeric, 3) AS avg_danceability,
    ROUND(AVG(tf.energy)::numeric, 3) AS avg_energy,
    ROUND(AVG(tf.tempo)::numeric, 2) AS avg_tempo,
    ROUND(100.0 * COUNT(*) FILTER (WHERE t.explicit IS TRUE) / NULLIF(COUNT(*), 0), 2) AS explicit_percentage
FROM genre g
INNER JOIN tracks t ON g.genre_id = t.genre_id
INNER JOIN track_feel tf ON t.track_id = tf.track_id
GROUP BY g.genre_id, g.genre_name
ORDER BY avg_popularity DESC;

\echo 'BASELINE Q6 - compare artists by album review scores'
EXPLAIN ANALYZE
WITH artist_albums AS (
    SELECT DISTINCT ta.artist_id, t.album_id
    FROM track_artists ta
    INNER JOIN tracks t ON ta.track_id = t.track_id
    WHERE t.album_id IS NOT NULL
)
SELECT
    ar.artist_id, ar.artist_name, ar.artist_country,
    COUNT(aa.album_id) AS album_count,
    ROUND(AVG(s.metacritic_critic_score)::numeric, 2) AS avg_metacritic_critic_score,
    ROUND(AVG(s.metacritic_user_score)::numeric, 2) AS avg_metacritic_user_score,
    ROUND(AVG(s.aoty_critic_score)::numeric, 2) AS avg_aoty_critic_score
FROM artist_albums aa
INNER JOIN artists ar ON aa.artist_id = ar.artist_id
INNER JOIN album_scores s ON aa.album_id = s.album_id
GROUP BY ar.artist_id, ar.artist_name, ar.artist_country
HAVING COUNT(aa.album_id) >= 2
ORDER BY avg_metacritic_critic_score DESC NULLS LAST, album_count DESC;

\echo 'BASELINE Q7 - specific artist'
EXPLAIN ANALYZE
SELECT artist_id, artist_name, artist_country, artist_popularity
FROM artists
WHERE artist_name = '!!!' AND artist_country = 'United States';

\echo 'BASELINE Q8 - albums released during a period'
EXPLAIN ANALYZE
SELECT album_id, album_name, album_format, release_date, label
FROM album
WHERE release_date BETWEEN '2000' AND '2010'
ORDER BY release_date;


-- =========================================================
-- 2. CREATE INDEXES & UPDATE PLANNER STATS
-- =========================================================
CREATE INDEX idx_tracks_album_name   ON tracks  (album_id, track_name);
CREATE INDEX idx_album_name_date     ON album   (album_name, release_date);
CREATE INDEX idx_artists_name_ctry   ON artists (artist_name, artist_country);
CREATE INDEX idx_tracks_genre_pop    ON tracks  (genre_id, popularity);
CREATE INDEX idx_album_genre_date    ON album   (genre_id, release_date);
CREATE INDEX idx_album_release_date  ON album   (release_date);

ANALYZE tracks;
ANALYZE album;
ANALYZE artists;
ANALYZE genre;


-- =========================================================
-- 3. INDEXED RUN (Restoring Query Planner Defaults)
-- =========================================================
RESET enable_indexscan;
RESET enable_bitmapscan;
RESET enable_indexonlyscan;

\echo 'INDEXED Q1 - specific track in album'
EXPLAIN ANALYZE
SELECT
    t.track_id, t.track_name, al.album_name, g.genre_name,
    t.popularity, t.duration_ms, t.explicit,
    tf.danceability, tf.energy, tf.key, tf.loudness, tf.acousticness,
    tf.instrumentalness, tf.liveness, tf.valence, tf.tempo,
    (
        SELECT STRING_AGG(ar.artist_name, ', ' ORDER BY ar.artist_name)
        FROM track_artists ta
        INNER JOIN artists ar ON ta.artist_id = ar.artist_id
        WHERE ta.track_id = t.track_id
    ) AS artists
FROM tracks t
INNER JOIN album al ON t.album_id = al.album_id
LEFT JOIN genre g ON t.genre_id = g.genre_id
LEFT JOIN track_feel tf ON t.track_id = tf.track_id
WHERE t.album_id = 42837 AND t.track_name = 'Lolly';

\echo 'INDEXED Q2 - exact album by title and release date'
EXPLAIN ANALYZE
SELECT
    al.album_id, al.album_name, al.album_format, al.release_date, al.label,
    g.genre_name, s.metacritic_critic_score, s.metacritic_critic_count,
    s.metacritic_user_score, s.metacritic_user_count, s.aoty_critic_score,
    s.aoty_critic_count, s.aoty_user_score, s.aoty_user_count
FROM album al
LEFT JOIN genre g ON al.genre_id = g.genre_id
LEFT JOIN album_scores s ON al.album_id = s.album_id
WHERE al.album_name = '!' AND al.release_date = '1995-10-03';

\echo 'INDEXED Q3 - popular tracks in a genre'
EXPLAIN ANALYZE
SELECT
    t.track_id, t.track_name, g.genre_name, t.popularity, t.duration_ms, t.explicit
FROM tracks t
INNER JOIN genre g ON t.genre_id = g.genre_id
WHERE t.genre_id = 2279 AND t.popularity BETWEEN 0 AND 100
ORDER BY t.popularity DESC;

\echo 'INDEXED Q4 - highly-rated albums in a genre and period'
EXPLAIN ANALYZE
SELECT
    al.album_id, al.album_name, al.release_date, al.album_format, al.label,
    g.genre_name, s.metacritic_critic_score, s.metacritic_user_score
FROM album al
INNER JOIN genre g ON al.genre_id = g.genre_id
INNER JOIN album_scores s ON al.album_id = s.album_id
WHERE al.genre_id = 40119 
  AND al.release_date BETWEEN '2000' AND '2010' 
  AND s.metacritic_critic_score >= 80
ORDER BY s.metacritic_critic_score DESC, al.release_date DESC;

\echo 'INDEXED Q5 - compare musical characteristics of genres'
EXPLAIN ANALYZE
SELECT
    g.genre_id, g.genre_name, COUNT(*) AS track_count,
    ROUND(AVG(t.popularity)::numeric, 2) AS avg_popularity,
    ROUND(AVG(tf.danceability)::numeric, 3) AS avg_danceability,
    ROUND(AVG(tf.energy)::numeric, 3) AS avg_energy,
    ROUND(AVG(tf.tempo)::numeric, 2) AS avg_tempo,
    ROUND(100.0 * COUNT(*) FILTER (WHERE t.explicit IS TRUE) / NULLIF(COUNT(*), 0), 2) AS explicit_percentage
FROM genre g
INNER JOIN tracks t ON g.genre_id = t.genre_id
INNER JOIN track_feel tf ON t.track_id = tf.track_id
GROUP BY g.genre_id, g.genre_name
ORDER BY avg_popularity DESC;

\echo 'INDEXED Q6 - compare artists by album review scores'
EXPLAIN ANALYZE
WITH artist_albums AS (
    SELECT DISTINCT ta.artist_id, t.album_id
    FROM track_artists ta
    INNER JOIN tracks t ON ta.track_id = t.track_id
    WHERE t.album_id IS NOT NULL
)
SELECT
    ar.artist_id, ar.artist_name, ar.artist_country,
    COUNT(aa.album_id) AS album_count,
    ROUND(AVG(s.metacritic_critic_score)::numeric, 2) AS avg_metacritic_critic_score,
    ROUND(AVG(s.metacritic_user_score)::numeric, 2) AS avg_metacritic_user_score,
    ROUND(AVG(s.aoty_critic_score)::numeric, 2) AS avg_aoty_critic_score
FROM artist_albums aa
INNER JOIN artists ar ON aa.artist_id = ar.artist_id
INNER JOIN album_scores s ON aa.album_id = s.album_id
GROUP BY ar.artist_id, ar.artist_name, ar.artist_country
HAVING COUNT(aa.album_id) >= 2
ORDER BY avg_metacritic_critic_score DESC NULLS LAST, album_count DESC;

\echo 'INDEXED Q7 - specific artist'
EXPLAIN ANALYZE
SELECT artist_id, artist_name, artist_country, artist_popularity
FROM artists
WHERE artist_name = '!!!' AND artist_country = 'United States';

\echo 'INDEXED Q8 - albums released during a period'
EXPLAIN ANALYZE
SELECT album_id, album_name, album_format, release_date, label
FROM album
WHERE release_date BETWEEN '2000' AND '2010'
ORDER BY release_date;

-- Rolling back destroys the manually created indexes so they don't bloat the schema permanently
ROLLBACK;