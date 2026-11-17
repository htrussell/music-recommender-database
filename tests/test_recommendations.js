const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadApp() {
    const elements = new Map();
    const storage = new Map();
    const context = vm.createContext({
        window: {},
        console,
        URL,
        sessionStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { value: "", checked: true, classList: { add() {}, remove() {} } });
                return elements.get(id);
            }
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), context);
    return context;
}

test("filters imported YouTube titles and covers while retaining unrelated titles", () => {
    const app = loadApp();
    const ids = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [
            { id: "yt1", artist: "Example - Topic", title: "Example - Starlight (Official Video)" },
            { id: "yt2", artist: "Various", title: "夜の歌 - 別の歌手 [Official Audio]" }
        ];
        CATALOG_ITEMS = [
            { id: "db:1", artist: "Example", title: "Starlight" },
            { id: "db:2", artist: "Cover Artist", title: "Starlight (Acoustic Cover)" },
            { id: "db:3", artist: "Different", title: "夜の歌" },
            { id: "db:4", artist: "Example", title: "Starlight Avenue" },
            { id: "db:5", artist: "Other", title: "New Song" },
            { id: "db:6", artist: "Another", title: "New Song - 2011 Remaster" }
        ];
        return filterExcludedRecommendations(
            CATALOG_ITEMS.map(item => ({ content_id: item.id })),
            getRecommendationExclusions()
        ).map(item => item.content_id).join(",");
    })()`, app);
    assert.equal(ids, "db:4,db:5");
});

test("the rendered queue keeps only one exact title across artists", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [{ id: "yt1", artist: "Example", title: "Live" }];
        CATALOG_ITEMS = [
            { id: "db:1", title: "Hallelujah", artist: "Jeff Buckley", duration: 4, tags: [] },
            { id: "db:2", title: "hallelujah", artist: "Rufus Wainwright", duration: 4, tags: [] },
            { id: "db:3", title: "Live", artist: "Other", duration: 4, tags: [] },
            { id: "db:4", title: "Cover", artist: "Alice", duration: 4, tags: [] },
            { id: "db:5", title: "Cover", artist: "Bob", duration: 4, tags: [] },
            { id: "db:6", title: "Different Song", artist: "Other", duration: 4, tags: [] }
        ];
        refreshChatContextDisplay = () => {};
        const data = { recommendations: CATALOG_ITEMS.map(item => ({ content_id: item.id, reason: "Match" })) };
        renderResults(data, 20);
        return {
            ids: data.recommendations.map(item => item.content_id).join(","),
            queue: document.getElementById("queueList").innerHTML,
            duration: document.getElementById("metricDuration").textContent
        };
    })()`, app);
    assert.equal(result.ids, "db:1,db:4,db:6");
    assert.match(result.queue, /Jeff Buckley/);
    assert.doesNotMatch(result.queue, /Rufus Wainwright/);
    assert.equal(result.duration, "12:00 / 20:00");
});

test("an exact title in the imported playlist excludes all matching artists", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [{ id: "yt1", artist: "Jeff Buckley", title: "Hallelujah" }];
        CATALOG_ITEMS = [
            { id: "db:1", title: "Hallelujah", artist: "Jeff Buckley" },
            { id: "db:2", title: "HALLELUJAH", artist: "Rufus Wainwright" },
            { id: "db:3", title: "Hallelujah Again", artist: "Rufus Wainwright" }
        ];
        return filterExcludedRecommendations(
            CATALOG_ITEMS.map(item => ({ content_id: item.id })),
            getRecommendationExclusions()
        ).map(item => item.content_id).join(",");
    })()`, app);
    assert.equal(result, "db:3");
});

test("the exclusion indicator checks artist names without claiming semantic compliance", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        CATALOG_ITEMS = [{ id: "db:1", title: "Song", artist: "Excluded Artist", duration: 4, tags: [] }];
        refreshChatContextDisplay = () => {};
        renderResults({ recommendations: [{ content_id: "db:1" }], excluded_topics: ["excluded"] }, 4);
        return document.getElementById("metricExclusion").textContent;
    })()`, app);
    assert.equal(result, "Violation Detected");
});

