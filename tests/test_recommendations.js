const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadApp(storage = new Map()) {
    const elements = new Map();
    const context = vm.createContext({
        window: {
            YT: { Player: function(id, options) { this.events = options.events; this.destroy = () => {}; this.playVideo = () => {}; } },
            location: { origin: "http://localhost:8000" },
            innerWidth: 1200,
            innerHeight: 900
        },
        console,
        URL,
        confirm: () => true,
        fetch: async () => ({
            ok: true,
            json: async () => ({ candidates: [] })
        }),
        sessionStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        },
        document: {
            visibilityState: "visible",
            hasFocus: () => true,
            getElementById(id) {
                if (!elements.has(id)) {
                    const classes = new Set();
                    elements.set(id, {
                        value: "", checked: true, scrollIntoView() {}, focus() {}, setAttribute() {},
                        getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225 }),
                        classList: {
                            add: (...names) => names.forEach(name => classes.add(name)),
                            remove: (...names) => names.forEach(name => classes.delete(name)),
                            toggle: (name, force) => {
                                const add = force === undefined ? !classes.has(name) : force;
                                if (add) classes.add(name); else classes.delete(name);
                                return add;
                            },
                            contains: name => classes.has(name)
                        }
                    });
                }
                return elements.get(id);
            }
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), context);
    return context;
}

test("YouTube preview embeds only validated results and escapes result labels", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song", artist: "Artist" }];
        fetch = async (url, options) => ({
            ok: true,
            json: async () => ({
                candidates: [
                    { video_id: "abcdefghijk", title: "<Song>", channel: "Artist" },
                    { video_id: "bad-id", title: "Invalid", channel: "Artist" }
                ],
                suggested_video_id: "abcdefghijk",
                warning: null
            })
        });
        await openYouTubePreview(0);
        return {
            player: document.getElementById("youtubePreviewPlayer").innerHTML,
            candidates: document.getElementById("youtubePreviewCandidates").innerHTML,
            status: document.getElementById("youtubePreviewStatus").textContent
        };
    })()`, app);
    assert.match(result.player, /youtube\.com\/embed\/abcdefghijk/);
    assert.match(result.candidates, /&lt;Song&gt;/);
    assert.doesNotMatch(result.candidates, /Invalid/);
    assert.match(result.status, /Suggested match/);
});

test("closing YouTube preview ignores a pending search", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song", artist: "Artist" }];
        let finish;
        fetch = () => new Promise(resolve => { finish = resolve; });
        const pending = openYouTubePreview(0);
        closeYouTubePreview();
        finish({ ok: true, json: async () => ({
            candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist" }],
            suggested_video_id: "abcdefghijk"
        }) });
        await pending;
        return document.getElementById("youtubePreviewPlayer").innerHTML;
    })()`, app);
    assert.equal(result, "");
});

