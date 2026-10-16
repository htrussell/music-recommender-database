# Music Recommender — Data Architecture Blueprint

> **Status:** Living architecture draft · **Evidence snapshot:** 2026-10-16
> **Purpose:** Document the working system as it exists today, distinguish implemented
> behavior from proposed architecture, and keep the blueprint easy to revise as the
> system evolves. The source of truth for current behavior remains the code and
> configuration linked throughout this document.

This blueprint uses the 15-section outline in
[`final_project_instructions.txt`](./final_project_instructions.txt). The initial
relational model is also captured in [`ERD.pdf`](../ERD.pdf). The eight entities in
that drawing are present in the transformation output and PostgreSQL loader.

## 1. Executive summary

The system supports music discovery: a listener describes a taste or request (and
may import a public YouTube playlist), and the application returns recommendations
grounded in a local music catalog. The current catalog pipeline transforms source
CSVs into eight Zstandard-compressed Parquet files. **Those Parquet files are the
canonical catalog snapshot. DuckDB reads them directly and is the primary catalog
query path for the AI system. PostgreSQL is a separately loaded relational backup
and bounded fallback, not the primary recommendation store.**
The draft guide's description of PostgreSQL as a relational catalog prototype is
not a complete current-state inventory: the repository evidence documented here
shows Parquet as the canonical catalog and DuckDB as its primary AI query engine,
with PostgreSQL retained as a reloadable backup/fallback. The guide is treated as
business-scope input; code/configuration remain the authority for implementation.

The browser UI and FastAPI service coordinate requests; the demo's configured
chat, recommendation, and catalog-query planning path calls a Cloudflare Worker.
A DuckDB FastAPI service exposes a small set of parameterized catalog tools. The
application may use a read-only PostgreSQL query path if DuckDB is unavailable or
a requested operation is unsupported. Playlist and taste-profile context is held
in the browser session, not persisted in the music database. Ollama and
`nomic-embed-text:v1.5` are configured for local embeddings, but no embedding
generation, vector index, or vector retrieval pipeline is implemented in the
current catalog path. Architecturally, the API/catalog could instead run on a
local server and call a local generation model (for example, Ollama), use cloud
models, or use a hybrid. A fully local model-serving mode is a deployment option,
not a current feature: Ollama is currently configured only for embeddings.

The proposed product goal is to turn a listener-reviewed playlist and stated
intent into a usable, explainable queue. The listener should be able to inspect
and correct the taste summary, state hard exclusions, refine recommendations in
conversation, and explicitly confirm any chat-inferred preference before it is
saved. Primary users are listeners who import playlists, request queues, and
manage their data; the product owner is the proposed sponsor. These are business
requirements for the target experience, not a description of all current demo
behavior. Production streaming-service integration, audio playback, payments,
advertising, and fully automated preference capture are outside the proposed
demo scope. The import mechanism beyond the current YouTube/normalized-JSON demo
path remains a team decision.

The current demo can import a public YouTube playlist through `yt-dlp` and can
accept normalized playlist JSON; that implementation fact does not settle the
longer-term import method. The guide's statement that the import method remains
a team decision applies to the target product. Generated queues are currently
session context. The target will let a listener explicitly save a chosen queue to
PostgreSQL; an active queue remains transient until that action. Kafka may receive
a small asynchronous queue-save event but is not the saved-queue store. Queues
use imported playlist context and stated/confirmed profile data, not presumed live
listening events.

### Scope and success criteria

**In scope:** catalog discovery and verification; playlist import as recommendation
context; a consent-led target import/review flow; static catalog transformation;
DuckDB query serving; PostgreSQL catalog backup/fallback; a **target design** for
persistent user profiles in PostgreSQL and
Kafka/Avro user-activity events; separate PostgreSQL conversation and topic-memory
storage with pgvector-based memory retrieval and expiry; existing SQL indexing
experiments; explicitly saved PostgreSQL queues with ordered tracks and reason
provenance; and a proposed analytical model that can be extended later.

**Not implemented today:** persistent user accounts/profiles, Kafka producers or
consumers for user events, Avro schemas/registry, playback or impression events,
feedback capture, online learning, scheduled/CDC catalog ingestion, a deployed
vector store, durable conversation logs or topic memories, structured
model-invocation telemetry, and a production analytics warehouse. The
profile/event, conversation-memory, and telemetry designs below are targets, not
current capabilities.

| ID | Measurable criterion | Current evidence / status |
|---|---|---|
| SC1 | Track/album/genre search tools return no more than 100 rows; verified-track requests contain no more than 50 input candidates. | **Implemented** in the DuckDB tool API and request models. Verification can return multiple matches per candidate, so its output is not asserted to be capped at 100 rows. |
| SC2 | PostgreSQL fallback allows one `SELECT` only, from an allowlisted catalog schema, with a maximum of 100 rows and an 8-second statement timeout. | **Implemented** in the API validator and read-only `music_reader` role. |
| SC3 | In catalog-grounded discovery, every selectable track has an ID resolved from the local catalog; already-imported/recommended session tracks are excluded from new queues. | **Implemented in the relevant UI flows** per README and API; end-to-end match-rate evidence is not recorded, and direct-prompt fuzzy matching can select imperfect title/artist candidates. |
| SC4 | A changed source snapshot is queryable within 24 hours of its availability. | **Not met / not yet designed:** transformation and PostgreSQL loading are manual/on-demand; no scheduler, freshness watermark, or automatic refresh is present. |
| SC5 (target) | Authenticated users can load/update only their own persistent profile, saved playlists, and explicitly saved queues; profile lookup target <100 ms. | **Architecture specified, not implemented:** no authentication integration or user-serving schema exists. |
| SC6 (target) | Eligible user mutations produce versioned events; consumer lag p95 <5 seconds, with no lost event across API/broker failure and duplicate-safe processing. | **Architecture specified, not implemented:** outbox/Kafka/Avro/consumer path remains future work; measure under failure tests. |
| SC7 (target) | Every model call has a correlation ID and records task/provider/model, observed duration, outcome, and retries; telemetry must not persist raw prompts, completions, credentials, or catalog result bodies. | **Architecture specified, not implemented:** current app has limited warning/error logs but no structured invocation telemetry, metrics backend, or durable telemetry topic. |
| SC8 (target) | Recent conversation history is retrievable only by its owner; aged logs are distilled into useful topic memories or discarded, and both logs and memories are deleted by configured expiry. | **Architecture specified, not implemented:** no conversation store, pgvector extension, memory retrieval, retention scheduler, or deletion workflow exists. |
| SC9 (target) | Record explicit consent before playlist import or preference persistence; process a listener deletion request and remove saved profile, playlist, queue, conversation, and derived data within 24 hours in the demo environment. | **Not implemented or verified:** no consent record, consent gate, or end-to-end deletion workflow is documented; 24-hour deletion is a proposed acceptance target. |
| SC10 (target) | Every imported playlist row is accepted or shown to the listener with a duplicate, unsupported, incomplete, or other validation reason; silently dropped rows are not acceptable. | **Not implemented or verified:** current importer normalizes returned entries, but no per-row review/outcome contract is documented. |
| SC11 (target) | For a reviewed 100-track playlist, return an explainable queue within 5 seconds in at least 95% of test runs, respect all hard exclusions, and identify the playlist or confirmed-preference signal supporting each recommendation. | **Not verified:** existing catalog latency targets are unmeasured; end-to-end queue timing, reason provenance, and hard-exclusion tests are required. |
| SC12 (target) | Persist no chat-inferred preference until the listener explicitly confirms it. | **Not implemented or verified:** no persistent preference-confirmation flow exists. |
| SC13 (target) | Keep generated queues transient until the listener explicitly saves one; saved queues are owner-scoped and reusable by that listener. | **Not implemented:** current queues remain session context; no saved-queue schema or API exists. |

The separate `csv/music_streaming_habits_2026.csv` is a possible demo-profile seed:
it contains 4,000 rows with unique sequential `listener_id` values, a single
`top_artist` and `top_genre` label, and aggregate listener attributes. It has no
track IDs, per-play events, actual playlists, or login identity mapping. The 14
distinct artist labels each have a unique normalized match to a catalog artist in
this snapshot. Genre matching is not one-to-one: multiple catalog genre rows
normalize to the same label, and several profile labels (such as `Afrobeats`,
`Lo-fi`, and `R&B`) do not directly match the active track-genre vocabulary.
Treat these rows as fixture/demo profiles, not authenticated production users or
streaming-event telemetry; build and validate an explicit genre alias crosswalk
before using those labels for retrieval.

The file-level snapshot currently contains 89,741 unique tracks, 87,152 albums,
39,528 artists, and 90,603 genre labels. The system demonstrates bounded access and
the catalog proof of concept, but no performance SLO or freshness SLA is established.
The next target adds durable user-owned state in PostgreSQL, an asynchronous
Kafka/Avro stream for preference and activity changes, privacy-minimized model
telemetry, and separate short-lived conversation logs plus expiring topic memories.
The user-event stream is not the login-time profile store: the API reads current
state from PostgreSQL; consumers use events for derived projections and analytics.
Persistent conversation history is proposed as opt-in and off by default; without
that opt-in, chat remains request/session context. The exact consent purposes and
notice must be approved before implementation.

## 2. Architecture principles

1. **Keep a portable canonical layer.** Transformed Parquet is the shared catalog
   artifact; DuckDB queries it without a separate table copy.
2. **Use the simplest engine for the access shape.** DuckDB serves local
   columnar reads and bounded analytical filters; PostgreSQL provides a relational
   backup and fallback for SQL-compatible access.
3. **Keep model access behind a narrow service boundary.** The AI API calls
   named DuckDB tools and validates PostgreSQL fallback SQL rather than granting
   the model direct database credentials.
4. **Make data lineage and quality checks explicit.** Transformation rules,
   schema checks, key checks, and source attribution belong in the ingestion path.
5. **Make consent and listener control prerequisites.** Import or persist personal
   data only after recorded, purpose-specific consent; provide inspect, correct,
   clear, and delete controls. The current implementation has no documented
   consent ledger or listener-data deletion workflow.
6. **Keep recommendation evidence reviewable.** Explanations must cite reviewed
   playlist rows, confirmed preferences, or explicit catalog attributes. AI
   inferences remain suggestions until the listener confirms them; ambiguous or
   unsupported imports must be shown, not silently matched or discarded.
7. **Treat listener context as session data unless persistence is deliberately
   designed.** Persistent conversation history is opt-in and off by default in
   the proposed product; the current implementation does not silently turn
   browser-session profile information into database master data.

Principles 1–3 are implemented. Principle 4 is partially implemented through
transformation assertions and loader schema checks; a retained lineage/quality
report is still needed. Principles 5–7 are target requirements, not current
capabilities; they should gate any move from session-only context to persistence.

## 3. Business processes and system context

### Process A — Catalog-grounded recommendation

The diagram below is a textual BPMN-style activity flow; the swimlanes show the
human, application/AI, catalog, and model-provider responsibilities. The
application decides when catalog context is needed; the language model does not
connect directly to a database.

```text
Listener              Browser / AI API                 DuckDB catalog          Cloudflare Worker
   |                           |                               |                         |
   |-- request + preferences ->|                               |                         |
   |                           |-- ask model to choose tool ---------------------------->|
   |                           |<-- tool + bounded arguments ----------------------------|
   |                           |-- parameterized tool query -->|                         |
   |                           |<-- up to 100 catalog rows -----|                         |
   |                           |-- prompt + approved context ---------------------------->|
   |                           |<-- recommendation response -----------------------------|
   |<-- render queue -----------|                               |                         |
```

   ```text
   Deployment choices (the catalog boundary remains behind the API):

     Current demo: Browser → FastAPI → DuckDB / Parquet
                                    └──────────────→ Cloudflare Worker (cloud models)

     Local-only option: Browser → FastAPI + local model runtime (e.g. Ollama)
                              ├→ DuckDB / Parquet
                              └→ PostgreSQL catalog fallback / user store

     Hybrid option: FastAPI + local model and catalog, with selected calls routed
                    to a cloud model provider under explicit data/provider policy.
   ```

   **Process A activities:** capture request; decide whether catalog facts are needed;
   ask the query model to select `search_tracks`, `search_albums`, `compare_genres`,
   `no_catalog`, or a fallback; validate tool arguments; query DuckDB; optionally use
   the read-only PostgreSQL fallback; send the selected catalog rows and approved
   session context to the response model; validate/normalize the response; render a
   queue; retain session exclusions in the browser. The current path sends model
   requests/context to the Cloudflare Worker. A local-only deployment could keep the
   model request, prompts, returned catalog rows, and generation on the operator's
   server; this would require configuring a local generation model and validating
   its structured-output/tool-planning capabilities.

### Process B — Playlist-grounded discovery

```text
Listener           Browser / AI API          YouTube (yt-dlp)       DuckDB          Worker
   |                       |                         |                   |              |
   |-- public playlist URL>|                         |                   |              |
   |                       |-- fetch playlist ------>|                   |              |
   |                       |<-- normalized tracks ---|                   |              |
   |<-- review/save ------ |                         |                   |              |
   |-- discover request + playlist context -------->|                   |              |
   |                       |-- query catalog when needed ---------------->|              |
   |                       |<-- candidate catalog rows ------------------|              |
   |                       |-- session context + candidates --------------------------->|
   |                       |<-- recommendation response --------------------------------|
   |<-- queue excluding imported/recent tracks ----------------------------------------|
```

For playlist-grounded recommendations, the imported playlist is taste context,
existing playlist tracks are excluded, and the API skips a redundant catalog-planning
call where configured. Playlist links are public URLs fetched locally with `yt-dlp`;
normalized JSON playlists are also accepted. Profile review/save stays in browser
session state.

The target product adds a consent and review gate that is not present in the
current flow: record purpose-specific consent before import or persistence; retain
the source order and a validation outcome for every imported row; show duplicates,
unsupported/incomplete entries, and ambiguous matches for listener review; and
use only reviewed rows for a corrected taste summary and queue. Explain each queue
item with its supporting reviewed row, confirmed preference, or explicit catalog
attribute. Enforce hard exclusions after candidate retrieval and before the queue
is returned. These target steps require implementation and testing; do not infer
that current normalization already provides per-row review or complete lineage.