test("sample reference tracks are excluded by ID and title until the profile changes", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [];
        DEMO_PROFILE = {
            tracks: [
                { catalog_track_id: "seed", title: "Reference Song", artist: "Alice", profile_match: ["top_artist"] }
            ]
        };
        CATALOG_ITEMS = [
            { id: "db:seed", title: "Reference Song", artist: "Alice" },
            { id: "db:cover", title: "Reference Song", artist: "Bob" },
            { id: "db:similar", title: "Refernce Song", artist: "Other" },
            { id: "db:new", title: "Different Song", artist: "Other" }
        ];
        const recommendations = CATALOG_ITEMS.map(item => ({ content_id: item.id }));
        const withProfile = filterExcludedRecommendations(recommendations, getRecommendationExclusions())
            .map(item => item.content_id).join(",");
        DEMO_PROFILE = { tracks: [
            { catalog_track_id: "new", title: "Different Song", artist: "Other", profile_match: ["top_genre"] }
        ] };
        const switched = filterExcludedRecommendations(recommendations, getRecommendationExclusions())
            .map(item => item.content_id).join(",");
        DEMO_PROFILE = null;
        const cleared = filterExcludedRecommendations(recommendations, getRecommendationExclusions())
            .map(item => item.content_id).join(",");
        return { withProfile, switched, cleared };
    })()`, app);
    assert.equal(result.withProfile, "db:new");
    assert.equal(result.switched, "db:seed,db:similar");
    assert.equal(result.cleared, "db:seed,db:similar,db:new");
});

test("catalog-first selection prioritizes ranked goals and excludes playlist, sample, and history", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [{ id: "yt1", title: "Telephones", artist: "Example" }];
        DEMO_PROFILE = {
            profile: { top_artist: "Alice", top_genre: "Pop", top_mood: "Calm" },
            tracks: [{ catalog_track_id: "seed", title: "Reference Song", artist: "Alice", profile_match: ["top_artist"] }]
        };
        CATALOG_ITEMS = [{ id: "db:old", title: "Earlier Track", artist: "Old", tags: [] }];
        rememberRecommendedIds([{ content_id: "db:old" }]);
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Indie music";
        document.getElementById("budgetInput").value = "9";
        document.getElementById("exclusionsInput").value = "country";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        let rendered, prompt, calls = 0, request;
        renderResults = data => { rendered = data; };
        fetchCatalogCandidates = async (goal, exclusions, offset) => {
            request = { goal, exclusions, offset };
            const row = (id, title, artist, duration = 240000, genre = "indie") =>
                ({ catalog_track_id: id, title, artist, duration_ms: duration, genre });
            return { goal_candidates: [
                row("seed", "Reference Song", "Alice"),
                row("sample-cover", "Refernce Song", "Other"),
                row("playlist", "Telephons", "Other"),
                row("old-cover", "Earlier Track", "Cover"),
                row("bad-genre", "Country Tune", "Band", 240000, "country"),
                row("unknown", "Unknown Duration", "Artist", 0),
                row("goal-1", "Quiet Horizon", "Artist One"),
                row("goal-2", "Blue Skies", "Artist Two")
            ], fallback_candidates: [
                row("generic", "Other Melody", "Artist Three", 120001, "pop")
            ], next_offset: null };
        };
        requestAiJson = async (system, content) => {
            calls++;
            prompt = content;
            return { recommendations: calls === 1
                ? [{ content_id: "db:goal-2", reason: "Fits the goal" }, { content_id: "db:fake" }]
                : [] };
        };
        await generateGoalQueue();
        return {
            ids: rendered.recommendations.map(item => item.content_id).join(","),
            sources: rendered.recommendations.map(item => item.source).join(","),
            stats: rendered.selection_stats,
            note: rendered.ai_comment, prompt, calls,
            exclusions: request.exclusions.join(",")
        };
    })()`, app);
    assert.equal(result.ids, "db:goal-2,db:goal-1,db:generic");
    assert.equal(result.sources, "ai_ranked,search_fill,broad_fill");
    assert.equal(result.stats.verified, 8);
    assert.equal(result.stats.excluded, 5);
    assert.match(result.note, /10:00 \/ 9:00 minimum/);
    assert.equal(result.exclusions, "country");
    assert.match(result.prompt, /Sample taste signals: Top artist: Alice/);
    assert.doesNotMatch(result.prompt, /"id":"db:seed"/);
    assert.equal(result.calls, 3);
});