test("YouTube preview reports missing configuration and keeps the search link", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song & More", artist: "Artist" }];
        fetch = async () => ({ ok: false, json: async () => ({ detail: "YouTube previews require an API key." }) });
        await openYouTubePreview(0);
        return {
            status: document.getElementById("youtubePreviewStatus").textContent,
            link: document.getElementById("youtubePreviewSearchLink").href
        };
    })()`, app);
    assert.match(result.status, /require an API key/);
    assert.match(result.link, /Artist%20Song%20%26%20More/);
});

test("uncertain YouTube matches wait for tab focus and show duration-aware choices", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        let body;
        let focused = false;
        document.hasFocus = () => focused;
        YOUTUBE_PREVIEW_QUEUE = [{ id: "a", title: "Song", artist: "Artist", durationMs: 120000 }];
        fetch = async (url, options) => {
            body = JSON.parse(options.body);
            return { ok: true, json: async () => ({
                candidates: [
                    { video_id: "abcdefghijk", title: "Song", channel: "Artist", duration_seconds: 120, duration_match: true },
                    { video_id: "zyxwvutsrqp", title: "Interview", channel: "Artist", duration_seconds: 900, duration_match: false }
                ],
                suggested_video_id: null,
                warning: "No high-confidence match. Choose a result."
            }) };
        };
        await openYouTubePreview(0);
        const hiddenBefore = document.getElementById("youtubePreviewOptions").classList.contains("hidden");
        const playerBefore = document.getElementById("youtubePreviewPlayer").innerHTML;
        const pending = YOUTUBE_CHOICE_PENDING;
        focused = true;
        document.visibilityState = "hidden";
        revealPendingYouTubeChoices();
        const hiddenWhileInvisible = document.getElementById("youtubePreviewOptions").classList.contains("hidden");
        document.visibilityState = "visible";
        revealPendingYouTubeChoices();
        const displayed = !document.getElementById("youtubePreviewOptions").classList.contains("hidden");
        const choices = document.getElementById("youtubePreviewCandidates").innerHTML;
        const status = document.getElementById("youtubePreviewStatus").textContent;
        selectYouTubePreview(1);
        return { body, hiddenBefore, playerBefore, pending, hiddenWhileInvisible, displayed, choices, status,
            chosen: document.getElementById("youtubePreviewPlayer").innerHTML,
            pressed: document.getElementById("youtubePreviewOptions").open };
    })()`, app);
    assert.equal(result.body.duration_seconds, 120);
    assert.equal(result.hiddenBefore, true);
    assert.equal(result.playerBefore, "");
    assert.equal(result.pending, true);
    assert.equal(result.hiddenWhileInvisible, true);
    assert.equal(result.displayed, true);
    assert.match(result.choices, /2:00/);
    assert.match(result.choices, /15:00/);
    assert.match(result.choices, /Length differs/);
    assert.match(result.status, /No high-confidence/);
    assert.match(result.chosen, /zyxwvutsrqp/);
    assert.equal(result.pressed, false);
});

test("high-confidence YouTube matches load automatically without asking for a choice", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song", artist: "Artist", durationSeconds: 120 }];
        fetch = async () => ({ ok: true, json: async () => ({
            candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist", duration_seconds: 120, duration_match: true }],
            suggested_video_id: "abcdefghijk"
        }) });
        await openYouTubePreview(0, true);
        return { player: document.getElementById("youtubePreviewPlayer").innerHTML, pending: YOUTUBE_CHOICE_PENDING,
            expanded: document.getElementById("youtubePreviewOptions").open,
            title: document.getElementById("youtubePreviewOptionsTitle").textContent };
    })()`, app);
    assert.match(result.player, /abcdefghijk/);
    assert.equal(result.pending, false);
    assert.equal(result.expanded, false);
    assert.equal(result.title, "Other versions");
});

test("unknown catalog duration is not sent as the fallback four-minute duration", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        let body;
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song", artist: "Artist", durationMs: null, durationSeconds: 240, catalogMetadata: {} }];
        fetch = async (url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ candidates: [] }) }; };
        await openYouTubePreview(0);
        return body.duration_seconds;
    })()`, app);
    assert.equal(result, null);
});