```text
Target listener flow (proposed, not implemented):
  Listener: consent → import → review row outcomes → correct taste summary
            → state goal/exclusions → review explained queue → explicitly save
            → confirm/reject any inferred preference → manage/delete saved data
  API:      check consent → fetch/validate → preserve row status/provenance
            → build bounded listener-scoped context → enforce exclusions
            → attach reason evidence → persist only explicitly consented state
  AI:       summarize for correction → propose queue/reasons
            → present preference suggestions; never commit them as confirmed
```

### Process-to-data table

| Process step | Data object | Operation | Notes |
|---|---|---|---|
| Listener submits request | Request text, task, system instruction | Read | Sent from browser to AI API; profile details are session context. |
| Demo listener opens the application | Seed profile keyed by `listener_id`, top-artist/top-genre labels, aggregate attributes | Read (proposed) | CSV ID is not connected to authentication; resolve through a validated catalog crosswalk. |
| Authenticated listener loads/saves profile (target) | User profile, taste preferences, saved playlist and ordered entries | Read/create/update/delete | API authorizes principal; PostgreSQL is durable serving source; playlist tracks link to stable catalog `track_id` when resolved. |
| API records profile/activity action (target) | Versioned event envelope and event-specific payload | Create/publish | PostgreSQL transactional outbox publishes to Kafka with Avro serialization; do not publish raw conversation by default. |
| Kafka consumers process event (target) | User event, consumer offset, idempotency key | Read/create/update | Update derived features/analytics; PostgreSQL remains authority for current profile state. |
| Listener imports playlist | Public playlist URL | Read | API validates supported YouTube hosts and extracts playlist ID. |
| API fetches playlist | Playlist track title/artist/duration | Create/read | Retrieved with `yt-dlp`; returned to browser, not stored in catalog. |
| AI selects catalog operation | Tool name and arguments | Create | Model output is validated against the named tool contract. |
| DuckDB answers tool | Track, artist, genre, audio, album, rating rows | Read | Query directly over Parquet-backed views; maximum 100 rows. |
| PostgreSQL fallback | Same catalog entities | Read | Allowlisted, read-only `SELECT`; 8-second timeout and 100-row limit. |
| Response model generates queue/chat | Approved prompt context and returned rows | Read/create | Prompt and selected rows leave the local host for the Cloudflare Worker. |
| UI verifies generated titles | Candidate title/artist and catalog identity | Read | Exact/fuzzy verification may consult local catalog and optional MusicBrainz index. |
| Browser updates queue/profile | Queue entries, exclusions, taste notes | Create/read/update | Queue/session context remains ephemeral; no listener-profile table exists today. |
| Data preparation | Source CSV rows to canonical catalog | Read/create | Batch ETL builds Parquet; rerun of loader replaces PostgreSQL tables. |
| Listener grants or withdraws consent (target) | Purpose, decision, policy version, recorded time | Create/read/update | Gate import and persistence; withdrawal must trigger the applicable stop/delete behavior. |
| Import review (target) | Source row/order, normalized fields, status and reason, catalog match state | Create/read/update | Every row gets an accepted or visible exception status; ambiguous rows do not silently ground recommendations. |
| Taste-summary correction (target) | Summary version and listener edits | Read/create/update | Listener correction is authoritative for that listener, not a change to the shared catalog. |
| Preference inference and confirmation (target) | Candidate inference, explicit confirmation decision, provenance | Create/read/update/delete | Keep unconfirmed suggestions out of durable preferences and recommendation inputs. |
| Explainable queue generation (target) | Reviewed playlist rows, confirmed preferences, exclusions, candidate reasons | Read/create | Emit reason evidence for each item and enforce hard exclusions before return. |
| Listener saves a generated queue (target) | Saved queue header, ordered track entries, reason/evidence snapshots | Create/read/update/delete | Working queue stays in request/session context until explicit Save; PostgreSQL is the durable source, Kafka receives only an asynchronous lifecycle event. |
| Listener deletion (target) | Profile, playlist, preference, conversation, memory and derived data | Delete | Target completion within 24 hours; include caches, embeddings, event projections and backup-expiry behavior in the end-to-end test. |

### System context and boundaries

| Component / source | Holds or does | Status |
|---|---|---|
| Kaggle CSVs in `csv/` | Spotify track attributes, album ratings, artist metadata/tags, and a separate streaming-habits CSV. | Source files; not all are consumed by the current transformation. |
| `transform_erd.py` | Cleans, matches, deduplicates, normalizes, and writes eight Parquet tables. | Implemented batch transformation. |
| `transformed/*.parquet` | Canonical current catalog snapshot. | Primary data artifact. |
| DuckDB service | In-memory connection with views using `read_parquet`; parameterized search/verification tools. | Primary AI catalog query path. |
| PostgreSQL 15 | Relational copy of the same Parquet tables, loaded in batches. | Backup and read-only fallback. |
| FastAPI AI service | Request routing, worker calls, catalog-tool planning, validation, playlist import, and PostgreSQL fallback. | Implemented. |
| PostgreSQL user-serving schema (target) | Authenticated identity mapping, durable profile, normalized preferences, saved playlists and tracks, transactional outbox. | Proposed only; separate from catalog backup tables. |
| Kafka + Avro (target) | Versioned profile/activity events for asynchronous consumers and archival. | Kafka broker exists in optional Compose topology; user event topics/producers/consumers/registry are not configured. |
| Event consumer/archive (target) | Idempotent consumption, derived profile/analytics updates, Avro event files in HDFS, compacted Parquet for DuckDB. | Proposed only; no current consumer or archive writer. |
| Conversation/memory store (target) | Separate PostgreSQL `conversation_data` schema for short-lived messages and compact topic memories; pgvector for memory embeddings. | Proposed only; no durable transcripts, embedding generation, vector search, expiry, or deletion workflow. |
| Cloudflare Worker / Workers AI | Chat, recommendation, and catalog-tool/SQL planning. | External model execution; prompts and selected rows are sent there. |
| Ollama | Serves the configured local `nomic-embed-text:v1.5` embedding model. | Model is pulled/configured for embeddings; it is not currently the generation provider, and there is no vector ingestion/retrieval flow. |
| Local model runtime (deployment option) | Could host recommendation/chat/planning models beside the API and catalog. | Not currently wired for generation. Requires sufficient CPU/GPU memory and throughput, model lifecycle/updates, monitoring, and model capability checks; local deployment reduces third-party prompt transfer but does not itself provide authentication, privacy controls, or availability. |
| Optional MusicBrainz export | A user-supplied MusicBrainz PostgreSQL database can be exported to a compact Parquet matching index. | Optional; not downloaded/imported by this repository. |
| Kafka, ZooKeeper, Spark, HDFS, Jupyter | Compose services for experiments and optional paths. | Not connected to the primary catalog/recommendation data path. |
| `music_streaming_habits_2026.csv` | 4,000 listener-like rows with `listener_id`, profile attributes, and top-artist/top-genre labels. | Present but unused by current transform, API, or database; candidate demo seed only. |

## 4. Data domains and conceptual model

### Conceptual ERD

This conceptual view is technology-independent; it corresponds to the initial
relational ERD and the eight current catalog entities. A track may have zero or
many credited artists and each artist may credit zero or many tracks. The artist
genre assignment is another many-to-many relationship. Optional album scores are
one-to-zero-or-one per album; track audio features are one-to-zero-or-one per track.

```text
GENRE 1 ───── 0..* ALBUM 1 ───── 0..* TRACK 1 ───── 0..1 TRACK FEEL
  │                               │
  │                               └── 0..* ── TRACK ARTIST ── 0..* ── ARTIST
  │                                                                   │
  └── 0..* ───────────── ARTIST GENRE ────────────────────────────────┘

ALBUM 1 ───── 0..1 ALBUM SCORES
GENRE 1 ───── 0..* TRACK
```

**Proposed demo extension (not current catalog schema):** `DEMO LISTENER PROFILE`
has one row per seed `listener_id`. Its top artist can map to `ARTIST` through a
validated ID crosswalk; its top genre label should map through a versioned
`PROFILE GENRE ALIAS` relation to one or more selected catalog genre IDs, because
the catalog contains duplicate/punctuated genre variants and some demo labels
differ from the track-source vocabulary. This profile provides preferences and
summary statistics, not individual track history. An actual playlist would need
ordered track identities (or unresolved title/artist entries) in its own playlist
and playlist-track entities.

**Target persistent user model (not implemented):** an authenticated `USER` owns
one `USER PROFILE`, many typed `USER PREFERENCE` rows, and zero or more
`USER PLAYLIST`s with ordered `USER PLAYLIST TRACK` entries. Preference and
playlist changes also generate immutable `USER EVENT`s in Kafka. The event stream
is an activity/history integration boundary, not the profile's current-state
store. `USER EVENT` therefore has no FK into the catalog; catalog references use
the stable source `track_id` plus optional catalog build ID and are resolved by the
API/DuckDB service. Proposed fields, rules, and Avro contract are specified in
Section 5 and the pipeline subsection of Section 7.

The drawn foreign keys in the current schema make `ALBUM.genre_id` and
`TRACK.genre_id` optional, and `TRACK.album_id` optional at the DDL level.
Transformation assertions currently require every track to have an album ID and
valid album reference; genre can remain missing. All non-key descriptive fields
may be null unless their source data and transformation happen to populate them.

### Data source inventory and observed volumes

Counts and sizes below were measured from this local repository snapshot on
2026-10-16. Parquet sizes are Zstandard-compressed file sizes; bytes per row are
rough storage estimates, not logical record sizes. Monthly growth is **unknown**:
these are static downloaded snapshots, and no refresh history is maintained.

| Domain / current entity | Source and mapping | Current rows | Artifact size | Approx. bytes/row | Growth |
|---|---|---:|---:|---:|---|
| Track catalog (`tracks`) | `dataset.csv` (114,000 rows) → unique Spotify `track_id` | 89,741 | 3,574,158 B | 39.8 | Unknown; snapshot |
| Track features (`track_feel`) | Same track source → one feature row per unique track | 89,741 | 3,350,483 B | 37.3 | Unknown; snapshot |
| Track–artist links (`track_artists`) | Semicolon-separated artist credits | 123,424 | 1,794,078 B | 14.5 | Unknown; snapshot |
| Album (`album`) | Track source plus `album_ratings.csv` (32,358 rows) | 87,152 | 1,489,870 B | 17.1 | Unknown; snapshot |
| Album scores (`album_scores`) | Matched rating rows | 32,313 | 266,940 B | 8.3 | Unknown; snapshot |
| Artist (`artists`) | Credits plus matched rows from `artists.csv` (1,466,083 rows) | 39,528 | 659,917 B | 16.7 | Unknown; snapshot |
| Artist–genre links (`artist_genres`) | Matched MusicBrainz/Last.fm tags | 669,441 | 1,582,516 B | 2.4 | Unknown; snapshot |
| Genre (`genre`) | Track labels, album labels, artist tags | 90,603 | 1,078,276 B | 11.9 | Unknown; snapshot |
| Demo listener profile (proposed only) | `music_streaming_habits_2026.csv` | 4,000 | 340,693 B CSV | 85.2 | Static seed; no growth history |

The eight outputs total about 13.8 MB (13.2 MiB) compressed. The separate
`music_streaming_habits_2026.csv` contains 4,000 rows but is **not** consumed by
`transform_erd.py` or the recommender database; do not infer that it represents
actual application interaction logs. Raw CSV sizes and source-record counts differ
from the cleaned/merged target counts. The table figures are reproducible from
`transformed/` and the source inventory at the evidence date.

### Access patterns

Latency targets below are design targets, not measured SLAs. `DuckDB` is the
primary target unless the row says PostgreSQL fallback.

| ID | Pattern and query shape | Read/write | Expected frequency | Target latency | Consumer |
|---|---|---|---|---|---|
| AP1 | Find candidate tracks by title/artist/genre and filter by duration, energy, explicitness, exclusions; order by popularity. | Read | Each catalog-grounded recommendation | <5 s p95 target; unmeasured | AI API / listener |
| AP2 | Resolve up to 50 generated title/artist candidates by normalized/exact/fuzzy similarity; optionally compare MusicBrainz title index. | Read | Per direct-prompt verification request | <5 s target; unmeasured | AI API |
| AP3 | Search albums by text, genre, release year, and minimum critic score. | Read | On album requests | <5 s target; unmeasured | AI API |
| AP4 | Compare genre-level track counts, popularity, energy, danceability, tempo, explicit share. | Read/aggregate | On listener question or analysis | <5 s target; unmeasured | AI API / analyst |
| AP5 | Bounded PostgreSQL SQL fallback over allowlisted catalog tables. | Read | Exception/unsupported DuckDB operation | 8 s hard statement timeout; <=100 rows | AI API |
| AP6 | Rebuild canonical catalog from downloaded source CSVs. | Batch write | Manual/on-demand | No freshness SLO; runtime not measured | Maintainer |
| AP7 | Load PostgreSQL relational backup from canonical Parquet. | Batch write | Manual/on-demand | No freshness SLO; bounded 10,000-row batches | Maintainer |
| AP8 | Ad hoc genre/album/artist analysis against catalog entities. | Read/aggregate | Development/class project | Analyst-selected | Analyst / notebook |
| AP9 (proposed) | Resolve a demo profile by verified listener identity; use its top artist and curated genre-alias mapping to retrieve catalog tracks. | Read | Each demo login/request | <100 ms profile read and <5 s end-to-end target; unmeasured | AI API / listener |
| AP10 (target) | Read/update the authenticated user's profile, saved preferences, and ordered playlists from the serving store. | Read/write | Login, profile edit, playlist save, recommendation request | <100 ms profile lookup target; <1 s profile write target; unmeasured | API / listener |
| AP11 (target) | Publish profile changes, playlist lifecycle, recommendation impressions, and explicit track feedback as versioned user events; consume asynchronously for projections and analytics. | Append/read stream | On each eligible user action; expected rate TBD | Event-to-consumer p95 <5 s target; unmeasured | API producer / Kafka consumers |
| AP12 (target) | Record privacy-minimized model-call metadata for operations and analytics; exclude prompt/response content and account identity. | Append/write and aggregate/read | Every model invocation; expected rate TBD | Collector/export freshness and overhead SLO TBD; unmeasured | API instrumentation / operations / analyst |
| AP13 (target) | Read a short recent-message window and a small set of relevant, unexpired topic memories for the authenticated user; consolidate cold transcripts and expire/delete both layers. | Read/write/delete | Each conversation turn; background aging and cleanup | Retrieval/cleanup SLO TBD; unmeasured | Conversation API / listener |
| AP14 (target) | Check and record purpose-specific consent; process withdrawal/deletion across listener-owned and derived records. | Read/write/delete | Before import or persistence; on listener request | Deletion within 24 hours target; unverified | Listener API / privacy owner |
| AP15 (target) | Validate and review every imported playlist row, then create a queue from reviewed inputs with reasons and hard exclusions. | Read/write | Per import and queue request | 100-track queue <5 s p95 target; at least 95% of test runs; unverified | Import / recommendation API / listener |
| AP16 (target) | Save, list, reopen, rename, and delete a listener-selected queue with its ordered tracks and minimal reason evidence. | Read/write/delete | On explicit save and later queue management | <100 ms saved-queue read target; unmeasured | Listener API / listener |