test("queue duration uses actual milliseconds and permits only the last song to cross the target", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Long tracks";
        document.getElementById("budgetInput").value = "30";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        refreshChatContextDisplay = () => {};
        fetchCatalogCandidates = async () => ({ goal_candidates: [
            { catalog_track_id: "1", title: "First Track", artist: "A", duration_ms: 899500 },
            { catalog_track_id: "2", title: "Second Track", artist: "B", duration_ms: 900400 },
            { catalog_track_id: "3", title: "Third Track", artist: "C", duration_ms: 50000 },
            { catalog_track_id: "4", title: "Fourth Track", artist: "D", duration_ms: 50000 }
        ], fallback_candidates: [], next_offset: null });
        requestAiJson = async () => ({ recommendations: [
            { content_id: "db:1" }, { content_id: "db:2" },
            { content_id: "db:3" }, { content_id: "db:4" }
        ] });
        await generateGoalQueue();
        const data = JSON.parse(document.getElementById("rawJsonResponse").textContent);
        return {
            ids: data.recommendations.map(item => item.content_id).join(","),
            duration: document.getElementById("metricDuration").textContent
        };
    })()`, app);
    assert.equal(result.ids, "db:1,db:2,db:3");
    assert.equal(result.duration, "30:49 / 30:00");
});

test("catalog fallback loads further pages and skips tracks without usable duration", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "New music";
        document.getElementById("budgetInput").value = "4";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        let rendered;
        renderResults = data => { rendered = data; };
        const offsets = [];
        fetchCatalogCandidates = async (goal, exclusions, offset = 0) => {
            offsets.push(offset);
            return offset === 0
                ? { goal_candidates: [], fallback_candidates: [
                    { catalog_track_id: "unknown", title: "Unknown", artist: "A", duration_ms: null }
                  ], next_offset: 100 }
                : { goal_candidates: [], fallback_candidates: [
                    { catalog_track_id: "new", title: "New Song", artist: "B", duration_ms: 300000 }
                  ], next_offset: null };
        };
        requestAiJson = async () => { throw new Error("No AI call expected without candidates"); };
        await generateGoalQueue();
        return { offsets: offsets.join(","), ids: rendered.recommendations.map(item => item.content_id).join(","), note: rendered.ai_comment };
    })()`, app);
    assert.equal(result.offsets, "0,100");
    assert.equal(result.ids, "db:new");
    assert.match(result.note, /2 retrieved, 1 with usable details and duration/);
});

test("malformed ranking responses retry within the two-retry limit and fall back explicitly", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [{ id: "yt1", title: "Old Song", artist: "A" }];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Songs like my playlist";
        document.getElementById("budgetInput").value = "4";
        let rendered, warning, calls = 0;
        showToast = (message, type) => { if (type === "warning") warning = message; };
        setLoading = () => {};
        renderCatalogTable = () => {};
        renderResults = data => { rendered = data; };
        fetchCatalogCandidates = async () => ({ goal_candidates: [
            { catalog_track_id: "new", title: "New Song", artist: "B", duration_ms: 240000 }
        ], fallback_candidates: [], next_offset: null });
        requestAiJson = async () => { calls++; return {}; };
        await generateGoalQueue();
        return { calls, ids: rendered.recommendations.map(item => item.content_id).join(","), note: rendered.ai_comment, warning };
    })()`, app);
    assert.equal(result.calls, 3);
    assert.equal(result.ids, "db:new");
    assert.match(result.note, /AI ranking failed:.*recommendations array/);
    assert.match(result.warning, /fallback/);
});

test("ranking retries an invalid entry and uses a subsequent valid response", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Indie";
        document.getElementById("budgetInput").value = "4";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        let rendered, calls = 0;
        renderResults = data => { rendered = data; };
        fetchCatalogCandidates = async () => ({ goal_candidates: [
            { catalog_track_id: "one", title: "First Song", artist: "A", duration_ms: 240000 }
        ], fallback_candidates: [], next_offset: null });
        requestAiJson = async () => {
            calls++;
            return calls === 1 ? { recommendations: [{}] } : { recommendations: [{ content_id: "db:one" }] };
        };
        await generateGoalQueue();
        return { calls, source: rendered.recommendations[0].source, note: rendered.ai_comment };
    })()`, app);
    assert.equal(result.calls, 2);
    assert.equal(result.source, "ai_ranked");
    assert.doesNotMatch(result.note, /AI ranking failed/);
});