test("pending choices are discarded if the preview is closed before focus returns", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        document.hasFocus = () => false;
        YOUTUBE_PREVIEW_QUEUE = [{ title: "Song", artist: "Artist" }];
        fetch = async () => ({ ok: true, json: async () => ({
            candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist", duration_seconds: null }],
            suggested_video_id: null
        }) });
        await openYouTubePreview(0);
        closeYouTubePreview();
        document.hasFocus = () => true;
        revealPendingYouTubeChoices();
        return { pending: YOUTUBE_CHOICE_PENDING, hidden: document.getElementById("youtubePreviewOptions").classList.contains("hidden") };
    })()`, app);
    assert.equal(result.pending, false);
    assert.equal(result.hidden, true);
});

test("onboarding reviews and saves a playlist, then restores it after refresh", async () => {
    const storage = new Map();
    const app = loadApp(storage);
    const result = await vm.runInContext(`(async () => {
        showToast = () => {};
        fetch = async () => ({ ok: true, json: async () => ({
            playlistName: "My list", source: "youtube", tracks: [
                { id: "a", title: "First", artist: "Artist", tags: [], durationSeconds: 100 },
                { id: "b", title: "Second", artist: "Artist", tags: [], durationSeconds: 100 }
            ]
        }) });
        document.getElementById("welcomePlaylistInput").value = "playlist-id";
        await importWelcomePlaylist();
        const before = sessionStorage.getItem("goalModeWelcomeComplete");
        removePlaylistPreviewTrack(0);
        completeWelcomePlaylist();
        return { before, saved: JSON.parse(sessionStorage.getItem("goalModeListenerProfile")), complete: sessionStorage.getItem("goalModeWelcomeComplete") };
    })()`, app);
    assert.equal(result.before, null);
    assert.equal(result.complete, "1");
    assert.equal(result.saved.playlist.tracks.length, 1);
    assert.equal(result.saved.playlist.tracks[0].title, "Second");
    assert.doesNotMatch(result.saved.tasteSummary, /First/);
    assert.match(result.saved.tasteSummary, /Second/);
    const refreshed = loadApp(storage);
    const restored = await vm.runInContext(`(async () => {
        showToast = () => {};
        await loadSavedListenerProfile();
        return { title: NORMALIZED_PLAYLIST.tracks[0].title, complete: sessionStorage.getItem("goalModeWelcomeComplete") };
    })()`, refreshed);
    assert.equal(restored.title, "Second");
    assert.equal(restored.complete, "1");
});

test("onboarding saves a synthetic listener, reports failures, and reset preserves history and chat", async () => {
    const storage = new Map();
    const app = loadApp(storage);
    const result = await vm.runInContext(`(async () => {
        showToast = () => {};
        document.getElementById("welcomeProfileInput").value = "8";
        fetch = async () => ({ ok: false, json: async () => ({ detail: "No listener" }) });
        await loadWelcomeProfile();
        const failure = document.getElementById("welcomeStatus").textContent;
        const incomplete = sessionStorage.getItem("goalModeWelcomeComplete");
        fetch = async () => ({ ok: true, json: async () => ({
            profile: { listener_id: 8, top_artist: "Artist", top_genre: "Rock", top_mood: "Calm" },
            tracks: [], artist_mapping_status: "unmatched", genre_mapping_status: "unmatched"
        }) });
        await loadWelcomeProfile();
        const saved = JSON.parse(sessionStorage.getItem("goalModeListenerProfile")).demoProfileId;
        sessionStorage.setItem("goalModePreviouslyRecommended", '["db:old"]');
        CHAT_HISTORY = [{ role: "user", content: "hello" }];
        LAST_RECOMMENDATION_DATA = { recommendations: [{ id: "db:old" }] };
        resetPersonalization();
        return { failure, incomplete, saved, profile: DEMO_PROFILE, stored: sessionStorage.getItem("goalModeListenerProfile"),
            complete: sessionStorage.getItem("goalModeWelcomeComplete"), history: sessionStorage.getItem("goalModePreviouslyRecommended"), chat: CHAT_HISTORY.length, queue: LAST_RECOMMENDATION_DATA };
    })()`, app);
    assert.match(result.failure, /No listener/);
    assert.equal(result.incomplete, null);
    assert.equal(result.saved, 8);
    assert.equal(result.profile, null);
    assert.equal(result.stored, null);
    assert.equal(result.complete, null);
    assert.equal(result.history, '["db:old"]');
    assert.equal(result.chat, 1);
    assert.equal(result.queue, null);
});

test("failed or abandoned playlist imports cannot complete onboarding", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        showToast = () => {};
        document.getElementById("welcomePlaylistInput").value = "list";
        fetch = async () => ({ ok: false, json: async () => ({ detail: "Import failed" }) });
        await importWelcomePlaylist();
        const failure = document.getElementById("welcomeStatus").textContent;
        const incomplete = sessionStorage.getItem("goalModeWelcomeComplete");
        let finish;
        fetch = () => new Promise(resolve => { finish = resolve; });
        const pending = importWelcomePlaylist();
        completeWelcome();
        finish({ ok: true, json: async () => ({ playlistName: "Late", tracks: [{ id: "a", title: "Song", artist: "Artist", tags: [] }] }) });
        await pending;
        return { failure, incomplete, playlist: PENDING_PLAYLIST, completed: sessionStorage.getItem("goalModeWelcomeComplete") };
    })()`, app);
    assert.match(result.failure, /Import failed/);
    assert.equal(result.incomplete, null);
    assert.equal(result.playlist, null);
    assert.equal(result.completed, "1");
});

