from pyspark.sql import SparkSession


spark = (
    SparkSession.builder.appName("MusicCatalogParquetToHDFS")
    .master("local[*]")
    .config("spark.hadoop.fs.defaultFS", "hdfs://namenode:9000")
    .getOrCreate()
)

LOCAL_INPUT_BASE = "/home/jovyan/transformed"
HDFS_OUTPUT_BASE = "hdfs://namenode:9000/warehouse/music"
TABLES = (
    "genre",
    "artists",
    "album",
    "album_scores",
    "tracks",
    "track_feel",
    "track_artists",
    "artist_genres",
)

for table_name in TABLES:
    source_path = f"{LOCAL_INPUT_BASE}/{table_name}.parquet"
    print(f"Ingesting {source_path}...")
    dataframe = spark.read.parquet(source_path)
    (
        dataframe.write.mode("overwrite")
        .option("compression", "snappy")
        .parquet(f"{HDFS_OUTPUT_BASE}/{table_name}")
    )
    print(f"Successfully stored {table_name}.parquet to HDFS.")

spark.stop()