AP1–AP4 are implemented by DuckDB tool operations in `backend/duckdb_service.py`.
AP5 is implemented in the FastAPI service and PostgreSQL role. AP6–AP7 have scripts
but no scheduler. AP8 exists as SQL and notebook/report work, not a user-facing
analytics warehouse. AP9 is not wired to login or recommendation flow.
AP10–AP16 are target patterns only; no user-profile/conversation schema, consent
ledger, pgvector extension, Kafka producer/consumer, Avro schema registry, event
archive, memory retrieval, queue-reason provenance pipeline, or structured model
telemetry pipeline is implemented.

## 5. Logical design

### Model assignment

| Domain | Current model | Access patterns | Alternatives / rationale |
|---|---|---|---|
| Catalog entities and relationships | Parquet columnar files as canonical data; DuckDB SQL views at query time | AP1–AP4, AP6 | A document store is unnecessary for structured catalog attributes. DuckDB avoids copying files into tables and supports the local analytical filters. |
| Relational backup | PostgreSQL relational tables, PK/FK constraints | AP5, AP7 | Kept as recovery/fallback and to demonstrate relational constraints; not the primary AI query path. |
| Listener prompt / taste / playlist | Browser-session JSON/context, transient API request | AP1, AP2, AP5 | No durable profile store is present. A relational profile/event model requires consent and lifecycle decisions first. |
| Optional recording verification | Parquet title/artist index from separately supplied MusicBrainz PostgreSQL | AP2 | Optional exact-title companion, not the authoritative local catalog and not required for normal queries. |
| Demo listener profile | Proposed profile table/view seeded from `music_streaming_habits_2026.csv` | AP9 | 4,000 unique sample IDs and summary preferences; no track IDs/history or current application integration. |
| Durable profile, reviewed taste summary, preferences, playlists, and explicitly saved queues (target) | PostgreSQL `user_data` schema | AP10, AP11, AP14–AP16 | Transactional serving state; persist the corrected summary only after listener review/approval and a generated queue only after explicit Save; consent ledger gates import and persistence; not implemented. |
| User activity event history (target) | Kafka topics with Avro values; HDFS Avro archive; compacted Parquet for analytics | AP11 | Append-only integration/event contract; not the login-time state store; no producer/consumer/registry/archive implemented. |
| Model invocation telemetry (target) | OpenTelemetry metrics/traces plus Avro Kafka topic, HDFS archive, and compacted Parquet | AP12 | Operational metrics/traces separated from durable analysis; no prompt/response capture or account IDs; pipeline not implemented. |
| Conversation logs and topic memories (target) | PostgreSQL `conversation_data`; pgvector embeddings on topic memories | AP13 | Short-lived transcript plus compact decaying/expiring topic summaries; API-scoped retrieval; no durable chat or memory system implemented. |
| Embeddings / semantic retrieval | None currently | None implemented | Ollama embedding model is configured only. No chunking unit, vector fields, vector dimensions, distance metric, index, or source-link contract exists; do not describe a vector database as deployed. |
| Analytics | Source Parquet/SQL and notebooks; proposed star schema in Section 13 | AP4, AP8 | The repository has no production warehouse or persisted star-schema tables. |

The stable source identity for tracks is the source `track_id`, retained across
Parquet and PostgreSQL. Most artist, genre, and album identifiers are regenerated
integer IDs assigned after deterministic sorting in the transformation script.
Their numeric values are consistent only for the same generated snapshot; a
changed source set can shift them. For safe cross-store identity, refresh all
derived stores from one Parquet build and record a build/version identifier. Do not
merge records from independently generated builds by generated integer ID alone.
Parquet is authoritative; PostgreSQL is rebuilt from it when copies diverge.

For user data, the target authority is different: PostgreSQL `user_data` is
authoritative for current profile, saved preferences, and playlist state; Kafka is
the ordered, replayable event channel for downstream consumers, and HDFS/Parquet
are analytics archives. The profile lookup at login reads PostgreSQL, not Kafka,
HDFS, Avro files, or an event replay. Catalog Parquet remains authoritative for
music entities; profile-to-catalog references retain source `track_id` values and
are checked against the current catalog snapshot by the service.

For the demo-profile extension, `listener_id` is unique in the seed file, but it is
not evidence of an authenticated account or stable ID in a deployed app. Bind a
demo profile to the authenticated principal through an explicit mapping rather
than trusting a browser-supplied integer. All 14 top-artist labels currently have
unique normalized matches. Genre labels do not: several normalized forms map to
multiple `genre_id` rows, and `Afrobeats`, `Lo-fi`, and `R&B` do not directly
identify a track-genre row. Build a curated, versioned `PROFILE GENRE ALIAS`
crosswalk, report unmatched/ambiguous values, and choose whether each preference
maps to direct track genres, artist-tag genres, or both. Artist/genre integer IDs
are regenerated by the transform, so build the crosswalk against the same catalog
build or use stable natural keys/build IDs.

### Logical ERD and relational rules

The current relational schema is the logical baseline (PostgreSQL DDL is in
`load_postgres.py`). Names below intentionally match both the Parquet files and
loader. `PK` means primary key; `FK` means foreign key. Optionality reflects the
DDL unless noted.

```text
genre(genre_id PK)
  1 ── 0..* album(genre_id FK nullable)
  1 ── 0..* tracks(genre_id FK nullable)
  1 ── 0..* artist_genres(genre_id PK/FK)

album(album_id PK, genre_id FK nullable)
  1 ── 0..* tracks(album_id FK nullable in DDL; populated by current transform)
  1 ── 0..1 album_scores(album_id PK/FK)

tracks(track_id PK, album_id FK nullable, genre_id FK nullable)
  1 ── 0..1 track_feel(track_id PK/FK)
  1 ── 0..* track_artists(track_id PK/FK)

artists(artist_id PK)
  1 ── 0..* track_artists(artist_id PK/FK)
  1 ── 0..* artist_genres(artist_id PK/FK)
```

The target user-data ERD extends the catalog without changing its Parquet
authority:

```text
APP_USER 1 ── 0..1 USER_PROFILE
APP_USER 1 ── 0..* CONSENT_EVENT
APP_USER 1 ── 0..* USER_PREFERENCE
APP_USER 1 ── 0..* USER_PLAYLIST 1 ── 0..* USER_PLAYLIST_TRACK
APP_USER 1 ── 0..* SAVED_QUEUE 1 ── 1..* SAVED_QUEUE_TRACK
APP_USER 1 ── 0..* OUTBOX_EVENT ── Kafka user-events topic ── 0..* consumers
APP_USER 1 ── 0..* CONVERSATION 1 ── 0..* CONVERSATION_MESSAGE (short-lived)
APP_USER 1 ── 0..* TOPIC_MEMORY ── 0..* MEMORY_SOURCE (conversation IDs only)
USER_PLAYLIST_TRACK ..0..1 ── catalog TRACK (logical reference by source track_id;
                                       validated in DuckDB, not cross-store FK)
```

Consent decisions are scoped to a purpose and versioned policy; the API gates
playlist import and persistence on the latest applicable consent. The active
generated queue is session/request state; only an explicit listener Save creates
the durable queue and ordered-entry records in PostgreSQL.

### Target PostgreSQL profile schema (proposed, not deployed)

`user_data` is a separate schema in the serving PostgreSQL database. It stores
current user-owned state; it is not the catalog's authoritative music store.
`auth_subject` comes from the authentication provider and is unique. The API maps
the authenticated subject to `user_id`; it never accepts `user_id` from an
untrusted client as authorization.

```sql
CREATE SCHEMA user_data;

CREATE TABLE user_data.app_user (
    user_id UUID PRIMARY KEY,
    auth_subject TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE user_data.user_profile (
    user_id UUID PRIMARY KEY REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    display_name TEXT,
    country_code CHAR(2),
    taste_summary_text TEXT,
    taste_summary_version INTEGER NOT NULL DEFAULT 0 CHECK (taste_summary_version >= 0),
    taste_summary_confirmed_at TIMESTAMPTZ,
    profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_data.consent_event (
    consent_event_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK
        (purpose IN ('playlist_import', 'profile_persistence', 'saved_queue_persistence', 'conversation_history')),
    decision TEXT NOT NULL CHECK (decision IN ('granted', 'withdrawn')),
    policy_version TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consent_event_user_purpose_time_idx
    ON user_data.consent_event(user_id, purpose, recorded_at DESC);

CREATE TABLE user_data.user_preference (
    preference_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    preference_type TEXT NOT NULL CHECK
        (preference_type IN ('artist', 'genre', 'track', 'mood', 'energy', 'explicit')),
    preference_value TEXT NOT NULL,
    catalog_entity_key TEXT,
    catalog_build_id TEXT,
    weight DOUBLE PRECISION CHECK (weight IS NULL OR weight BETWEEN 0 AND 1),
    source TEXT NOT NULL CHECK (source IN ('explicit', 'seed', 'confirmed_inference')),
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source <> 'confirmed_inference' OR confirmed_at IS NOT NULL),
    UNIQUE (user_id, preference_type, preference_value)
);

CREATE TABLE user_data.user_playlist (
    playlist_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    playlist_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'youtube', 'demo_seed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_data.user_playlist_track (
    playlist_id UUID NOT NULL REFERENCES user_data.user_playlist(playlist_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    catalog_track_id TEXT,
    title_snapshot TEXT NOT NULL,
    artist_snapshot TEXT NOT NULL,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    import_status TEXT NOT NULL CHECK
        (import_status IN ('accepted', 'duplicate', 'unsupported', 'incomplete', 'ambiguous')),
    review_reason TEXT,
    reviewed_at TIMESTAMPTZ,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, position)
);

CREATE TABLE user_data.saved_queue (
    queue_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    queue_name TEXT,
    catalog_build_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX saved_queue_owner_created_idx
    ON user_data.saved_queue(user_id, created_at DESC);

CREATE TABLE user_data.saved_queue_track (
    queue_id UUID NOT NULL REFERENCES user_data.saved_queue(queue_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    catalog_track_id TEXT NOT NULL,
    title_snapshot TEXT NOT NULL,
    artist_snapshot TEXT NOT NULL,
    reason_text TEXT NOT NULL,
    evidence_type TEXT NOT NULL CHECK
        (evidence_type IN ('reviewed_playlist', 'confirmed_preference', 'catalog_attribute')),
    evidence_reference TEXT NOT NULL,
    evidence_snapshot TEXT NOT NULL,
    PRIMARY KEY (queue_id, position)
);

CREATE INDEX user_preference_user_type_idx
    ON user_data.user_preference(user_id, preference_type);
CREATE INDEX user_playlist_owner_updated_idx
    ON user_data.user_playlist(user_id, updated_at DESC);

CREATE TABLE user_data.event_outbox (
    event_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_data.app_user(user_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);
CREATE INDEX event_outbox_pending_idx
    ON user_data.event_outbox(created_at) WHERE published_at IS NULL;
```

The outbox stores a pending event representation in the same transaction as the
profile/playlist/queue update. The publisher serializes it with the registered
Avro schema. `catalog_track_id` is a stable external Spotify-style track identifier,
not an FK into the rebuildable catalog snapshot. Unresolved playlist items retain
title/artist snapshots and may have a null `catalog_track_id` until verified.
`consent_event` is append-only decision history; the latest decision for each
purpose governs. The API must check it before importing or persisting. Chat
history remains off by default and is stored only after separate opt-in. Imported
rows retain an explicit status and any review reason; only accepted/reviewed rows
may be used as recommendation evidence. Unconfirmed AI inferences remain in
request/session context; the preference row is created only after explicit
confirmation and records that provenance in `source` and `confirmed_at`.
The durable taste summary is a listener-reviewed value, versioned separately
from profile metadata; a model-generated draft stays in request/session context
until the listener corrects and approves it.
The working queue remains in request/session context until the listener explicitly
saves it and has granted `saved_queue_persistence` consent. A saved queue and its
ordered tracks are then authoritative PostgreSQL records. Each queue item retains
catalog identity/snapshot, a concise explanation, and a typed minimal evidence
reference/snapshot (reviewed playlist row, confirmed preference, or catalog
attribute); do not store an unbounded prompt or full conversation as a queue
reason. Kafka receives a versioned save/delete event for downstream use, never
the queue's authoritative state. Queue deletion cascades to its track/evidence
rows and is included in the listener-deletion workflow.
The proposed `event_outbox.user_id` FK currently cascades on account deletion;
implementation must not hard-delete the owner before its deletion event is
durably published and required consumers have removed their projections. Define
a minimal tombstone/acknowledgment path (and its maximum retention) that can meet
the 24-hour deletion target without retaining superseded preference payloads.
Do not persist age, country, platform, subscription, or other seed demographics
unless a specific demo behavior needs them and the retention/privacy purpose is
approved; the dataset's age field must not be treated as verified account data.

### Target profile dictionary

