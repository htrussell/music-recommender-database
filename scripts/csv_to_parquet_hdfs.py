from pyspark.sql import SparkSession
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

spark = (
    SparkSession.builder.appName("MusicCatalogParquetETL")
    .master("local[*]")
    .config("spark.hadoop.fs.defaultFS", "hdfs://namenode:9000")
    .getOrCreate()
)

LOCAL_INPUT_BASE = "/opt/spark/data/transformed"
HDFS_OUTPUT_BASE = "hdfs://namenode:9000/warehouse/music"

SCHEMAS = {
    "genre": StructType([
        StructField("genre_id", IntegerType(), False),
        StructField("genre_name", StringType(), False),
    ]),
    "artists": StructType([
        StructField("artist_id", IntegerType(), False),
        StructField("artist_name", StringType(), False),
        StructField("artist_country", StringType(), True),
        StructField("artist_popularity", DoubleType(), True),
    ]),
    "artist_genres": StructType([
        StructField("artist_id", IntegerType(), False),
        StructField("genre_id", IntegerType(), False),
    ]),
    "album": StructType([
        StructField("album_id", IntegerType(), False),
        StructField("genre_id", IntegerType(), True),
        StructField("album_name", StringType(), True),
        StructField("album_format", StringType(), True),
        StructField("release_date", StringType(), True),
        StructField("label", StringType(), True),
    ]),
    "album_scores": StructType([
        StructField("album_id", IntegerType(), False),
        StructField("metacritic_critic_score", DoubleType(), True),
        StructField("metacritic_critic_count", IntegerType(), True),
        StructField("metacritic_user_score", DoubleType(), True),
        StructField("metacritic_user_count", IntegerType(), True),
        StructField("aoty_critic_score", DoubleType(), True),
        StructField("aoty_critic_count", IntegerType(), True),
        StructField("aoty_user_score", DoubleType(), True),
        StructField("aoty_user_count", IntegerType(), True),
    ]),
    "tracks": StructType([
        StructField("track_id", StringType(), False),
        StructField("album_id", IntegerType(), False),
        StructField("genre_id", IntegerType(), True),
        StructField("track_name", StringType(), True),
        StructField("popularity", IntegerType(), True),
        StructField("duration_ms", IntegerType(), True),
        StructField("explicit", BooleanType(), True),
    ]),
    "track_feel": StructType([
        StructField("track_id", StringType(), False),
        StructField("danceability", DoubleType(), True),
        StructField("energy", DoubleType(), True),
        StructField("key", IntegerType(), True),
        StructField("loudness", DoubleType(), True),
        StructField("mode", IntegerType(), True),
        StructField("speechiness", DoubleType(), True),
        StructField("acousticness", DoubleType(), True),
        StructField("instrumentalness", DoubleType(), True),
        StructField("liveness", DoubleType(), True),
        StructField("valence", DoubleType(), True),
        StructField("tempo", DoubleType(), True),
        StructField("time_signature", IntegerType(), True),
    ]),
    "track_artists": StructType([
        StructField("track_id", StringType(), False),
        StructField("artist_id", IntegerType(), False),
    ]),
}

for table_name, schema in SCHEMAS.items():
    print(f"Ingesting {table_name}...")
    df = (
        spark.read.format("csv")
        .option("header", "true")
        .schema(schema)
        .load(f"{LOCAL_INPUT_BASE}/{table_name}.csv")
    )

    (
        df.write.mode("overwrite")
        .option("compression", "snappy")
        .parquet(f"{HDFS_OUTPUT_BASE}/{table_name}")
    )
    print(f"Successfully stored {table_name}.parquet to HDFS.")

spark.stop()