test("a later ranking error preserves AI-ranked tracks and reports catalog fallback", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Indie";
        document.getElementById("budgetInput").value = "8";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        let rendered, calls = 0;
        renderResults = data => { rendered = data; };
        fetchCatalogCandidates = async () => ({ goal_candidates: [
            { catalog_track_id: "one", title: "First Song", artist: "A", duration_ms: 240000 }
        ], fallback_candidates: [
            { catalog_track_id: "two", title: "Second Song", artist: "B", duration_ms: 240000 }
        ], next_offset: null });
        requestAiJson = async () => {
            calls++;
            if (calls === 1) return { recommendations: [{ content_id: "db:one" }] };
            throw new Error("ranking unavailable");
        };
        await generateGoalQueue();
        return { calls, ids: rendered.recommendations.map(item => item.content_id).join(","), note: rendered.ai_comment };
    })()`, app);
    assert.equal(result.calls, 2);
    assert.equal(result.ids, "db:one,db:two");
    assert.match(result.note, /AI ranking failed: ranking unavailable/);
});

test("a later catalog-page failure preserves the partial queue and reports the error", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [];
        CATALOG_ITEMS = [];
        document.getElementById("goalTextInput").value = "Indie";
        document.getElementById("budgetInput").value = "8";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        let rendered;
        renderResults = data => { rendered = data; };
        fetchCatalogCandidates = async (goal, exclusions, offset = 0) => {
            if (offset) throw new Error("catalog unavailable");
            return { goal_candidates: [
                { catalog_track_id: "one", title: "First Song", artist: "A", duration_ms: 240000 }
            ], fallback_candidates: [], next_offset: 100 };
        };
        requestAiJson = async () => ({ recommendations: [{ content_id: "db:one" }] });
        await generateGoalQueue();
        return { ids: rendered.recommendations.map(item => item.content_id).join(","), note: rendered.ai_comment };
    })()`, app);
    assert.equal(result.ids, "db:one");
    assert.match(result.note, /Additional catalog search failed: catalog unavailable/);
    assert.match(result.note, /did not return enough eligible audio/);
});

test("previously recommended titles remain excluded after the catalog is reloaded", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        CATALOG_ITEMS = [{ id: "db:old", title: "Earlier Song", artist: "Alice" }];
        rememberRecommendedIds([{ content_id: "db:old" }]);
        CATALOG_ITEMS = [{ id: "db:cover", title: "Earlier Song", artist: "Bob" }];
        return filterExcludedRecommendations(
            [{ content_id: "db:cover" }],
            getRecommendationExclusions(getPreviouslyRecommendedIds())
        ).length;
    })()`, app);
    assert.equal(result, 0);
});

test("clearing a sample removes its exclusion and reference label from existing catalog entries", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        DEMO_PROFILE = {
            profile: {},
            tracks: [{ catalog_track_id: "seed", title: "Reference Song", artist: "Alice", profile_match: ["top_artist"] }]
        };
        CATALOG_ITEMS = [{ id: "db:seed", title: "Reference Song", artist: "Alice", category: "Music", duration: 4, tags: [] }];
        refreshChatContextDisplay = () => {};
        renderCatalogTable();
        const before = document.getElementById("catalogTableBody").innerHTML;
        clearDemoProfile();
        const after = document.getElementById("catalogTableBody").innerHTML;
        const ids = filterExcludedRecommendations([{ content_id: "db:seed" }], getRecommendationExclusions())
            .map(item => item.content_id).join(",");
        return { before, after, ids };
    })()`, app);
    assert.match(result.before, /Sample reference \(excluded\)/);
    assert.doesNotMatch(result.after, /Sample reference \(excluded\)/);
    assert.equal(result.ids, "db:seed");
});

test("playlist title matching handles repeated artist prefixes and conservative spelling differences", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [
            { id: "yt1", artist: "Yot Club - Topic", title: "Yot Club - YKWIM?" },
            { id: "yt2", artist: "VACATIONS", title: "VACATIONS - Vacations - Telephones" },
            { id: "yt3", artist: "Alice", title: "Blue Skies" },
            { id: "yt4", artist: "Other", title: "One" }
        ];
        CATALOG_ITEMS = [
            { id: "db:1", artist: "Yot Club", title: "YKWIM?" },
            { id: "db:2", artist: "Vacations", title: "Telephones" },
            { id: "db:3", artist: "Other", title: "Telephons" },
            { id: "db:4", artist: "Other", title: "Blue Skie" },
            { id: "db:5", artist: "Other", title: "Blue Skies Again" },
            { id: "db:6", artist: "Other", title: "Only" },
            { id: "db:7", artist: "Other", title: "Telephone Call" },
            { id: "db:8", artist: "Other", title: "Vacation" }
        ];
        return filterExcludedRecommendations(
            CATALOG_ITEMS.map(item => ({ content_id: item.id })),
            getRecommendationExclusions()
        ).map(item => item.content_id).join(",");
    })()`, app);
    assert.equal(result, "db:5,db:6,db:7,db:8");
});

test("recommendation titles with repeated artist prefixes match clean playlist titles", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [{ id: "p1", artist: "Vacations", title: "Telephones" }];
        CATALOG_ITEMS = [
            { id: "db:1", artist: "Vacations", title: "VACATIONS - Vacations - Telephones" },
            { id: "db:2", artist: "Other", title: "VACATIONS - Vacations - Telephones" },
            { id: "db:3", artist: "Other", title: "Telephone Call" }
        ];
        return filterExcludedRecommendations(
            CATALOG_ITEMS.map(item => ({ content_id: item.id })),
            getRecommendationExclusions()
        ).map(item => item.content_id).join(",");
    })()`, app);
    assert.equal(result, "db:2,db:3");
});