| Entity | Attribute | Logical type | Nullable? | Key / rule |
|---|---|---|---|---|
| `app_user` | `user_id` | UUID | No | PK; internal opaque subject key |
| `app_user` | `auth_subject` | text | No | Unique auth-provider subject; BR9 |
| `app_user` | `created_at`, `deleted_at` | timestamp | `deleted_at` yes | Lifecycle / deletion marker |
| `consent_event` | `consent_event_id`, `user_id` | UUID | No | PK and owner FK; append-only decision record |
| `consent_event` | `purpose`, `decision`, `policy_version`, `recorded_at` | text, text, text, timestamp | No | Purpose-specific consent history; latest decision governs; BR13 |
| `user_profile` | `user_id` | UUID | No | PK/FK to `app_user` |
| `user_profile` | `display_name`, `country_code`, `taste_summary_text` | text | Yes | Minimized optional context; taste summary is listener-reviewed before durable use |
| `user_profile` | `profile_version` | integer | No | Optimistic concurrency/version; >0 |
| `user_profile` | `taste_summary_version`, `taste_summary_confirmed_at` | integer, timestamp | version non-null; confirmation time nullable | Versioned listener-reviewed summary; version starts at 0 until approved |
| `user_profile` | `created_at`, `updated_at` | timestamp | No | Audit metadata |
| `user_preference` | `preference_id` | UUID | No | PK |
| `user_preference` | `user_id` | UUID | No | FK; owner scope |
| `user_preference` | `preference_type`, `preference_value` | text | No | Controlled type + user-facing value; unique per user/type/value |
| `user_preference` | `catalog_entity_key`, `catalog_build_id` | text | Yes | Optional catalog mapping; validate against stated build; BR10 |
| `user_preference` | `weight` | decimal | Yes | Optional normalized preference strength in [0,1] |
| `user_preference` | `source`, `confirmed_at` | text, timestamp | `confirmed_at` yes | `explicit`, `seed`, or `confirmed_inference`; inferred values require listener confirmation; BR15 |
| `user_playlist` | `playlist_id` | UUID | No | PK |
| `user_playlist` | `user_id` | UUID | No | FK; owner scope |
| `user_playlist` | `playlist_name`, `source` | text | No | Name and import/source class |
| `user_playlist` | `created_at`, `updated_at` | timestamp | No | Lifecycle metadata |
| `user_playlist_track` | `playlist_id`, `position` | UUID, integer | No | Composite PK; preserves order; position >=0 |
| `user_playlist_track` | `catalog_track_id` | text | Yes | External catalog ID; nullable for unresolved item |
| `user_playlist_track` | `title_snapshot`, `artist_snapshot` | text | No | Import-time attribution retained if source/catalog changes |
| `user_playlist_track` | `duration_ms` | integer | Yes | Non-negative if supplied |
| `user_playlist_track` | `import_status`, `review_reason`, `reviewed_at` | text, text, timestamp | Reason/time yes | Every row is accepted or visibly flagged; no silent drops; BR14 |
| `saved_queue` | `queue_id`, `user_id` | UUID | No | PK and owner FK; created only by explicit listener save; BR19 |
| `saved_queue` | `queue_name`, `catalog_build_id` | text | Yes for queue name | Optional display name and catalog snapshot/build provenance |
| `saved_queue` | `created_at`, `updated_at` | timestamp | No | Queue save time and last metadata update |
| `saved_queue_track` | `queue_id`, `position` | UUID, integer | No | Composite PK; ordered child row, cascades with queue |
| `saved_queue_track` | `catalog_track_id`, `title_snapshot`, `artist_snapshot` | text | No | Stable external catalog ID plus display snapshot |
| `saved_queue_track` | `reason_text`, `evidence_type`, `evidence_reference`, `evidence_snapshot` | text | No | Bounded explanation and minimal typed provenance for the recommendation |
| `event_outbox` | `event_id` | UUID | No | PK and downstream idempotency key |
| `event_outbox` | `user_id`, `event_type`, `schema_version`, `payload`, `occurred_at` | UUID, text, integer, structured data, timestamp | No | User event envelope staged transactionally |
| `event_outbox` | `created_at`, `published_at`, `attempt_count` | timestamp, timestamp, integer | Published time yes | Publisher retry and operational state |

### Target conversation and long-term context store (proposed)

If the listener separately opts in, keep user-owned chat history and durable
profile/preferences in PostgreSQL so the API can join them by internal `user_id`,
but isolate them from the reloadable
catalog tables: use separate `user_data` and `conversation_data` schemas (or
separate databases on the serving PostgreSQL instance), separate least-privilege
roles, and a separate migration/lifecycle. The catalog loader must never drop,
truncate, or rebuild either user-data schema. Neither schema is added to the
model-generated PostgreSQL SQL allowlist.

Use ordinary relational columns for ownership, conversation/message ordering,
timestamps, and expiry; store the message body and topic summary as text. `JSONB`
is optional for bounded auxiliary metadata, not required for core message or
memory retrieval. Do not store Avro blobs as the searchable message representation:
Avro remains the Kafka event wire/archive format; PostgreSQL serves user-scoped
current records. Store full transcript messages without per-message vectors by
default; embed only consolidated topic memories with the PostgreSQL `pgvector`
extension. Embedding model, dimensions, and index strategy remain deployment
choices and must be versioned with each embedding.

```text
conversation_data.conversation(
  conversation_id UUID PK, user_id UUID FK, created_at, last_activity_at,
  transcript_expires_at, deleted_at?)

conversation_data.message(
  message_id UUID PK, conversation_id UUID FK, sequence_no,
  role, body_text, created_at, expires_at)

conversation_data.topic_memory(
  memory_id UUID PK, user_id UUID FK, topic_key, summary_text,
  embedding VECTOR(<model dimensions>), embedding_model, embedding_version,
  confidence, importance, created_at, last_retrieved_at?, expires_at,
  status, memory_version)

conversation_data.memory_source(
  memory_id UUID FK, source_conversation_id UUID FK, PRIMARY KEY (...)
  -- minimal provenance; no transcript text; retained only while memory exists
)
```

`VECTOR(<model dimensions>)` is illustrative notation, not literal SQL. Select
the dimension from the chosen embedding model and validate vector/model-version
compatibility. Start with exact similarity search plus a B-tree index for
`(user_id, expires_at)`; evaluate pgvector HNSW or IVFFlat only if measured
volume/latency warrants approximate search. Always filter by authenticated
`user_id` and unexpired status; similarity search must not bypass ownership or
expiry filtering. The `pgvector` extension is not installed/configured in this
project; verify availability and permissions in the selected PostgreSQL
deployment before implementation. A vector is derived personal data and follows
its memory's deletion policy.

Conversation history is off by default in the proposed product. A separate,
recorded opt-in is required before any durable transcript or topic memory is
created; withdrawal stops future persistence and invokes the approved deletion
workflow. The consent purpose and notice text remain product decisions.

#### Conversation aging, retrieval falloff, and deletion

1. Keep recent messages as the short-term conversation window, with a fixed
   maximum retention window. The exact days/limits are **TBD** and require product,
   privacy, and operational approval.
2. As a conversation ages out of the recent window or its context value falls
   below a configured threshold, process it for consolidation. Extract only
   useful, non-sensitive, user-relevant topics/preferences; merge or replace
   related topic memories, preserve minimal source-conversation IDs, and compute
   or refresh the memory embedding. If no durable/useful topic remains, discard
   the candidate instead of retaining it.
3. Persist the resulting memory successfully before deleting the source
   transcript. Commit the memory/source-link changes and transcript purge as one
   database transaction after summarization completes; if summarization fails,
   retry within the transcript's hard expiry, then delete the transcript without
   preserving a failed/unsafe summary.
4. Rank eligible memories using semantic similarity adjusted by recency,
   confidence, and importance (for example, `semantic_similarity ×
   exp(-age_days / decay_period) × confidence_weight`). Decay period and threshold
   may vary by memory type. Update `last_retrieved_at` only when the memory was
   actually included in model context, not merely returned by vector search.
5. Decay affects retrieval likelihood, **not storage lifetime**. Every message and
   memory has an absolute expiry; retrieval/use does not extend that maximum
   lifetime automatically. A scheduled job purges expired messages, summaries,
   vectors, and source-link metadata. Exact retention, decay, and maximum-age
   values remain TBD rather than being implied as approved policy.
6. A user deletion request for a conversation deletes its messages and all topic
   memories derived from it (including embeddings and links), or requires an
   explicit user-approved keep action. Account deletion removes all user-owned
   rows; backups, logs, caches, and any future exports need a documented deletion
   or expiry strategy too.

This design distinguishes the short-lived transcript from the smaller,
longer-lived topic memory; it does not promise that old content disappears merely
because a retrieval score is low. A hard TTL and deletion worker are required.
Kafka is not the transcript store and must not receive raw chat text by default.
Only approved lifecycle/analytics events may be emitted, with distinct retention
and access controls.

### Data dictionary

Logical types abstract from product-specific syntax. Except keys, the current DDL
does not declare non-null constraints or range checks; nullability therefore says
“nullable in current schema” rather than “always missing/populated in this snapshot.”
Business rule IDs are defined below.

| Entity | Attribute | Logical type | Nullable? | Key role | Meaning / rule |
|---|---|---|---|---|---|
| `genre` | `genre_id` | integer | No | PK | Snapshot-generated genre identifier; BR1 |
| `genre` | `genre_name` | text | Yes | — | Display label selected from normalized variants; BR1 |
| `artists` | `artist_id` | integer | No | PK | Snapshot-generated artist identifier; BR1 |
| `artists` | `artist_name` | text | Yes | — | Selected display credit |
| `artists` | `artist_country` | text | Yes | — | MusicBrainz country preferred, Last.fm fallback |
| `artists` | `artist_popularity` | decimal | Yes | — | Last.fm listener count used as popularity proxy |
| `album` | `album_id` | integer | No | PK | Snapshot-generated album identifier; BR1/BR2 |
| `album` | `genre_id` | integer | Yes | FK → `genre.genre_id` | Selected album/track genre; BR3 |
| `album` | `album_name` | text | Yes | — | Album title |
| `album` | `album_format` | text | Yes | — | Source format |
| `album` | `release_date` | text | Yes | — | ISO-like year, year-month, or full date; BR4 |
| `album` | `label` | text | Yes | — | Record label |
| `tracks` | `track_id` | text | No | PK | Source Spotify track ID; BR2 |
| `tracks` | `album_id` | integer | Yes | FK → `album.album_id` | Current transform populates and asserts this reference |
| `tracks` | `genre_id` | integer | Yes | FK → `genre.genre_id` | Chosen genre; may be missing |
| `tracks` | `track_name` | text | Yes | — | Track title |
| `tracks` | `popularity` | integer | Yes | — | Maximum source popularity for duplicate track IDs; BR2 |
| `tracks` | `duration_ms` | integer | Yes | — | Track duration in milliseconds |
| `tracks` | `explicit` | boolean | Yes | — | Source explicit-content flag |
| `album_scores` | `album_id` | integer | No | PK/FK → `album.album_id` | At most one chosen rating row per album; BR5 |
| `album_scores` | `metacritic_critic_score` | decimal | Yes | — | Metacritic critic score |
| `album_scores` | `metacritic_critic_count` | integer | Yes | — | Metacritic critic review count |
| `album_scores` | `metacritic_user_score` | decimal | Yes | — | Metacritic user score |
| `album_scores` | `metacritic_user_count` | integer | Yes | — | Metacritic user review count |
| `album_scores` | `aoty_critic_score` | decimal | Yes | — | Album of the Year critic score |
| `album_scores` | `aoty_critic_count` | integer | Yes | — | Album of the Year critic review count |
| `album_scores` | `aoty_user_score` | decimal | Yes | — | Album of the Year user score |
| `album_scores` | `aoty_user_count` | integer | Yes | — | Album of the Year user review count |
| `track_feel` | `track_id` | text | No | PK/FK → `tracks.track_id` | At most one audio-feature row per track |
| `track_feel` | `danceability` | decimal | Yes | — | Source audio feature |
| `track_feel` | `energy` | decimal | Yes | — | Source audio feature |
| `track_feel` | `key` | integer | Yes | — | Source musical key |
| `track_feel` | `loudness` | decimal | Yes | — | Source loudness |
| `track_feel` | `mode` | integer | Yes | — | Source musical mode |
| `track_feel` | `speechiness` | decimal | Yes | — | Source audio feature |
| `track_feel` | `acousticness` | decimal | Yes | — | Source audio feature |
| `track_feel` | `instrumentalness` | decimal | Yes | — | Source audio feature |
| `track_feel` | `liveness` | decimal | Yes | — | Source audio feature |
| `track_feel` | `valence` | decimal | Yes | — | Source audio feature |
| `track_feel` | `tempo` | decimal | Yes | — | Source tempo |
| `track_feel` | `time_signature` | integer | Yes | — | Source time signature |
| `track_artists` | `track_id` | text | No | PK/FK → `tracks.track_id` | One credited track side of bridge |
| `track_artists` | `artist_id` | integer | No | PK/FK → `artists.artist_id` | One credited artist side of bridge |
| `artist_genres` | `artist_id` | integer | No | PK/FK → `artists.artist_id` | One artist/tag assignment |
| `artist_genres` | `genre_id` | integer | No | PK/FK → `genre.genre_id` | One artist/tag assignment |

### Business rules