test("a saved synthetic listener is restored for the same browser session", async () => {
    const storage = new Map([
        ["goalModeWelcomeComplete", "1"],
        ["goalModeListenerProfile", JSON.stringify({ demoProfileId: 7 })]
    ]);
    const app = loadApp(storage);
    const result = await vm.runInContext(`(async () => {
        showToast = () => {};
        fetch = async () => ({ ok: true, json: async () => ({
            profile: { listener_id: 7, top_artist: "Artist", top_genre: "Rock", top_mood: "Calm" },
            tracks: [], artist_mapping_status: "unmatched", genre_mapping_status: "unmatched"
        }) });
        await loadSavedListenerProfile();
        return { id: DEMO_PROFILE.profile.listener_id, status: document.getElementById("profileSaveStatus").textContent };
    })()`, app);
    assert.equal(result.id, 7);
    assert.match(result.status, /Restored/);
});

test("player completion and skip advance without accepting stale events", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        const players = [];
        window.YT.Player = function(id, options) {
            this.events = options.events;
            this.playVideo = () => { this.played = true; };
            this.destroy = () => { this.destroyed = true; };
            players.push(this);
        };
        YOUTUBE_PREVIEW_QUEUE = [{ id: "a", title: "First", artist: "A" }, { id: "b", title: "Second", artist: "B" }, { id: "c", title: "Third", artist: "C" }];
        fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist" }], suggested_video_id: "abcdefghijk" }) });
        await openYouTubePreview(0);
        await Promise.resolve();
        players[0].events.onStateChange({ data: 0 });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        players[0].events.onStateChange({ data: 0 });
        players[1].events.onReady({ target: players[1] });
        const autoplay = players[1].played;
        skipCurrentYouTubeTrack();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        players[2].events.onAutoplayBlocked();
        const blocked = document.getElementById("youtubePreviewStatus").textContent;
        players[2].events.onStateChange({ data: 0 });
        return { states: Array.from(YOUTUBE_QUEUE_STATES.entries()), autoplay, blocked,
            status: document.getElementById("youtubePreviewStatus").textContent, active: YOUTUBE_ACTIVE_TRACK_ID };
    })()`, app);
    assert.deepEqual(JSON.parse(JSON.stringify(result.states)), [["a", "finished"], ["b", "skipped"], ["c", "finished"]]);
    assert.equal(result.autoplay, true);
    assert.match(result.blocked, /Autoplay was blocked/);
    assert.match(result.status, /end of the queue/);
    assert.equal(result.active, null);
});

test("partial queue updates retain progress and advance when another track arrives", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        showToast = () => {};
        CATALOG_ITEMS = [
            { id: "db:1", title: "First", artist: "A", duration: 4, tags: [] },
            { id: "db:2", title: "Second", artist: "B", duration: 4, tags: [] }
        ];
        fetch = async () => ({ ok: true, json: async () => ({ candidates: [], suggested_video_id: null }) });
        renderResults({ recommendations: [{ content_id: "db:1" }] }, 8, true);
        await openYouTubePreview(0);
        skipCurrentYouTubeTrack();
        const waiting = document.getElementById("youtubePreviewStatus").textContent;
        renderResults({ recommendations: [{ content_id: "db:1" }, { content_id: "db:2" }] }, 8, true);
        await Promise.resolve(); await Promise.resolve();
        return { waiting, state: YOUTUBE_QUEUE_STATES.get("db:1"), active: YOUTUBE_ACTIVE_TRACK_ID, label: document.getElementById("queue-state-0").textContent,
            noMatch: document.getElementById("youtubePreviewStatus").textContent };
    })()`, app);
    assert.match(result.waiting, /Waiting/);
    assert.equal(result.state, "skipped");
    assert.equal(result.active, "db:2");
    assert.equal(result.label, "Skipped");
    assert.match(result.noMatch, /No embeddable/);
});