test("fuzzy matching respects edit limits and does not fuzz short titles", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PLAYLIST_ITEMS = [
            { id: "p1", artist: "Alice", title: "Hallelujah" },
            { id: "p2", artist: "Bob", title: "Interstellar" },
            { id: "p3", artist: "Other", title: "Sing" }
        ];
        CATALOG_ITEMS = [
            { id: "db:1", artist: "Other", title: "Halleluja" },
            { id: "db:2", artist: "Other", title: "Halelujh" },
            { id: "db:3", artist: "Other", title: "Interstela" },
            { id: "db:4", artist: "Other", title: "Interstel" },
            { id: "db:5", artist: "Other", title: "Sng" }
        ];
        return filterExcludedRecommendations(
            CATALOG_ITEMS.map(item => ({ content_id: item.id })),
            getRecommendationExclusions()
        ).map(item => item.content_id).join(",");
    })()`, app);
    assert.equal(result, "db:2,db:4,db:5");
});

test("exact titles remain excluded across discovery passes", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [{ id: "yt1", artist: "Example", title: "Example - Live" }];
        CATALOG_ITEMS = [];
        mergeDatabaseCatalogRows = rows => {
            rows.forEach(row => {
                if (!CATALOG_ITEMS.some(item => item.id === "db:" + row.catalog_track_id)) {
                    CATALOG_ITEMS.push({
                        id: "db:" + row.catalog_track_id, title: row.title, artist: row.artist,
                        duration: 4, tags: []
                    });
                }
            });
        };
        let call = 0;
        requestAiJson = async () => ({ tracks: [
            { title: "Live", artist: "Other" },
            { title: "Cover", artist: ++call === 1 ? "Alice" : "Bob" }
        ] });
        fetch = async () => ({
            ok: true,
            json: async () => ({ tracks: [
                { catalog_track_id: 1, title: "Live", artist: "Other" },
                { catalog_track_id: call === 1 ? 2 : 3, title: "Cover", artist: call === 1 ? "Alice" : "Bob" }
            ] })
        });
        const options = {
            goalText: "Similar songs", budgetMins: 12, preferredTopics: [],
            excludedTopics: [], existingIds: []
        };
        const first = await fetchExternalDiscoveryTracks(options);
        options.existingIds = first.map(item => item.id);
        const second = await fetchExternalDiscoveryTracks(options);
        return [first.map(item => item.id).join(","), second.map(item => item.id).join(",")].join("|");
    })()`, app);
    assert.equal(result, "db:2|");
});

test("discovery filters verified playlist covers and supplies attempted tracks on retry", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        PLAYLIST_ITEMS = [{ id: "yt1", artist: "Example - Topic", title: "Example - Starlight (Official Video)" }];
        CATALOG_ITEMS = [];
        mergeDatabaseCatalogRows = rows => {
            rows.forEach(row => CATALOG_ITEMS.push({
                id: "db:" + row.catalog_track_id, title: row.title, artist: row.artist,
                duration: 4, tags: []
            }));
        };
        let lastPrompt = "";
        requestAiJson = async (system, prompt) => {
            lastPrompt = prompt;
            return { tracks: [
                { title: "Starlight", artist: "Cover Artist" },
                { title: "New Song", artist: "Other" }
            ] };
        };
        fetch = async () => ({
            ok: true,
            json: async () => ({ tracks: [
                { catalog_track_id: 1, title: "Starlight", artist: "Cover Artist" },
                { catalog_track_id: 2, title: "New Song", artist: "Other" }
            ] })
        });
        const attemptedTracks = [];
        const options = {
            goalText: "Similar songs", budgetMins: 12, preferredTopics: [],
            excludedTopics: [], existingIds: [], attemptedTracks
        };
        const first = await fetchExternalDiscoveryTracks(options);
        await fetchExternalDiscoveryTracks(options);
        return {
            ids: first.map(item => item.id).join(","),
            attempted: attemptedTracks.length,
            prompt: lastPrompt
        };
    })()`, app);
    assert.equal(result.ids, "db:2");
    assert.equal(result.attempted, 4);
    assert.match(result.prompt, /Cover Artist - Starlight/);
});