| ID | Rule | Current enforcement |
|---|---|---|
| BR1 | Normalize names for matching with trimmed, case-folded, whitespace-collapsed keys; choose a deterministic display value; assign sequential IDs by sorted normalized keys. | Transformation code. Numeric IDs are not stable across changed snapshots. |
| BR2 | One `tracks` row per Spotify `track_id`; for duplicates retain the highest-popularity source row and choose the most frequent genre (alphabetical tie-break). Preserve distinct artist credits in the bridge. | Transformation deduplication and uniqueness assertion; PKs in PostgreSQL. |
| BR3 | Album genre comes from rating data where present; otherwise use the most frequent linked track genre. Track genre is selected from its duplicate rows by frequency. | Transformation code. |
| BR4 | Release precision may be year-only, year-month, or full date; invalid day falls back to year-month and missing month to year. | Transformation code; `release_date` is text rather than a strict date to preserve partial precision. |
| BR5 | Match rating albums to catalog albums using normalized title and credited artist; retain unmatched albums independently; choose the most complete rating record if duplicates exist. | Transformation code; album score PK prevents duplicate score rows. |
| BR6 | Bridge rows and one-to-one extension rows must reference existing parent entities. | PostgreSQL FKs; transformation asserts several relationships before export. Parquet alone cannot enforce FKs. |
| BR7 | Model-facing PostgreSQL reads are one `SELECT`, allowlisted, capped at 100 rows, with an 8-second timeout. | API SQL parser/allowlist, `music_reader` role, and transaction settings. |
| BR8 | DuckDB tool inputs are typed/bounded and results capped at 100; verification accepts at most 50 candidates. | FastAPI/Pydantic and DuckDB service validation. |
| BR9 (target) | The authenticated principal owns the profile; clients and models cannot select another user's records by supplying a user ID. | API authorization on every operation; unique `auth_subject`; owner-scoped repository methods and DB role. |
| BR10 (target) | Catalog preference mappings state the catalog build and resolve only through a validated crosswalk; unresolved playlist tracks retain title/artist instead of invented IDs. | API/DuckDB validation and `catalog_build_id`; no cross-store FK to rebuildable catalog files. |
| BR11 (target) | Profile mutations and their event-outbox rows commit atomically; downstream delivery is at-least-once and consumers must be idempotent by `event_id`. | PostgreSQL transaction + outbox publisher; consumer inbox unique constraint/transaction and Kafka offset commit after success. |
| BR12 (target) | User events omit raw conversation text and unnecessary sensitive attributes; event retention and deletion follow approved policy. | Event schema allowlist, producer validation, retention controls and deletion workflow. |
| BR13 (target) | Playlist import and personal-data persistence (including saved queues) require current, recorded consent for the relevant purpose; conversation-history persistence is off by default and separately opt-in. | Consent ledger, API gate before import/write, withdrawal handling, and consent tests; not implemented. |
| BR14 (target) | Every imported playlist row has a visible outcome; duplicates, unsupported/incomplete rows, and ambiguous matches are reported, never silently discarded or treated as verified. | Import status/reason fields, review UI, source-row lineage, and completeness tests; not implemented. |
| BR15 (target) | AI-inferred preferences are not durable recommendation inputs until explicitly confirmed by the listener. | Keep suggestions request-scoped until confirmation; persist confirmation provenance and time; not implemented. |
| BR16 (target) | Every returned recommendation satisfies hard exclusions and has evidence from a reviewed playlist row, confirmed preference, or explicit catalog attribute. | Recommendation validation and reason provenance; test exclusions and supporting signals; not implemented. |
| BR17 (target) | A listener deletion request removes saved profile, playlist, queue, conversation, and derived personal data within 24 hours in the demo environment. | Owner-scoped deletion workflow and end-to-end verification across memories, embeddings, caches, event projections, and backup expiry; preserve a minimal deletion tombstone until required consumers acknowledge it; target only. |
| BR18 (target) | A generated taste summary is editable; persist it as profile context only after listener review/approval and retain its version. | Store approved text, version, and approval time; keep drafts request-scoped; not implemented. |
| BR19 (target) | Keep a generated queue transient until the listener explicitly saves it; saved queues and their ordered entries/reason provenance are owner-scoped and deletable. | PostgreSQL parent/child tables, explicit-save API action, queue lifecycle event, and owner/deletion tests; not implemented. |

### Target Kafka / Avro user-event contract

Use one logical `user-events` topic initially, partitioned by opaque `user_id` so
events for one user are ordered within that topic/partition. The current Compose
Kafka service is a development broker only (single broker, replication factor 1,
PLAINTEXT); a deployed environment needs authenticated/encrypted transport,
multiple brokers, replicated topic configuration, quotas, monitoring, and a schema
registry. The profile API writes authoritative state to PostgreSQL; its
transactional outbox publisher sends events asynchronously. Kafka is not the
profile database and is not read on the login path.

Avro uses a JSON-defined schema but encodes records as compact binary. Register
each schema version under a registry subject; require backward-compatible schema
evolution (new nullable fields with defaults, never silently rename/remove/reuse
fields). Add event types through an explicit versioned contract. Kafka message key
is `user_id`; common envelope is `event_id`, `user_id`, optional `session_id`,
`occurred_at`, `event_type`, `schema_version`, and a typed payload. Example
Avro envelope (initial contract). The union branches are schema-registry
references to the separately registered named payload schemas shown below, not a
standalone `.avsc` file; a standalone bundle must inline those record definitions
before the envelope:

```json
{
  "type": "record",
  "name": "UserEvent",
  "namespace": "music.recommender.events.v1",
  "fields": [
    {"name": "event_id", "type": "string"},
    {"name": "user_id", "type": "string"},
    {"name": "session_id", "type": ["null", "string"], "default": null},
    {"name": "occurred_at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
    {"name": "event_type", "type": "string"},
    {"name": "schema_version", "type": "int"},
    {
      "name": "payload",
      "type": [
        "music.recommender.events.v1.PreferenceChanged",
        "music.recommender.events.v1.PlaylistSaved",
        "music.recommender.events.v1.PlaylistTrackChanged",
        "music.recommender.events.v1.ConsentChanged",
        "music.recommender.events.v1.SavedQueueChanged",
        "music.recommender.events.v1.ListenerDeletionRequested",
        "music.recommender.events.v1.RecommendationImpression",
        "music.recommender.events.v1.TrackFeedback"
      ]
    }
  ]
}
```

Register the following named payload record schemas and reference them from the
envelope subject:

```json
[
  {"type":"record","name":"PreferenceChanged","namespace":"music.recommender.events.v1","fields":[
    {"name":"preference_type","type":"string"},
    {"name":"preference_value","type":"string"},
    {"name":"weight","type":["null","double"],"default":null},
    {"name":"source","type":"string"},
    {"name":"profile_version","type":"int"}
  ]},
  {"type":"record","name":"PlaylistSaved","namespace":"music.recommender.events.v1","fields":[
    {"name":"playlist_id","type":"string"},
    {"name":"playlist_name","type":"string"},
    {"name":"source","type":"string"},
    {"name":"track_count","type":"int"}
  ]},
  {"type":"record","name":"PlaylistTrackChanged","namespace":"music.recommender.events.v1","fields":[
    {"name":"playlist_id","type":"string"},
    {"name":"operation","type":{"type":"enum","name":"PlaylistTrackOperation","symbols":["added","removed"]}},
    {"name":"position","type":"int"},
    {"name":"catalog_track_id","type":["null","string"],"default":null},
    {"name":"title_snapshot","type":"string"},
    {"name":"artist_snapshot","type":"string"}
  ]},
  {"type":"record","name":"ConsentChanged","namespace":"music.recommender.events.v1","fields":[
    {"name":"purpose","type":"string"},
    {"name":"decision","type":{"type":"enum","name":"ConsentDecision","symbols":["granted","withdrawn"]}},
    {"name":"policy_version","type":"string"}
  ]},
  {"type":"record","name":"SavedQueueChanged","namespace":"music.recommender.events.v1","fields":[
    {"name":"queue_id","type":"string"},
    {"name":"operation","type":{"type":"enum","name":"SavedQueueOperation","symbols":["saved","deleted"]}},
    {"name":"catalog_build_id","type":["null","string"],"default":null},
    {"name":"track_count","type":"int"}
  ]},
  {"type":"record","name":"ListenerDeletionRequested","namespace":"music.recommender.events.v1","fields":[
    {"name":"deletion_request_id","type":"string"},
    {"name":"scope","type":{"type":"enum","name":"DeletionScope","symbols":["account","conversation"]}}
  ]},
  {"type":"record","name":"RecommendationImpression","namespace":"music.recommender.events.v1","fields":[
    {"name":"recommendation_id","type":"string"},
    {"name":"catalog_track_id","type":"string"},
    {"name":"position","type":"int"}
  ]},
  {"type":"record","name":"TrackFeedback","namespace":"music.recommender.events.v1","fields":[
    {"name":"catalog_track_id","type":["null","string"],"default":null},
    {"name":"title_snapshot","type":["null","string"],"default":null},
    {"name":"artist_snapshot","type":["null","string"],"default":null},
    {"name":"action","type":{"type":"enum","name":"TrackFeedbackAction","symbols":["liked","disliked","skipped"]}}
  ]}
]
```

These records intentionally exclude raw chat text, full prompts, auth tokens,
email, and age. A `PreferenceChanged` event represents a profile mutation; a
`RecommendationImpression` is emitted only if impression analytics are enabled
and consent/notice has been addressed. A "skip" signal should be recorded only
from an explicit product interaction, not inferred from missing playback data.
For playlist tracks, retain the event's source title/artist snapshots and nullable
catalog ID so later matching is auditable. `SavedQueueChanged` carries only queue
metadata; PostgreSQL remains the source of saved queue contents. Saving is an
explicit listener action and requires recorded queue-persistence consent.
`ListenerDeletionRequested` is a delivery signal, not the deletion itself: keep
the minimal tombstone until required consumers acknowledge purge, then expire it
under the approved policy.

## 6. Physical design and proof of concept

### Platform selection

| Logical model / role | Platform | Reason | Alternatives considered |
|---|---|---|---|
| Canonical catalog | Zstandard Parquet files | Portable, compact columnar snapshot shared by local analytical consumers; reproducible output. | CSV is the source format but larger and weakly typed; a warehouse is not justified by the current static scale. |
| Primary query engine | DuckDB (in-memory connection with Parquet-backed views) | Direct scans/projection/filter/aggregation over local files; minimal load/copy step. | PostgreSQL can answer relational queries but is retained as secondary. |
| Backup / fallback | PostgreSQL 15 | Relational constraints, SQL fallback, and separately loaded copy for recovery/experiments. | Not a second source of truth; manual synchronization is accepted for this local project. |
| Persistent profile, playlist, and saved-queue serving (target) | PostgreSQL `user_data` schema | Transactional current state, owner-scoped ordered playlists/queues, saved reason evidence, and indexed lookup by authenticated subject; queue is persisted only after explicit Save and consent. Separate catalog backup tables remain rebuildable. | DuckDB is suitable for the static read-only seed, not concurrent mutable account state. |
| Conversation history and AI topic memory (target) | PostgreSQL `conversation_data` schema; `pgvector` extension for topic-memory embeddings | User-scoped recent-message fetch, relational expiry/deletion, and semantic lookup of compact topic memories alongside profile data. Separate from reloadable catalog tables. | No transcript store or vector extension is deployed. Use separate roles and migrations; do not let the catalog loader touch user/conversation schemas. |
| User activity/change stream (target) | Kafka topic(s) with Avro values and a schema registry | Ordered per-user event delivery to asynchronous consumers; Avro provides compact typed records and schema evolution. | Not a login-time store or a substitute for PostgreSQL. Kafka/Avro is a proposed extension, not wired today. |
| Event archive / analytics (target) | Avro container files in HDFS; periodic compaction to Parquet | Retain typed raw events for bounded replay/audit, then use columnar Parquet for DuckDB analytics. DuckDB may read Avro files via its extension, but repeated analytics should query compacted Parquet. | No current consumer, archive, or event-derived warehouse. |
| Model serving (demo) | Cloudflare Worker / Workers AI; Ollama configured for embeddings only | Hosted generation is currently wired; embedding model is local but not used by retrieval. | Cloud model calls require network access and introduce provider availability, latency, quota/cost, terms/data-retention, data-residency, model-version drift, and vendor-dependency considerations. Only selected prompt/context and catalog rows should be sent. |
| Fully local model serving (option) | API + local model runtime (e.g. Ollama) | Can keep prompts and catalog context on the local server and use local DuckDB/Parquet plus PostgreSQL fallback. | Future deployment option, not wired. Requires local generation model configuration, adequate hardware, operational monitoring/model updates, and validation that the model supports needed structured outputs/tool selection. |
| Model telemetry (target) | OpenTelemetry Collector/metrics-trace backend; separate Kafka Avro topic → HDFS → Parquet | Operational health stays low-latency; compacted invocation summaries support DuckDB analysis without mixing telemetry with user profile state. | No instrumentation, Collector, backend, topic, or retention policy is implemented. |
| Conversation vector index (target) | PostgreSQL `pgvector` on topic memories only | One database supports owner-scoped filters and memory retrieval; begin with exact search and add ANN index only after benchmarking. | No message-level embeddings by default; vector dimensions/model and retention remain to be selected. A separate vector DB is not justified until measured scale requires it. |
| Analytics | Current Parquet + DuckDB/SQL; future star schema is proposed | Current data volumes fit local files and analytical SQL. | No lakehouse/warehouse is currently deployed. |

### DDL, loaded data, and tuning evidence

The relational DDL, primary/foreign keys, Parquet schema validation, and batched
load implementation are in [`load_postgres.py`](../../load_postgres.py). It loads
eight tables from the canonical files in batches up to 10,000 rows. The existing
Parquet snapshot itself is the proof-of-concept dataset; its measured table counts
and compressed sizes are in Section 4. The loader drops/recreates the backup
tables on a confirmed run, so it is not an incremental production migration.

The repository has an index-disabled baseline at
[`sql/baseline.sql`](../../sql/baseline.sql), indexed queries at
[`sql/indexed.sql`](../../sql/indexed.sql), and the combined
[`sql/benchmark.sql`](../../sql/benchmark.sql) script. The eight index/query
families cover AP1 (track within album), AP3 (album title/date), AP1 (genre and
popularity), AP3 (genre/year/rating), AP4 (genre aggregate), artist/score
aggregation, artist/country lookup, and release-date range. Tested indexes include
`tracks(album_id, track_name)`, `album(album_name, release_date)`,
`tracks(genre_id, popularity)`, `album_scores(metacritic_critic_score)`,
`album(genre_id, release_date)`, `artists(artist_name, artist_country)`, and
`album(release_date)`.

The indexing-strategy report recommends **six** PostgreSQL B-tree indexes for
Q1–Q4, Q7, and Q8, and explicitly recommends no new index for full-scan Q5/Q6.
The indexed benchmark script also creates a seventh index on
`album_scores(metacritic_critic_score)`; this extra index is not among the six
recommended in the strategy report and should be treated as a separate experiment,
not a settled choice. The report's rationale is equality columns before range
columns, useful leading columns, and avoiding indexes for full-table aggregates.
It calls out the write/storage cost, especially updates to indexed track
popularity. See [`Indexing_Strategy.pdf`](../Indexing_Strategy.pdf) and its
editable [`Indexing_Strategy.docx`](../Indexing_Strategy.docx).

The query-performance assessment PDF is present but currently parses as a
zero-page/truncated PDF, so it does not provide readable before/after measurements.
The SQL scripts use `EXPLAIN ANALYZE` and `psql` timing, but no numeric timing
results are asserted here. These indexes are PostgreSQL experiments and are
**not** indexes on the Parquet-backed DuckDB views. For the primary DuckDB path,
no secondary index is currently configured. Query planning/performance should be
re-measured there as the catalog or access patterns grow.

The current POC demonstrates the Parquet snapshot and working DuckDB tools, but a
reproducible benchmark report should still record machine/runtime versions,
dataset version, warm/cold cache behavior, repetitions, median/p95, plans, and
whether the actual request uses DuckDB or PostgreSQL.

### Demo profile-to-catalog link (proposed)