test("an off-screen next player and an unplayable video remain actionable without marking it finished", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        const players = [];
        window.YT.Player = function(id, options) {
            this.events = options.events;
            this.playVideo = () => { this.played = true; };
            this.destroy = () => {};
            players.push(this);
        };
        YOUTUBE_PREVIEW_QUEUE = [{ id: "a", title: "First", artist: "A" }, { id: "b", title: "Second", artist: "B" }];
        fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist" }], suggested_video_id: "abcdefghijk" }) });
        await openYouTubePreview(0);
        await Promise.resolve();
        skipCurrentYouTubeTrack();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        document.getElementById("youtubePreviewPlayer").getBoundingClientRect = () => ({ left: 0, top: 1000, right: 400, bottom: 1225, width: 400, height: 225 });
        players[1].events.onReady({ target: players[1] });
        const offscreen = document.getElementById("youtubePreviewStatus").textContent;
        players[1].events.onError();
        return { offscreen, played: !!players[1].played, error: document.getElementById("youtubePreviewStatus").textContent, state: YOUTUBE_QUEUE_STATES.get("b") };
    })()`, app);
    assert.match(result.offscreen, /Press play/);
    assert.equal(result.played, false);
    assert.match(result.error, /Choose another result or skip/);
    assert.equal(result.state, undefined);
});

test("player API loading failures are surfaced and do not mark the track finished", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        delete window.YT;
        window.setTimeout = () => 1;
        window.clearTimeout = () => {};
        let script;
        document.createElement = () => ({ remove() {} });
        document.head = { appendChild(element) { script = element; } };
        YOUTUBE_PREVIEW_QUEUE = [{ id: "a", title: "Song", artist: "Artist" }];
        fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ video_id: "abcdefghijk", title: "Song", channel: "Artist" }], suggested_video_id: "abcdefghijk" }) });
        await openYouTubePreview(0);
        script.onerror();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { status: document.getElementById("youtubePreviewStatus").textContent, state: YOUTUBE_QUEUE_STATES.get("a") };
    })()`, app);
    assert.match(result.status, /Automatic queue advancement is unavailable/);
    assert.equal(result.state, undefined);
});

test("chat unwraps a JSON response without losing its suggestions", () => {
    const app = loadApp();
    const result = vm.runInContext(`normalizeChatResponse({
        reply: '\\x60\\x60\\x60json\\n' + JSON.stringify({
            reply: '**A great pick.**',
            extracted_taste_insights: ['Likes indie'],
            suggested_recommender_action: { goal: 'Indie', budget: 30, exclusions: '' }
        }) + '\\n\\x60\\x60\\x60',
        extracted_taste_insights: [],
        suggested_recommender_action: null
    })`, app);
    assert.equal(result.reply, "**A great pick.**");
    assert.equal(result.extracted_taste_insights[0], "Likes indie");
    assert.equal(result.suggested_recommender_action.goal, "Indie");
    assert.equal(vm.runInContext('normalizeChatResponse({ reply: "A plain reply." }).reply', app), "A plain reply.");
});

test("chat recovers a malformed reply with unescaped quotes and preserves metadata", () => {
    const app = loadApp();
    const result = vm.runInContext(`normalizeChatResponse({
        reply: '{"reply": "Try "I Love You So".", "extracted_taste_insights": ["Likes indie"], "suggested_recommender_action": {"goal":"Focus", "budget":30}}'
    })`, app);
    assert.equal(result.reply, 'Try "I Love You So".');
    assert.equal(result.extracted_taste_insights[0], "Likes indie");
    assert.equal(result.suggested_recommender_action.goal, "Focus");
});

test("chat retries malformed JSON rather than showing it to the listener", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        let calls = 0;
        requestAiJson = async instruction => {
            calls++;
            if (calls === 1) return {
                reply: '{"reply": "A truncated response'
            };
            return { reply: '**Try** I Love You So.', instruction };
        };
        const response = await requestChatResponse("Initial instruction", "Hello");
        return { calls, reply: response.reply, instruction: response.instruction };
    })()`, app);
    assert.equal(result.calls, 2);
    assert.equal(result.reply, "**Try** I Love You So.");
    assert.match(result.instruction, /escape all quotation marks/i);
});

test("chat surfaces an error after repeated invalid responses", async () => {
    const app = loadApp();
    await assert.rejects(vm.runInContext(`(async () => {
        requestAiJson = async () => ({ reply: '{"reply": "A truncated response' });
        return requestChatResponse("Initial instruction", "Hello");
    })()`, app), /malformed chat JSON/);
});

test("chat keeps answering follow-ups even when a correct answer repeats", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        DEMO_PROFILE = { profile: { top_artist: "Example Artist", top_genre: "Rock", top_mood: "Calm" }, tracks: [] };
        const messages = [];
        const instructions = [];
        const prompts = [];
        appendMessageToFeed = (role, text) => messages.push({ role, text });
        requestAiJson = async (instruction, prompt) => {
            instructions.push(instruction);
            prompts.push(prompt);
            return { reply: "The sample profile's top artist is Example Artist." };
        };
        document.getElementById("chatTextInput").value = "Tell me about my taste.";
        await sendChatMessage();
        document.getElementById("chatTextInput").value = "Who is it again?";
        await sendChatMessage();
        return { messages, instructions, prompts, history: CHAT_HISTORY };
    })()`, app);
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[3].text, "The sample profile's top artist is Example Artist.");
    assert.equal(result.history.length, 4);
    assert.equal(result.prompts.length, 2);
    assert.match(result.prompts[1], /Top artist: Example Artist/);
    assert.match(result.prompts[1], /CONVERSATION HISTORY:[\s\S]*Tell me about my taste/);
    assert.match(result.instructions[0], /not evidence about the listener's real favorite artist/);
});

test("direct top and favorite artist questions use the sample field without guessing", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        const messages = [];
        appendMessageToFeed = (role, text) => messages.push({ role, text });
        requestAiJson = async () => { throw new Error("Unexpected AI request"); };
        DEMO_PROFILE = { profile: { top_artist: "Example Artist", top_genre: "Rock", top_mood: "Calm" }, tracks: [] };
        document.getElementById("chatTextInput").value = "Who is my top artist currently?";
        await sendChatMessage();
        document.getElementById("chatTextInput").value = "Who is my favorite artist?";
        await sendChatMessage();
        DEMO_PROFILE = null;
        document.getElementById("chatTextInput").value = "What is my top artist?";
        await sendChatMessage();
        return messages;
    })()`, app);
    assert.match(result[1].text, /sample profile.*Example Artist/);
    assert.match(result[1].text, /synthetic/);
    assert.match(result[3].text, /sample profile.*Example Artist/);
    assert.match(result[5].text, /don't have an account-based top artist/);
});

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
    assert.match(result.queue, /openYouTubePreview\(0\)/);
    assert.doesNotMatch(result.queue, /Rufus Wainwright/);
    assert.equal(result.duration, "12:00 / 20:00");
});

test("queue cards label broader fallback and expose an accessible YouTube play action", () => {
    const app = loadApp();
    const queue = vm.runInContext(`(() => {
        CATALOG_ITEMS = [{ id: "db:1", title: 'A "Song"', artist: "Artist", duration: 4, tags: [] }];
        renderResults({ recommendations: [{ content_id: "db:1", source: "broad_fill", reason: "Broader catalog fallback" }] }, 10, true);
        return document.getElementById("queueList").innerHTML;
    })()`, app);
    assert.match(queue, /Broader fill/);
    assert.match(queue, /aria-label="Play A &quot;Song&quot; on YouTube"/);
    assert.match(queue, /Broader catalog fallback/);
});

test("pending chat preferences remain visible when session details are collapsed", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        PENDING_TASTE_INSIGHTS = ["Likes jazz"];
        renderPendingTasteInsights();
        const pending = document.getElementById("chatPendingBadge").textContent;
        PENDING_TASTE_INSIGHTS = [];
        renderPendingTasteInsights();
        return { pending, cleared: document.getElementById("chatPendingBadge").textContent };
    })()`, app);
    assert.equal(result.pending, "1 to review");
    assert.equal(result.cleared, "");
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