The streaming-habits file is an easy seed for profile-oriented demo interactions,
but its `top_artist` and `top_genre` text values are not foreign keys and it has no
track ID. A relational connection is still possible. All 14 artist labels have
unique normalized matches in the current catalog; the genre labels need a curated
crosswalk because catalog genre names are noisy and non-unique after normalization.
Store the crosswalk as `profile_genre_alias(source_label, genre_id, mapping_version)`
and allow a profile label to map to zero, one, or several relevant genre IDs. Then
join a top artist through `track_artists` to `tracks`, and/or join mapped genres to
`tracks.genre_id` and `artist_genres`/`track_artists`. Deduplicate track results
when both preference paths match. These joins can run in DuckDB across a loaded
CSV/Parquet profile relation and the existing Parquet-backed catalog views; data
does not have to be in one physical file or database. The existing DuckDB service
would need a profile relation and a user-scoped lookup tool/API route before the
AI can use it.

For example, DuckDB can join a CSV profile relation directly to Parquet catalog
files; no copy of the music catalog into PostgreSQL is needed:

```sql
WITH profile AS (
    SELECT listener_id, top_artist,
           regexp_replace(lower(top_artist), '[^a-z0-9]', '', 'g') AS artist_key
    FROM read_csv_auto('csv/music_streaming_habits_2026.csv')
),
artist_lookup AS (
    SELECT artist_id, artist_name,
           regexp_replace(lower(artist_name), '[^a-z0-9]', '', 'g') AS artist_key
    FROM read_parquet('transformed/artists.parquet')
)
SELECT p.listener_id, t.track_id, t.track_name, a.artist_name
FROM profile p
JOIN artist_lookup a USING (artist_key)
JOIN read_parquet('transformed/track_artists.parquet') ta USING (artist_id)
JOIN read_parquet('transformed/tracks.parquet') t USING (track_id)
WHERE p.listener_id = ?  -- bind only the profile selected by the trusted demo identity
ORDER BY t.popularity DESC NULLS LAST
LIMIT 20;
```

This illustrates the artist path only. For genre retrieval, first join the profile
label to the curated `profile_genre_alias` table; exact punctuation-stripped
matching is not reliable for this catalog's genre variants.

For a **read-only seeded demo**, the simplest option is a DuckDB view over a
profile CSV/Parquet fixture plus the normalized crosswalk. If users can edit/save
their profile, use PostgreSQL serving tables keyed to an authenticated identity
(separate schema/table boundary from the catalog's `music_reader` allowlist) and
let the API fetch only the current user's approved fields. Never let a user-provided
`listener_id` alone authorize access. Do not route profile tables through the
model-generated generic SQL fallback.

The file's `daily_listening_minutes`, `songs_per_day`, `playlists_count`, and
`skip_rate_pct` are aggregate attributes; there are no individual listens, skips,
playlist contents, or preference-change events. Do not model this seed as Kafka
events or infer track-level preferences from those aggregates. If the demo later
captures live actions, a possible extension is typed events in Kafka (Avro
serialization), a consumer updating a profile/session serving store, and an
archive compacted to Parquet for analysis. That stream is optional and future;
Avro itself is not the login-time profile database. Four thousand static profile
rows do not need a separate index in DuckDB for this demo; if persisted in
PostgreSQL, a primary key on the authenticated profile key provides the login
lookup index.

### Consistency and availability choices

The local design is single-node and does not claim high availability. The Parquet
files are authoritative, mounted read-only to the DuckDB service; PostgreSQL is a
separate copy loaded on demand. No cross-store transaction or automatic freshness
mechanism keeps both copies synchronized. A failed or partial rebuild must not be
published as a current snapshot: future productionization should stage an entire
new version, validate it, then atomically switch DuckDB and reload PostgreSQL.
This eventual/manual consistency is acceptable for the present static development
catalog, but not for a freshness-sensitive live service.

## 7. Integration and data pipelines

### Pipeline architecture

```text
Kaggle CSV sources
       │ manual download (Kaggle API)
       ▼
transform_erd.py — pandas cleanup, matching, dedupe, type normalization, assertions
       │ writes eight Zstandard Parquet files
       ▼
transformed/ Parquet ───────────────────────► DuckDB read_parquet views (PRIMARY)
       │                                                  │
       │ optional manual data-loader                      │ bounded tools
       ▼                                                  ▼
PostgreSQL relational backup/fallback ◄────────────── FastAPI AI service
                                                          │
                                      prompt + selected catalog rows
                                                          ▼
                                              Cloudflare Worker / model

Optional, separate path:
MusicBrainz PostgreSQL (user-supplied) → export_musicbrainz_parquet.py
                                      → recordings.parquet → DuckDB verifier

Target user-data path (not implemented):
Active generated queue → browser/request session memory
  └─ explicit Save + saved_queue_persistence consent
       → PostgreSQL saved_queue + saved_queue_track + transactional outbox
            → Avro publisher → Kafka SavedQueueChanged metadata event

Authenticated API → PostgreSQL user_data transaction + outbox
                  → outbox publisher (Avro + schema registry)
                  → Kafka user-events topic (key=user_id)
                  → idempotent consumers → derived profile/features/analytics
                  → HDFS Avro archive → scheduled compaction → Parquet → DuckDB
Login / recommendation API ──read current profile──> PostgreSQL user_data

Target conversational-context path (not implemented):
Authenticated conversation API ──read/write──> PostgreSQL conversation_data
  ├─ recent messages (fixed short retention; no per-message vectors by default)
  └─ aged/cold transcript → summarize useful topics → pgvector topic memory
       ├─ API retrieval: user scope + unexpired + semantic/recency/importance rank
       └─ successful consolidation → delete source messages and message embeddings
Scheduled expiry/deletion ──purge──> messages, topic memories, vectors, provenance

Target model-telemetry path (not implemented):
API model-call instrumentation → OpenTelemetry Collector
                               ├→ operational metrics / trace backend
                               └→ sanitized Avro model-telemetry topic
                                  → HDFS Avro archive → Parquet → DuckDB
```

The **catalog** pipeline shown above is batch ETL, not streaming. The **user-data
path below is the proposed streaming extension**. Kafka/Avro is mentioned in
README as a possible future path for listener feedback; no schema registry,
producer/consumer, or feedback table is implemented. The separate conversation
path is a proposed user-serving retrieval flow, not a Kafka transcript stream.
HDFS/Spark jobs and the legacy HDFS export are optional infrastructure and do not
currently feed catalog queries. There is no vector embedding pipeline today:
Ollama model initialization is present, but catalog records are not chunked or
embedded and no conversation memories are stored.

### Target user-profile and event pipeline (proposed)

1. **Login/read:** authentication yields a trusted `auth_subject`; the API resolves
   it to `user_id` and loads only that user's profile/preferences/playlists from
   PostgreSQL. Saved queues are fetched only when requested. Current profile
   state is read synchronously from PostgreSQL; no Kafka replay is needed at login.
2. **Queue generation/save:** build the working queue in request/session memory
   from the reviewed imported playlist, stated/confirmed profile, and catalog
   candidates. Do not assume live playback-event data. On explicit Save, check
   `saved_queue_persistence` consent, resolve catalog IDs, preserve ordering and
   minimal per-track reason evidence, then write `saved_queue`, its track rows,
   and a `SavedQueueChanged` outbox event atomically.
3. **Mutation:** profile, preference, playlist, consent, or saved-queue changes
   and an `event_outbox` row are written in one PostgreSQL transaction. A polling publisher serializes
   pending outbox records using the registered Avro writer schema, publishes with
   Kafka key `user_id`, then marks the row published after broker acknowledgement.
   A crash between publish and marking may duplicate delivery; `event_id` is the
   idempotency key.
4. **Consumption:** consumer validates the schema, deduplicates through an inbox
   or per-sink unique `event_id`, applies only approved derived projections, and
   commits its Kafka offset after the sink transaction succeeds. Retry transient
   failures with backoff; send poison/schema-invalid messages to a restricted DLQ
   with alerting and a replay procedure. Do not let an analytics consumer silently
   overwrite authoritative explicit profile choices.
5. **Archive/analytics:** a Kafka Connect HDFS sink or equivalent writes Avro
   container files by event date/topic. Periodically compact small files and
   transform validated events to partitioned Parquet for DuckDB queries. Raw Avro
   is an interchange/archive format; Parquet is the analytical read format.
6. **Recovery/deletion:** profile changes replay from PostgreSQL state or the
   outbox/event archive to rebuild derived projections, not to reconstruct identity
   authorization. A user deletion request must remove profile/playlist/saved-queue
   rows, suppress or redact queued events, preserve only the minimal deletion
   tombstone until required consumer acknowledgements, and propagate deletion/anonymization to
   derived stores and archives according to the approved retention policy.

Initial operational assumptions to verify before deployment: one topic keyed by
`user_id`, per-user ordering only (no global ordering), 7-day Kafka retention for
short replay, event-to-consumer p95 under 5 seconds, outbox publisher polling at
least once per second, and a 12-month maximum raw archive before deletion or
anonymization. These are target values, not measured capabilities or approved
legal policy. Partition count and broker replication should follow measured event
volume and availability requirements; the local single-broker Compose values are
not production settings. For multiple independent event consumers, use separate
consumer groups; do not use one shared group if every consumer must receive every
event.

### Conversation history and topic-memory pipeline (proposed)

The conversation API authenticates the user, resolves the internal `user_id`,
and reads a bounded recent-message window plus a small number of that user's
unexpired, relevant topic memories from PostgreSQL. The API—not the model—does
the owner/expiry filtering and chooses what context to send. PostgreSQL is the
serving store because the conversation rows, profile, and preferences can share
the same user identity and transaction/security boundary; this `conversation_data`
schema is outside the catalog loader and model-generated SQL allowlist.

Store recent messages as ordered relational rows with text bodies and explicit
expiry. Do not vectorize every message by default. An aging worker detects
transcripts that leave the short-term window or fall below a configured context
utility threshold. It extracts only durable, useful topic-level information,
merges related memories, and embeds the compact summary using a versioned
embedding model. Only after the summary and its embedding are persisted
successfully does the worker delete source messages and any message-level
derivatives; on failure, retry until the transcript's fixed hard expiry, then
purge without a derived memory. This is a two-layer policy: full logs expire
sooner; topic memories may remain longer but have their own absolute maximum
lifetime.

For each request, retrieve by vector similarity inside the authenticated user's
unexpired memory set, then adjust ranking by recency decay, confidence, and
importance. Update a memory's last-retrieved timestamp only when it is actually
included in the model prompt. Gradual decay reduces retrieval likelihood; it
does not replace deletion. Never extend a memory's absolute expiry merely
because it was retrieved. TTLs, decay periods, thresholds, result limits, and
embedding dimensions are unset design parameters and must be approved and tested.

Keep minimal source-conversation IDs for each memory while that memory exists so
an explicit conversation deletion can also remove derived summaries/vectors.
Default deletion behavior is to delete dependent memories too; any keep action
must be explicit and user-controlled. Account deletion removes all profile,
conversation, memory, embedding, source-link, and associated outbox rows, and
must account for backups/caches. Do not publish raw messages, topic summaries, or
embeddings to Kafka or HDFS by default; a separate, explicitly governed need
would be required. JSONB is optional for auxiliary metadata, not the message
storage format. Avro remains for approved Kafka event contracts.

### Model telemetry pipeline (proposed)

Instrument every outbound model invocation at the API boundary: generate a
request-level trace ID and per-call invocation ID; record task/purpose, configured
provider and model, start time and observed duration, outcome/status, retry count,
and provider-reported token/usage values when available. Record whether the call
used catalog tools and bounded result counts, but not returned catalog rows. The
Worker boundary measures end-to-end latency only; do not imply visibility into
provider-side queueing or compute unless the provider explicitly reports it.

Use OpenTelemetry instrumentation and a Collector to separate low-latency
operational signals (request/model-call counters, latency histograms, error rates,
and sampled traces) from the durable analytics stream. Keep metric labels bounded
to provider, model, task, outcome, and deployment version; never use request IDs,
user IDs, prompts, or other high-cardinality values as labels. Publish a
privacy-minimized Avro `model-telemetry` event to a separate Kafka topic for
retained analysis, using the schema registry but distinct ACLs, retention, and
consumer groups from `user-events`. A failure to emit telemetry must not turn a
successful recommendation into an application failure; alert on collector/export
errors and monitor telemetry delivery separately.

The event contract may include invocation/trace IDs, timestamp, provider/model,
task, duration, outcome/error class, retry count, nullable prompt/completion token
counts, and approved catalog-tool name/result-row count. It must exclude raw
prompts and responses, auth headers/tokens, full catalog results, email, and
user/account identifiers. If user-level diagnosis is later justified, introduce
an explicit consented pseudonymous correlation scheme with a short retention and
documented re-identification boundary; do not add `user_id` by default. Archive
Avro to a restricted HDFS location and compact validated records to
date-partitioned Parquet for DuckDB analysis. Define trace sampling, access,
retention, deletion, and incident procedures before deployment; no retention
period or legal basis is established yet.

### Source-to-target mapping

| Source field(s) | Transformation | Target |
|---|---|---|
| `dataset.csv`: `track_id`, `track_name`, `popularity`, `duration_ms`, `explicit` | Deduplicate by `track_id`, retain max-popularity row | `tracks.track_id`, `track_name`, `popularity`, `duration_ms`, `explicit` |
| `dataset.csv`: `album_name`, lead/all `artists` credits | Normalize title/credit keys; combine album candidates and match rating title+credited artist | `album.album_name`; `track_artists` links; generated `album_id` |
| `dataset.csv`: `track_genre` | Normalize, choose modal label per track; map selected display genre | `genre.genre_name`, `tracks.genre_id`; fallback album genre where no rating genre |
| `dataset.csv`: `danceability`, `energy`, `key`, `loudness`, `mode`, `speechiness`, `acousticness`, `instrumentalness`, `liveness`, `valence`, `tempo`, `time_signature` | Keep selected highest-popularity unique track row | `track_feel` matching columns |
| `album_ratings.csv`: `Title`, `Artist`, release month/day/year, `Format`, `Label`, `Genre` | Normalize; match album by title+credited artist; retain unmatched; select most complete duplicate; preserve partial date precision | `album.album_name`, `release_date`, `album_format`, `label`, `genre_id` |
| `album_ratings.csv`: critic/user scores and review counts from Metacritic/AOTY | Rename and map to one album score record | `album_scores.*` |
| `artists.csv`: MusicBrainz/Last.fm artist aliases and country fields | Match normalized aliases; choose highest listener-count/source-order match; prefer MusicBrainz country else Last.fm | `artists.artist_name`, `artist_country`, `artist_popularity` |
| `artists.csv`: `tags_mb`, `tags_lastfm` | Split semicolon tags, normalize, map to genre IDs, deduplicate pairs | `genre`, `artist_genres` |
| Canonical Parquet columns | Validate exact column order/types, stream in bounded CSV batches | Corresponding PostgreSQL table columns |
| `music_streaming_habits_2026.csv` | No mapping in current transform | No current target; excluded from system behavior |
| Demo `listener_id` | Map only through an explicit demo-account-to-seed mapping; do not treat the numeric ID as authentication | `app_user.auth_subject` mapping is provisioned by trusted demo setup; seed profile ID retained only as provenance |
| Listener-corrected taste summary | Keep AI draft request-scoped; persist only after listener review/approval and with a version | `user_profile.taste_summary_text`, `taste_summary_version`, `taste_summary_confirmed_at` |
| Active recommendation queue | Keep transient in request/session memory until explicit Save; verify consent and retain catalog build identity | `saved_queue` + ordered `saved_queue_track` rows in PostgreSQL; bounded reason/evidence snapshot per item |
| Queue save/delete action | Commit queue state and a minimal event envelope in one PostgreSQL transaction; Avro-serialize asynchronously | PostgreSQL `event_outbox` → Kafka `SavedQueueChanged`; Kafka is not the queue serving store |
| Seed `top_artist` | Normalize and resolve against current artist snapshot; fail/quarantine ambiguous/unmatched values | `user_preference(preference_type='artist', preference_value, catalog_entity_key, catalog_build_id, source='seed')` |
| Seed `top_genre` | Curated versioned alias map; one-to-many explicit genre choices; record mapping version | `user_preference(preference_type='genre', ...)`; catalog keys tied to current build |
| Seed aggregate attributes | Import only fields required by the demo use case; do not presume demographics are true account facts | Selected `user_profile` / preference fields only; source=`seed`; otherwise omit |
| Profile/preference/playlist mutation | Write current state and outbox record in one transaction; Avro-serialize using registry writer schema | PostgreSQL `user_data` state + `event_outbox` → Kafka `user-events` |
| Kafka `user-events` Avro record | Validate schema/version; partition by `user_id`; dedupe by `event_id` in consumer; redact/delete per retention policy | Consumer projections, date-partitioned Avro HDFS archive; compact/transform to Parquet |
| Model invocation instrumentation (target) | Capture approved request metadata, timing, outcome, retries, and provider usage; exclude content and identity | OpenTelemetry metrics/traces + separate Avro `model-telemetry` Kafka topic → HDFS/Parquet; retention/access policy TBD |
| Conversation message (target) | Store ordered user/assistant text in an owner-scoped row with fixed expiry; no message embedding by default | PostgreSQL `conversation_data.message`; recent context fetched by conversation API; not written to Kafka/HDFS |
| Aged conversation (target) | When cold/low-utility, extract safe topic summary, merge with same-user topic if appropriate, embed/version, then purge transcript only after successful persistence | `conversation_data.topic_memory` + pgvector embedding + minimal source IDs; absolute memory expiry and deletion worker |
| Conversation deletion/expiry (target) | Cascade from authenticated owner and source conversation to message rows, dependent memory summaries, embeddings, and provenance; expire backups/caches by policy | PostgreSQL deletion worker plus documented backup/cache expiry; raw transcript and memory are not archived to Kafka/HDFS |

### Freshness and failure handling

| Target | Requirement | Current/design freshness | Failure behavior / gap |
|---|---|---|---|
| Canonical Parquet | SC4: within 24 hours of an available source update | Manual source download and transform; no bound | Missing files, invalid transformations, and failed assertions raise errors; no scheduler or snapshot registry. |
| DuckDB views | Query current canonical snapshot | Read files at service startup; restart/redeploy to pick up replacement files | Startup raises if required Parquet file is missing; no hot reload/version pinning. |
| PostgreSQL backup | Match same Parquet build | Manual, destructive full reload | Loader validates files then drops/recreates tables and copies batches; add staging/atomic swap before production. |
| MusicBrainz index | Optional lookup data current to its export | Manually exported from separately maintained DB | Optional index is used if file exists; record its source version and export date in future. |
| Listener playlist | Current public playlist when imported | Fetched at import; browser-session state thereafter | Import errors are surfaced; no persistent playlist refresh. |
| User profile (target) | Current state available immediately after successful PostgreSQL transaction | PostgreSQL authoritative serving state; target profile read <100 ms | No current user tables/auth integration; API must enforce owner scope. |
| Saved queue (target) | Available after explicit listener Save; later list/reopen reflects committed PostgreSQL state | PostgreSQL `user_data.saved_queue` + ordered track rows; target owner-scoped read <100 ms | No current queue tables/API; only minimal lifecycle metadata goes to Kafka; deletion must reach projections/archives. |
| Conversation messages (target) | Recent messages readable until configured transcript expiry | PostgreSQL owner-scoped rows; fixed short retention plus cold-log consolidation | No current transcript store; expiry and deletion job/metrics must be implemented. |
| Topic memories (target) | Relevant, unexpired summaries available to the next request | PostgreSQL `pgvector` exact search initially; decay ranking plus absolute maximum lifetime | No current embedding/retrieval; retrieval falloff does not itself delete data. |
| Kafka user events (target) | Target event-to-consumer p95 <5 s; outbox publisher polls at least once/second | Asynchronous, at-least-once delivery; target Kafka retention 7 days | Outbox buffers broker outage; alert on pending age/lag; idempotent consumer retries/DLQ. |
| HDFS event archive (target) | Avro files flushed/closed on bounded interval (proposed ≤15 min) | Raw archive target ≤12 months, subject to deletion policy | No archive writer today; protect access and propagate deletion/anonymization. |
| Event analytics Parquet (target) | Target daily compaction; at most 24-hour analytical lag | Append/partition by event date, query via DuckDB | Small files compacted; late events deduplicated by event_id. |
| Model telemetry (target) | Collector/export freshness and instrumentation overhead SLO TBD | Operational metrics/traces; sanitized event stream to Parquet on a measured compaction schedule | No structured instrumentation or collector today; telemetry failure must not fail recommendation requests. |
| Conversation transcript (target) | Short fixed maximum retention; exact duration TBD | PostgreSQL recent-message window; cold transcripts consolidated earlier when policy threshold is met | Scheduled expiry and delete cascade required; never retain solely because summarization failed. |
| Topic memory (target) | Retrieval falloff plus absolute maximum age; both values TBD | Relevant summaries retrieved by user-scoped pgvector search and recency/confidence/importance ranking | Low score is not deletion; delete text, vector, provenance, and dependent cache/archive rows at expiry/request. |
| Vector search (current) | No current catalog or conversation embedding/index | No embedding/index pipeline today | Target memory search uses pgvector only for compact topic memories; any index must enforce owner/expiry filters and delete derived vectors with their text. |

## 8. Master data

There is no managed master-data platform or golden-record workflow. Track IDs retain
the source Spotify ID; artist, genre, and album display identities are produced by
normalization and deterministic selection during each build. The source files and
their licensing owners remain upstream authorities. The canonical Parquet snapshot
is the authority for a particular local build; the PostgreSQL copy is derivative.
The generated integer artist/genre/album IDs are build-local, not durable business
identifiers. A future release should introduce a build manifest and either stable
surrogate-ID mapping or natural keys with documented collision handling.

## 9. Metadata and lineage

Schema mapping is encoded in `transform_erd.py`, `TABLE_PARQUET_MAP` in
`load_postgres.py`, and DuckDB's table list. The loader rejects missing Parquet
files and unexpected column order. Current metadata gaps: no automated catalog
manifest, source checksum, source publication date, transform version, snapshot
ID, field-level lineage output, or persisted row-count/quality report. Add a
machine-readable build manifest alongside each Parquet snapshot before adding
incremental refreshes. The target listener flow also needs lineage from each
import batch and source row/provider ID through validation and catalog-match
status, the catalog snapshot, corrected-summary version, and recommendation
reason. Preserve only the minimum needed to explain a decision; owner-scope and
delete personal lineage with its source data.

## 10. Data quality

Implemented checks include unique track/album/genre/artist IDs, unique album-score
and track-feature keys, track-to-album completeness, and several reference-set
checks in `transform_erd.py`; the loader validates expected Parquet columns and
integer conversions. PostgreSQL enforces primary and foreign keys. Quality risks
include title/artist fuzzy matches, missing optional fields, duplicated or
inconsistent upstream names/tags, lossy artist-alias matching, partial release
dates, and the chosen popularity/genre tie-breaking rules. No thresholds, rejected
row quarantine, source-to-output reconciliation report, or ongoing data-quality
dashboard is present. Extend transformation output with counts of dropped,
unmatched, and ambiguous source rows before declaring a production quality SLA.
The target playlist-import flow also needs 100% row accounting: each input row
must be accepted or surfaced with a duplicate, unsupported, incomplete, or
ambiguous reason. Test listener-visible review and ensure ambiguous/unreviewed
rows cannot become recommendation evidence. Queue tests must assert every hard
exclusion and the provenance of each recommendation; these are proposed
acceptance tests, not current measurements.

## 11. Data governance

`README.md` identifies four Kaggle sources and their licenses (MIT, CC-BY-SA-4.0,
GPL-2.0, and CC0). The repository code license does not override restrictions on
the merged derived catalog. The repository does not host source data as a general
distribution artifact; any redistribution must follow the respective dataset
terms, including attribution/share-alike or GPL obligations where applicable.
MusicBrainz data is separately supplied by the operator and requires its own
license/terms review. Listener profile and conversation context are session-scoped
today. The target product requires recorded, purpose-specific consent before
playlist import or personal-data persistence; persistent conversation history is
off by default and requires separate opt-in. A deletion request has a proposed
24-hour demo target, but the exact scope and proof must include backups, caches,
event projections, summaries, and embeddings. Before retaining chat, define
consent/notice, purpose, transcript and memory retention, user access/export/deletion,
backup expiry, and treatment of summaries and embeddings as derived personal data.
The target lifecycle deletes full logs
after a short fixed window or after successful topic consolidation; topic memories
also have a hard expiry regardless of retrieval. A low retrieval score is not
deletion. Model telemetry should be minimized to operational and approved analytic
fields; raw prompts, responses, credentials, and unnecessary user identifiers are
not telemetry defaults. Set distinct access and retention policies for metrics,
traces, and archived invocation events before deployment. Generated model responses
should not be treated as authoritative catalog facts. A working queue is ephemeral
until the listener explicitly saves it; saved queues are user-owned personal data
covered by the `saved_queue_persistence` consent and deletion rules.

## 12. Security and AI access

### Current AI data contract

The AI model has no direct DuckDB or PostgreSQL connection. The API calls a bounded
DuckDB tool service; the model can also propose one PostgreSQL fallback `SELECT`,
which is parsed and restricted before execution.

The demo-profile lookup described under AP9 is not part of the current contract.
If added, the API should resolve the authenticated/demo principal to one profile
before preparing recommendation context. The same owner-scoped API boundary applies
to conversations and memories. Do not allow the model to select arbitrary
`listener_id` values, directly retrieve another user's context, or query
profile/conversation tables through the generic SQL fallback.
For the proposed listener flow, the API must fail closed when required consent is
missing or withdrawn. Imported rows need explicit review status, and only reviewed
rows, confirmed preferences, and catalog attributes may support queue explanations.
Unconfirmed chat inferences stay request-scoped; persistent conversation history
is disabled unless the listener has separately opted in.

| Surface | Exposed data / fields | Access rules |
|---|---|---|
| DuckDB `search_tracks` | Track ID/title/duration/popularity/explicit, artist names, genre, selected audio features | Parameterized filters; max 100 results; query text, genre, artist, exclusions, duration, energy, explicit filter. |
| DuckDB `verify_tracks` | Candidate title/artist compared to local catalog; optional MusicBrainz recording ID/title/artist/duration | Max 50 candidates; may return multiple matches per candidate; API selects a catalog identity and source label; fuzzy results can be imperfect. |
| DuckDB `search_albums` | Album ID/title/format/date/label, genre, selected review scores | Bounded inputs and max 100 results. |
| DuckDB `compare_genres` | Genre ID/name, track count, average popularity/energy/danceability/tempo, explicit percentage | At most 20 requested genres; max 100 results. |
| PostgreSQL fallback | Tables `album`, `album_scores`, `artist_genres`, `artists`, `genre`, `track_artists`, `track_feel`, `tracks`; columns allowlisted in `backend/main.py` | Single `SELECT`; no schema-qualified objects or writes; 100-row cap; 8-second statement timeout; read-only `music_reader` role. |
| Model prompt context | User prompt, approved taste/profile detail, selected catalog rows | Sent to configured Cloudflare Worker. Do not include secrets or unnecessary personal data. |
| Proposed demo profile lookup | Only the current authenticated/demo profile's approved taste fields and mapped artist/genre preferences | API-scoped lookup; no arbitrary user-ID selection by the model; not implemented today. |
| Proposed recent conversation context | Bounded window of the authenticated user's own recent messages | API conversation service applies owner and expiry filters; send only the minimum needed to the configured model provider; no direct DB access. |
| Proposed topic-memory retrieval | A small number of relevant, unexpired topic summaries; no raw transcript by default | `user_id` and expiry filter before semantic search; rank with similarity/recency/confidence/importance; treat recalled text as untrusted user content, not instructions. |
| Proposed model telemetry | Invocation/trace IDs, provider/model/task, duration, outcome, retry count, optional provider usage, bounded tool metadata | API/Collector instrumentation; no raw prompts/responses, credentials, user IDs, or full catalog rows; separate telemetry ACL and retention. |

Security controls include typed request validation, 100-row caps on the
track/album/genre search tools, a 50-candidate verification limit, a read-only
database role, SQL AST validation, identifier/column allowlists, and a database
statement timeout. Verification may return multiple matches per candidate.
Conversation text and any selected memories sent to a hosted model leave the
operator's database boundary. Apply minimization and provider retention/training,
terms, and residency review; prefer a local generation/summarization model where
the privacy requirement warrants it and hardware permits. The model must not
receive database credentials or connect directly to any store. Treat stored and
recalled conversation content as untrusted input; summarization/retrieval must not
promote prompt-injection text into system instructions or authorize actions.

The proposed PostgreSQL service should use TLS, encryption at rest, least-privilege
separate roles for profile, conversation, and catalog access, and owner-scoped
repository methods (optionally reinforced by row-level security). Keep
`conversation_data` out of the catalog loader and generic SQL fallback. Audit
administrative access without logging message bodies. Deletion must cascade to
derived memories, vectors, provenance links, caches, and future archives; define
backup expiry and restoration-time deletion replay before production.

Example separate Avro telemetry record (registry subject/topic
`model-telemetry`, Kafka key `invocation_id`):

```json
{
  "type": "record",
  "name": "ModelInvocationTelemetry",
  "namespace": "music.recommender.telemetry.v1",
  "fields": [
    {"name": "invocation_id", "type": "string"},
    {"name": "trace_id", "type": "string"},
    {"name": "occurred_at", "type": {"type": "long", "logicalType": "timestamp-millis"}},
    {"name": "provider", "type": "string"},
    {"name": "model", "type": "string"},
    {"name": "task", "type": "string"},
    {"name": "duration_ms", "type": "long"},
    {"name": "outcome", "type": {"type": "enum", "name": "InvocationOutcome", "symbols": ["success", "error", "timeout"]}},
    {"name": "retry_count", "type": "int"},
    {"name": "input_tokens", "type": ["null", "long"], "default": null},
    {"name": "output_tokens", "type": ["null", "long"], "default": null},
    {"name": "tool_name", "type": ["null", "string"], "default": null},
    {"name": "catalog_rows", "type": ["null", "int"], "default": null},
    {"name": "error_class", "type": ["null", "string"], "default": null},
    {"name": "deployment_version", "type": "string"}
  ]
}
```

This schema is a target contract, not an implemented producer. `trace_id` is for
short-lived technical correlation; do not add account or session identity. Apply
compatible schema evolution and bounded-value validation to `provider`, `model`,
`task`, `outcome`, `tool_name`, and `error_class`.

Risks/gaps: local development credentials/defaults in
Compose and application configuration are not production secrets management;
external model calls transmit prompt/context; Worker CORS allows `*`; no
authentication/rate limiting, user authorization, audit log, or deployment threat
model is documented here. Require TLS, secret injection, access controls, retention
rules, and provider review for a public deployment. Playlist import only accepts
HTTPS URLs from explicitly supported YouTube hosts and uses `yt-dlp`; continue to
validate any future URL-fetching feature against SSRF.

## 13. Analytics and AI data delivery

### Proposed star schema

This is a **future analytical projection**, not a currently loaded warehouse model.
Catalog facts describe snapshots; proposed user-event facts and model invocation
telemetry are separate projections. The repository does not persist impressions,
plays, skips, ratings, feedback, or model invocation events today.

```text
                 DimAlbum ───────┐
                 DimGenre ───────┤
                 DimSnapshotDate┤
DimTrack ───── FactTrackCatalog ─┘── BridgeTrackArtist ── DimArtist
  grain: one row per unique catalog track per snapshot build
  measures: duration_ms, popularity, energy, valence, danceability, tempo, etc.

DimAlbum ───── FactAlbumScoreSnapshot ───── DimSnapshotDate
  grain: one row per album with ratings per catalog snapshot
  measures: critic/user scores and review counts

DimModel ───── FactModelInvocation ───── DimRequestDate
  grain: one row per model invocation (privacy-minimized)
  measures: duration, retries, outcome, provider-reported token counts when available
```

`DimTrack`, `DimAlbum`, `DimGenre`, `DimArtist`, and `DimSnapshotDate` are
conformed dimensions. `BridgeTrackArtist` preserves the many-to-many artist
credits. `FactTrackCatalog` is one row per unique `track_id` per snapshot; the
snapshot date is assigned by ingestion because source event dates are not present.
`FactAlbumScoreSnapshot` is one row per rated `album_id` per snapshot.
`FactModelInvocation` is populated only from the proposed `model-telemetry` stream;
exclude prompt/response content and user identity. Do not use catalog or model
invocation facts as evidence of user engagement.
Conversation text, topic summaries, and embeddings remain in the user-serving
store and are not loaded into this analytical star by default; analytics do not
need raw personal conversation content.

### Demonstration analytics against current Parquet proof of concept

The following DuckDB queries run directly against the current Parquet catalog. They
are analytical equivalents of the proposed star-schema questions; they do not
claim the star tables have already been materialized. Sample output was computed
from the local snapshot.

**AQ1 — Which genres have the largest catalog representation?** (AP4)

```sql
SELECT g.genre_name,
       COUNT(DISTINCT t.track_id) AS track_count,
       ROUND(AVG(t.popularity), 2) AS avg_popularity,
       ROUND(AVG(f.energy), 3) AS avg_energy
FROM read_parquet('transformed/genre.parquet') AS g
JOIN read_parquet('transformed/tracks.parquet') AS t USING (genre_id)
LEFT JOIN read_parquet('transformed/track_feel.parquet') AS f USING (track_id)
GROUP BY g.genre_name
ORDER BY track_count DESC
LIMIT 5;
```

| genre | tracks | avg popularity | avg energy |
|---|---:|---:|---:|
| acoustic | 1,000 | 42.48 | 0.435 |
| tango | 999 | 19.87 | 0.373 |
| afrobeat | 999 | 24.41 | 0.703 |
| cantopop | 999 | 34.75 | 0.462 |
| ambient | 998 | 44.23 | 0.237 |

**AQ2 — Which scored albums have the highest critic scores?** (AP3/AP8)

```sql
SELECT a.album_name, s.metacritic_critic_score, a.release_date, a.label
FROM read_parquet('transformed/album.parquet') AS a
JOIN read_parquet('transformed/album_scores.parquet') AS s USING (album_id)
WHERE s.metacritic_critic_score IS NOT NULL
ORDER BY s.metacritic_critic_score DESC, a.album_name
LIMIT 5;
```

| album | Metacritic critic score | release date | label |
|---|---:|---|---|
| Fetch The Bolt Cutters | 98 | 2020-04-17 | Epic |
| From Caplan To Belsize | 98 | 2016-03-04 | Animal Style, Specialist Subject |
| SMiLE | 97 | 2004-09-28 | Nonesuch |
| The Greatest Generation | 97 | 2013-05-14 | Hopeless |
| Van Lear Rose | 97 | 2004-04-27 | Interscope |

**AQ3 — Which artists have the highest Last.fm listener-count proxy?** (AP8)

```sql
SELECT artist_name, artist_country, artist_popularity
FROM read_parquet('transformed/artists.parquet')
WHERE artist_popularity IS NOT NULL
ORDER BY artist_popularity DESC
LIMIT 5;
```

| artist | country | listener-count proxy |
|---|---|---:|
| Coldplay | United Kingdom | 5,381,567 |
| Radiohead | United Kingdom | 4,732,528 |
| Red Hot Chili Peppers | United States | 4,620,835 |
| Rihanna | United States | 4,558,193 |
| Eminem | United States | 4,518,868 |

### Dashboard mockup

The companion HTML includes a CSS-only dashboard mockup with these three query
results, row-count cards, and the snapshot caveat. It is a design mockup, not a
deployed dashboard. Current application pages are for recommendation/chat workflows,
not these analytics.

### AI data delivery

| Use case | Data read | Delivery path | Current status |
|---|---|---|---|
| Catalog-based recommendations | Track, artist, genre, duration, explicitness, selected audio features/popularity | Worker plans a named DuckDB tool; API fetches bounded rows and sends them with prompt context to response model | Implemented; Parquet → DuckDB is primary. |
| Album discovery | Album metadata, genre, review scores | `search_albums` DuckDB tool; PostgreSQL fallback if required | Implemented. |
| Genre comparison | Aggregate catalog metrics | `compare_genres` DuckDB tool | Implemented. |
| Direct-prompt title verification | Candidate titles/artist names against catalog; optional MusicBrainz index | API calls DuckDB verification; client uses resolved catalog identity | Implemented; matching can be approximate. |
| Catalog semantic/vector retrieval | No data currently | None | Future only; embedding model configured but no catalog index, chunks, or retrieval contract. pgvector topic-memory retrieval is a separate proposed user-context function. |
| Conversation continuity (target) | Recent owner-scoped messages plus relevant, unexpired topic summaries | API loads a bounded recent window and uses pgvector for topic-memory search; sends only selected context to model | Proposed only; short transcript TTL, topic consolidation at falloff, hard expiry/deletion for both layers. |
| Listener analytics/personalization learning | No persisted interaction data | None | Out of scope until event capture/consent and governance exist. |
| Model reliability/cost/latency analytics (target) | Sanitized invocation events; provider usage only when reported | OpenTelemetry operational metrics/traces; Kafka `model-telemetry` → HDFS Avro → compacted Parquet/DuckDB | Proposed only; no structured invocation telemetry, collector, topic, archive, or dashboard today. |

## 14. Target state and scalability

For the current dataset scale, Parquet plus DuckDB is intentionally simple. As the
catalog grows, first add build manifests, immutable versioned output directories,
atomic publication, data-quality summaries, and repeatable DuckDB benchmarks.
Partitioning or file compaction should be driven by measured access patterns; the
current single-file-per-entity layout is small and not date-partitioned. Keep
PostgreSQL a rebuildable backup while it remains useful. If multiple writers,
concurrent sessions, or strict freshness/availability emerge, reassess a managed
relational/catalog store and explicit replica/snapshot consistency.

The proposed `pgvector` use is limited to topic-memory retrieval, not catalog
semantic recommendations. Select its embedding model/version/dimensions and
benchmark exact search before adding HNSW/IVFFlat; always scope by owner and
expiry. If semantic catalog recommendations become a requirement, separately
design chunk granularity, model/version/dimensions, distance metric/index,
metadata filters, source keys, refresh/delete propagation, evaluation set, and
model provider/privacy boundaries before describing that architecture as
implemented.
If interaction analytics become a goal, add a consented event contract first, then
build incremental fact loads and a warehouse from those events; the current
streaming-habits CSV is not a substitute for app events.

## 15. Roadmap, risks, and accepted tradeoffs

### Suggested roadmap

1. **Stabilize snapshots:** version/build manifest, source checksums, transformation
   metrics, and reproducible SQL benchmark report tied to AP IDs.
2. **Make refresh safe:** stage and validate a new Parquet build, publish
   atomically, and reload/swap PostgreSQL without dropping the last good backup.
3. **Set operational objectives:** measure AP1–AP5 latency and quality over
   representative requests; instrument model-call latency/outcomes with
   privacy-minimized telemetry; specify refresh cadence and monitoring.
4. **Harden deployment:** externalize secrets, authenticate/rate-limit API surfaces,
   review Worker privacy/CORS, and document retention/access boundaries.
5. **Resolve remaining listener-product decisions:** approve the import method,
   consent notice/purposes, chat opt-in/retention, deletion semantics, and
   tombstone/consumer acknowledgment path. Generated queues are saved only by
   explicit listener action.
6. **Build the consented listener core:** implement consent gates, reviewed
   per-row import outcomes, owner-scoped profile state, exclusions, and deletion;
   test row accounting, ownership, and the 24-hour deletion target end to end.
7. **Add explainable recommendations and refinement:** require listener review
   of taste summaries, preserve per-item supporting evidence, enforce hard
   exclusions, and save inferred preferences only after explicit confirmation.
   Measure the reviewed 100-track / <5-second target over repeat runs; persistent
   chat remains off by default and is enabled only by separate opt-in.
8. **Complete event and operational capabilities:** add Kafka/Avro projections,
   conversation/memory storage, privacy-minimized model telemetry, and analytics
   only under the approved retention, deletion, provider-data, and access
   contracts. These remain separate proposed work.

### Three largest risks

| Risk | Impact | Mitigation |
|---|---|---|
| Entity resolution and generated IDs can merge incorrectly or shift across builds. | Wrong recommendations/ratings or cross-store joins to the wrong record. | Track transform version, reconcile ambiguity, preserve stable IDs/mappings, and test match quality. |
| Manual source/Parquet/PostgreSQL refresh causes stale or inconsistent copies. | DuckDB and fallback can answer from different catalog versions; SC4 is unmet. | Versioned snapshots, freshness watermark, automated schedule, atomic publish/reload, and alerting. |
| Playlist rows are silently dropped or mismatched, or recommendation reasons cannot be traced. | Listener receives a misleading queue and cannot correct its source context. | Account for every row, surface ambiguous/unmatched reasons, restrict evidence to reviewed rows, and test exclusion/provenance coverage. |
| Model-provider/privacy and local development security gaps. | Listener prompts/profile context leave the local host; weak defaults or open surfaces can expose data. | Minimize/redact context, production secret management, authentication, TLS, rate limits, provider review, audit and retention policies. |
| Deletion cannot propagate through asynchronous event consumers before the deadline. | Deleted listener context remains in projections, archives, or caches. | Keep a minimal deletion tombstone until required consumer acknowledgment; test all copies against the 24-hour target and bound tombstone retention. |

**Accepted today:** eventual/manual consistency between Parquet and PostgreSQL;
static catalog rather than live streaming updates; no durable personalization;
external model dependency; and no semantic/vector retrieval despite a configured
embedding model. These are explicit project-stage tradeoffs, not production
guarantees. Revise this blueprint as architectural direction changes.

## Implementation references

- [`backend/duckdb_service.py`](../../backend/duckdb_service.py) — primary Parquet-backed query tools.
- [`backend/main.py`](../../backend/main.py) — orchestration, model calls, SQL policy, playlist import, and fallback.
- [`transform_erd.py`](../../transform_erd.py) — CSV-to-Parquet mapping and quality assertions.
- [`load_postgres.py`](../../load_postgres.py) — backup DDL and batch loader.
- [`docker-compose.yml`](../../docker-compose.yml) — local service topology and optional infrastructure.
- [`sql/`](../../sql/) — baseline, index, and benchmark SQL.
- [`README.md`](../../README.md) — setup, data licensing, and current user-visible behavior.
- [`ERD.pdf`](../ERD.pdf) — initial relational diagram.
- [`Indexing_Strategy.pdf`](../Indexing_Strategy.pdf) and [`Query_Performance_Assessment_Final.pdf`](../Query_Performance_Assessment_Final.pdf) — existing physical-design evidence.