test("a sample top-artist request uses its artist and never fills with unrelated tracks", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        DEMO_PROFILE = {
            profile: { top_artist: "Alice", top_genre: "Pop", top_mood: "Calm" },
            tracks: [
                { catalog_track_id: "seed", title: "Sample Song", artist: "Alice" },
                { catalog_track_id: "heard", title: "Already Heard", artist: "Alice" },
                { catalog_track_id: "genre", title: "Genre Reference", artist: "Other" }
            ]
        };
        PLAYLIST_ITEMS = [{ id: "yt1", title: "Already Heard", artist: "Alice" }];
        getPreviouslyRecommendedIds = () => ["db:old"];
        getPreviouslyRecommendedTracks = () => [{ id: "db:old", title: "Old Song", artist: "Alice" }];
        document.getElementById("goalTextInput").value = "Songs by my top artist";
        document.getElementById("budgetInput").value = "30";
        document.getElementById("exclusionsInput").value = "holiday";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        refreshChatContextDisplay = () => {};
        const requests = [];
        fetchCatalogCandidates = async (goal, exclusions, offset) => {
            requests.push({ goal, offset });
            const row = (id, title, artist) => ({ catalog_track_id: id, title, artist, duration_ms: 240000, genre: "pop" });
            return { goal_candidates: [
                row("seed", "Sample Song", "Alice"), row("heard", "Already Heard", "Alice"),
                row("old", "Old Song", "Alice"), row("holiday", "Holiday Song", "Alice"),
                row("other", "Other Song", "Other"), row("new", "Another Song", "Alice, Guest")
            ], fallback_candidates: [row("fallback", "Popular Song", "Other")], next_offset: 100 };
        };
        requestAiJson = async () => ({ recommendations: [] });
        await generateGoalQueue();
        return { requests, result: LAST_RECOMMENDATION_DATA };
    })()`, app);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].goal, "Songs by Alice");
    assert.deepEqual(Array.from(result.result.recommendations, item => item.id), ["db:seed", "db:new"]);
    assert.match(result.result.ai_comment, /sample's top artist, Alice/);
    assert.match(result.result.ai_comment, /5 returned tracks credit that artist; 1 was excluded by recommendation history/);
    assert.match(result.result.ai_comment, /did not return enough eligible audio/);
});

test("repeated sample-artist requests explain history and can clear it without clearing the profile or playlist", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        DEMO_PROFILE = {
            profile: { top_artist: "Alice", top_genre: "Pop", top_mood: "Calm" },
            tracks: [{ catalog_track_id: "seed", title: "Sample Song", artist: "Alice" }]
        };
        PLAYLIST_ITEMS = [{ id: "yt1", title: "Heard Song", artist: "Alice" }];
        sessionStorage.setItem("goalModeListenerProfile", "keep");
        document.getElementById("goalTextInput").value = "Songs by my top artist";
        document.getElementById("budgetInput").value = "4";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        refreshChatContextDisplay = () => {};
        fetchCatalogCandidates = async () => ({ goal_candidates: [
            { catalog_track_id: "seed", title: "Sample Song", artist: "Alice", duration_ms: 240000 }
        ], fallback_candidates: [], next_offset: null });
        requestAiJson = async () => ({ recommendations: [] });
        await generateGoalQueue();
        await generateGoalQueue();
        const second = { count: LAST_RECOMMENDATION_DATA.recommendations.length, note: LAST_RECOMMENDATION_DATA.ai_comment };
        confirm = () => false;
        clearRecommendationHistory();
        const retained = sessionStorage.getItem("goalModePreviouslyRecommended");
        confirm = () => true;
        clearRecommendationHistory();
        const cleared = sessionStorage.getItem("goalModePreviouslyRecommended");
        const profile = sessionStorage.getItem("goalModeListenerProfile");
        const playlistCount = PLAYLIST_ITEMS.length;
        const sample = DEMO_PROFILE.profile.top_artist;
        await generateGoalQueue();
        return { second, retained, cleared, profile, playlistCount, sample, third: LAST_RECOMMENDATION_DATA.recommendations.map(item => item.id) };
    })()`, app);
    assert.equal(result.second.count, 0);
    assert.match(result.second.note, /1 returned track credits that artist; 1 was excluded by recommendation history/);
    assert.match(result.retained, /db:seed/);
    assert.equal(result.cleared, null);
    assert.equal(result.profile, "keep");
    assert.equal(result.playlistCount, 1);
    assert.equal(result.sample, "Alice");
    assert.deepEqual(Array.from(result.third), ["db:seed"]);
});

test("a direct top-artist request without a sample does not fall back to random tracks", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        document.getElementById("goalTextInput").value = "Songs by my top artist";
        document.getElementById("budgetInput").value = "30";
        let message = "";
        showToast = text => { message = text; };
        fetchCatalogCandidates = async () => { throw new Error("Unexpected catalog search"); };
        await generateGoalQueue();
        return message;
    })()`, app);
    assert.match(result, /Load a sample profile or name an artist/);
});

test("similar-to-top-artist goals retain normal discovery", async () => {
    const app = loadApp();
    const result = await vm.runInContext(`(async () => {
        DEMO_PROFILE = { profile: { top_artist: "Alice" }, tracks: [] };
        document.getElementById("goalTextInput").value = "Songs similar to my top artist";
        document.getElementById("budgetInput").value = "4";
        showToast = () => {};
        setLoading = () => {};
        renderCatalogTable = () => {};
        refreshChatContextDisplay = () => {};
        let goal;
        fetchCatalogCandidates = async text => {
            goal = text;
            return { goal_candidates: [], fallback_candidates: [
                { catalog_track_id: "other", title: "Other Song", artist: "Other", duration_ms: 240000, genre: "pop" }
            ], next_offset: null };
        };
        requestAiJson = async () => ({ recommendations: [] });
        await generateGoalQueue();
        return { goal, ids: LAST_RECOMMENDATION_DATA.recommendations.map(item => item.id) };
    })()`, app);
    assert.equal(result.goal, "Songs similar to my top artist");
    assert.deepEqual(Array.from(result.ids), ["db:other"]);
});

test("partial queue rendering keeps items visible and does not record unfinished selections", () => {
    const app = loadApp();
    const result = vm.runInContext(`(() => {
        CATALOG_ITEMS = [{ id: "db:1", title: "Partial Song", artist: "Artist", duration: 4, durationMs: 240000, cover: "", tags: [] }];
        LAST_RECOMMENDATION_DATA = null;
        setLoading(true);
        setGenerationProgress(55, "AI ranking pass 2 of 3", "1 track selected");
        renderResults({
            normalized_goal: "Specific Artist",
            preferred_topics: ["Specific Artist"],
            excluded_topics: [],
            recommendations: [{ content_id: "db:1", reason: "Selected by the current pass." }],
            status: "generating",
            ai_comment: "Generation is still in progress."
        }, 30, true);
        return {
            percent: document.getElementById("loadingProgressPercent").textContent,
            title: document.getElementById("loadingStateTitle").textContent,
            queueText: document.getElementById("queueList").textContent,
            chatReady: LAST_RECOMMENDATION_DATA
        };
    })()`, app);
    assert.equal(result.percent, "55%");
    assert.equal(result.title, "AI ranking pass 2 of 3");
    assert.equal(result.chatReady, null);
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
    assert.match(result.before, /Sample reference/);
    assert.doesNotMatch(result.after, /Sample reference/);
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

