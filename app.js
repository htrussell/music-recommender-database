// Global state
        let CATALOG_ITEMS = [];
        let PLAYLIST_ITEMS = [];
        let playlistPreferenceSummary = "";
        let playlistVideoIds = new Set();
        let NORMALIZED_PLAYLIST = null;
        let PENDING_PLAYLIST = null;
        let CHAT_HISTORY = [];
        let CHAT_TASTE_INSIGHTS = [];
        let LAST_RECOMMENDATION_DATA = null;

        function escapeHtml(value) {
            return String(value ?? "").replace(/[&<>"']/g, character => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;"
            })[character]);
        }

        function safeHttpsUrl(value) {
            try {
                const parsed = new URL(value);
                return parsed.protocol === "https:" ? parsed.href : "";
            } catch {
                return "";
            }
        }

        function hasListenerConsent() {
            const consent = document.getElementById("listenerConsentCheck");
            if (!consent?.checked) {
                showToast("Please provide consent before importing or saving listener data.", "warning");
                return false;
            }
            try {
                sessionStorage.setItem("goalModeListenerConsent", "true");
            } catch (err) {
                showToast(`Could not store consent for this browser session: ${err.message}`, "error");
                return false;
            }
            return true;
        }

        // Preset Scenarios
        const SCENARIOS = {
            1: {
                goal: "Find new indie and alternative music with atmospheric guitars and thoughtful lyrics, similar to my playlist, under 30 minutes.",
                budget: 30,
                exclusions: "country, holiday music"
            },
            2: {
                goal: "Build a calm focus queue of ambient, downtempo, and instrumental electronic music similar to my playlist, under 30 minutes.",
                budget: 30,
                exclusions: "vocals, heavy metal"
            },
            3: {
                goal: "I'm looking for a playlist with some content outside my recommendations. Can you recommend music similar to \"Danse Macabre\"?",
                budget: 30,
                exclusions: ""
            }
        };

        // Initialize UI on load
        window.onload = function() {
            renderCatalogTable();
            setupCharCounter();
            loadSavedListenerProfile();
            document.getElementById("listenerConsentCheck").addEventListener("change", event => {
                if (event.target.checked) {
                    try {
                        sessionStorage.setItem("goalModeListenerConsent", "true");
                    } catch (err) {
                        event.target.checked = false;
                        showToast(`Could not store consent for this browser session: ${err.message}`, "error");
                    }
                } else {
                    clearListenerData(true);
                }
            });
            checkLocalAiStatus();
            loadScenario(1);
        };

        async function checkLocalAiStatus() {
            const badge = document.getElementById("apiStatusBadge");
            try {
                const response = await fetch("/healthz");
                if (!response.ok) throw new Error(`AI service HTTP ${response.status}`);
                const data = await response.json();
                badge.className = "bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 px-2 py-0.5 rounded text-[10px] flex items-center";
                badge.innerHTML = `<i class="fa-solid fa-microchip mr-1"></i> ${escapeHtml(data.model)} ready`;
            } catch (err) {
                badge.className = "bg-red-900/50 text-red-300 border border-red-700/50 px-2 py-0.5 rounded text-[10px] flex items-center";
                badge.textContent = "Local AI unavailable";
            }
        }

        function switchTab(tabId) {
            const protoView = document.getElementById("prototypeTabView");
            const overviewView = document.getElementById("overviewTabView");
            const chatView = document.getElementById("chatTabView");
            const protoBtn = document.getElementById("tabBtnPrototype");
            const overviewBtn = document.getElementById("tabBtnOverview");
            const chatBtn = document.getElementById("tabBtnChat");

            const activeClass = "px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white shadow-md transition flex items-center space-x-2";
            const inactiveClass = "px-4 py-2 text-xs font-semibold rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition flex items-center space-x-2 border border-slate-700";

            protoView.classList.add("hidden");
            overviewView.classList.add("hidden");
            chatView.classList.add("hidden");
            protoBtn.className = inactiveClass;
            overviewBtn.className = inactiveClass;
            chatBtn.className = inactiveClass;

            if (tabId === "prototype") {
                protoView.classList.remove("hidden");
                protoBtn.className = activeClass;
            } else if (tabId === "overview") {
                overviewView.classList.remove("hidden");
                overviewBtn.className = activeClass;
            } else if (tabId === "chat") {
                chatView.classList.remove("hidden");
                chatBtn.className = activeClass;
                const dot = document.getElementById("chatContextDot");
                if (dot) dot.classList.add("hidden");
                refreshChatContextDisplay();
            }
        }

        function showToast(message, type = "info") {
            const container = document.getElementById("toastContainer");
            if (!container) return;
            const toast = document.createElement("div");
            const colors = {
                success: "bg-emerald-950/90 text-emerald-200 border-emerald-700",
                error: "bg-red-950/90 text-red-200 border-red-700",
                warning: "bg-amber-950/90 text-amber-200 border-amber-700",
                info: "bg-slate-800/95 text-slate-200 border-slate-700"
            };
            const icons = {
                success: "fa-circle-check text-emerald-400",
                error: "fa-circle-xmark text-red-400",
                warning: "fa-triangle-exclamation text-amber-400",
                info: "fa-circle-info text-blue-400"
            };
            toast.className = `flex items-start space-x-2.5 p-3 rounded-lg border shadow-xl backdrop-blur text-xs pointer-events-auto transition-all duration-300 opacity-0 translate-y-2 ${colors[type] || colors.info}`;
            toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info} mt-0.5 text-sm flex-shrink-0"></i>`;
            const messageElement = document.createElement("div");
            messageElement.className = "flex-1 font-medium leading-relaxed";
            messageElement.textContent = message;
            toast.appendChild(messageElement);
            container.appendChild(toast);
            requestAnimationFrame(() => {
                toast.classList.remove("opacity-0", "translate-y-2");
            });
            setTimeout(() => {
                toast.classList.add("opacity-0", "translate-y-2");
                setTimeout(() => toast.remove(), 300);
            }, 4200);
        }

        function setupCharCounter() {
            const textarea = document.getElementById("goalTextInput");
            const counter = document.getElementById("charCounter");
            if (!textarea || !counter) return;
            textarea.addEventListener("input", () => {
                counter.textContent = `${textarea.value.length} / 500`;
            });
        }

        function loadScenario(num) {
            const scenario = SCENARIOS[num];
            if (!scenario) return;
            document.getElementById("goalTextInput").value = scenario.goal;
            document.getElementById("budgetInput").value = scenario.budget;
            document.getElementById("exclusionsInput").value = scenario.exclusions;
            document.getElementById("charCounter").textContent = `${scenario.goal.length} / 500`;
            showToast(`Loaded Preset Scenario ${num}`, "info");
        }

        function renderCatalogTable() {
            const tbody = document.getElementById("catalogTableBody");
            if (!CATALOG_ITEMS.length) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="p-6 text-center text-slate-500 italic">
                            No candidate recommendations loaded yet. Enter a YouTube playlist or click "Generate Goal Queue" to curate directly from your prompt.
                        </td>
                    </tr>
                `;
                return;
            }
            tbody.innerHTML = CATALOG_ITEMS.map(item => `
                <tr class="hover:bg-slate-800/50 transition">
                    <td class="p-2.5">
                        <img data-catalog-id="${escapeHtml(item.id)}"
                             src="${escapeHtml(safeHttpsUrl(item.cover) || `https://placehold.co/80x80/1e293b/64748b?text=Music`)}"
                             alt="${escapeHtml(item.title)}"
                             class="w-10 h-10 rounded object-cover border border-slate-700 bg-slate-800 flex-shrink-0 shadow-sm"
                             onerror="this.src='https://placehold.co/80x80/1e293b/64748b?text=Music'">
                    </td>
                    <td class="p-2.5 font-mono text-blue-400 font-medium text-[11px]">${escapeHtml(item.id)}</td>
                    <td class="p-2.5 font-medium text-slate-200">
                        ${escapeHtml(item.title)}
                        ${item.tags.includes("outside-discovery") || item.tags.includes("prompt-curated") ? '<span class="ml-1.5 bg-purple-900/60 text-purple-300 border border-purple-700/50 text-[9px] px-1.5 py-0.5 rounded font-sans inline-flex items-center"><i class="fa-solid fa-sparkles text-purple-400 text-[8px] mr-1"></i>Prompt Match</span>' : ''}
                        ${item.tags.includes("budget-filler") ? '<span class="ml-1.5 bg-cyan-900/60 text-cyan-300 border border-cyan-700/50 text-[9px] px-1.5 py-0.5 rounded font-sans inline-flex items-center"><i class="fa-solid fa-stopwatch text-cyan-400 text-[8px] mr-1"></i>Budget Fill</span>' : ''}
                        ${item.tags.includes("popular-track") ? '<span class="ml-1.5 bg-amber-900/60 text-amber-300 border border-amber-700/50 text-[9px] px-1.5 py-0.5 rounded font-sans inline-flex items-center"><i class="fa-solid fa-fire text-amber-400 text-[8px] mr-1"></i>Popular Hit</span>' : ''}
                    </td>
                    <td class="p-2.5 text-slate-300">${escapeHtml(item.artist)}</td>
                    <td class="p-2.5"><span class="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[10px] border border-slate-700">${escapeHtml(item.category)}</span></td>
                    <td class="p-2.5 text-slate-400 text-[11px] max-w-xs truncate">${escapeHtml(item.tags.join(", "))}</td>
                </tr>
            `).join("");
        }

        function renderPlaylistHistory() {
            const container = document.getElementById("playlistHistoryList");
            document.getElementById("playlistHistoryStatus").textContent = PLAYLIST_ITEMS.length
                ? `${PLAYLIST_ITEMS.length} tracks from ${NORMALIZED_PLAYLIST?.playlistName || "playlist"}`
                : "Import and confirm a playlist to populate";
            if (!PLAYLIST_ITEMS.length) {
                container.innerHTML = `<p class="col-span-full text-center text-xs text-slate-500 py-4">No playlist has been confirmed for this session.</p>`;
                return;
            }
            container.innerHTML = PLAYLIST_ITEMS.map(item => `
                <div class="bg-slate-900/70 border border-slate-700/80 rounded-lg p-2.5 flex items-center space-x-3">
                    <img src="${escapeHtml(safeHttpsUrl(item.cover) || `https://placehold.co/80x80/1e293b/64748b?text=Music`)}" alt="${escapeHtml(item.title)}"
                         class="w-11 h-11 rounded object-cover border border-slate-700 flex-shrink-0 bg-slate-800 shadow"
                         onerror="this.src='https://placehold.co/80x80/1e293b/64748b?text=Music'">
                    <div class="overflow-hidden flex-1">
                        <p class="text-xs font-medium text-slate-200 truncate">${escapeHtml(item.title)}</p>
                        <p class="text-[11px] text-amber-300 truncate mt-0.5">${escapeHtml(item.artist || "Unknown artist")}</p>
                        <span class="inline-block text-[9px] text-slate-400 font-mono mt-0.5">${item.duration}m</span>
                    </div>
                </div>
            `).join("");
        }

        function parseDuration(isoDuration) {
            const match = (isoDuration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (!match) return 0;
            return Math.max(1, Math.ceil((Number(match[1] || 0) * 60) + Number(match[2] || 0) + (Number(match[3] || 0) / 60)));
        }

        function parseDurationSeconds(isoDuration) {
            const match = (isoDuration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (!match) return 0;
            return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
        }

        function normalizeSongKey(title) {
            return (title || "").toLowerCase()
                .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
                .replace(/\b(official|audio|video|lyrics?|lyric video|live|remaster(ed)?|visualizer|music video|hd|4k|extended|edit|version|remix|cover|instrumental|sped|slowed)\b/g, " ")
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }

        function normalizePlaylistJson(data, source, fallbackName) {
            const tracks = Array.isArray(data) ? data : data?.tracks;
            if (!Array.isArray(tracks) || !tracks.length) {
                throw new Error("Playlist JSON must be an array of tracks or an object with a non-empty tracks array.");
            }
            if (tracks.length > 1000) throw new Error("Playlist JSON is limited to 1,000 tracks.");

            const normalizedTracks = tracks.map((track, index) => {
                if (!track || typeof track !== "object" || Array.isArray(track)) {
                    throw new Error(`Track ${index + 1} must be a JSON object.`);
                }
                const title = String(track.title || track.name || "").trim();
                if (!title) throw new Error(`Track ${index + 1} is missing a title.`);
                const secondsFromField = Number(track.durationSeconds);
                const durationSeconds = Number.isFinite(secondsFromField) && secondsFromField >= 0
                    ? secondsFromField
                    : (typeof track.duration === "string" && /^PT/i.test(track.duration)
                        ? parseDurationSeconds(track.duration)
                        : 0);
                const tags = Array.isArray(track.tags)
                    ? track.tags.filter(tag => typeof tag === "string").map(tag => tag.trim()).filter(Boolean)
                    : [];
                return {
                    id: String(track.id || track.videoId || `json:${normalizeSongKey(`${track.artist || track.channelTitle || ""} ${title}`)}:${index}`),
                    title,
                    artist: String(track.artist || track.artistOrChannel || track.channelTitle || "Unknown artist").trim(),
                    durationSeconds,
                    url: safeHttpsUrl(track.url || track.videoUrl || ""),
                    cover: safeHttpsUrl(track.cover || track.thumbnail || ""),
                    tags
                };
            });

            return {
                source,
                playlistName: String(Array.isArray(data) ? fallbackName : (data.playlistName || data.name || fallbackName)).trim(),
                tracks: normalizedTracks
            };
        }

        function createTasteSummary(tracks) {
            const channelCounts = new Map();
            for (const track of tracks) {
                const artist = track.artist || "Unknown artist";
                channelCounts.set(artist, (channelCounts.get(artist) || 0) + 1);
            }
            const frequentArtists = [...channelCounts.entries()]
                .sort((left, right) => right[1] - left[1])
                .slice(0, 5)
                .map(([artist]) => artist);
            const examples = tracks.slice(0, 4).map(track => `"${track.title}"`).join(", ");
            return `Playlist of ${tracks.length} tracks. Frequent artists or channels: ${frequentArtists.join(", ")}. Examples: ${examples}.`;
        }

        function setPlaylistReview(playlist) {
            PENDING_PLAYLIST = {
                ...playlist,
                playlistName: playlist.playlistName || "Imported playlist",
                importedAt: new Date().toISOString()
            };
            const summaryInput = document.getElementById("listenerTasteSummary");
            if (!summaryInput.value.trim()) summaryInput.value = createTasteSummary(PENDING_PLAYLIST.tracks);
            document.getElementById("playlistReviewPanel").classList.remove("hidden");
            document.getElementById("playlistReviewTitle").textContent = PENDING_PLAYLIST.playlistName;
            renderPlaylistReview();
        }

        function renderPlaylistReview() {
            const container = document.getElementById("playlistReviewTracks");
            const tracks = PENDING_PLAYLIST?.tracks || [];
            document.getElementById("playlistReviewCount").textContent = `${tracks.length} tracks • ${PENDING_PLAYLIST?.source || "not imported"}`;
            document.getElementById("playlistJsonPreview").textContent = JSON.stringify(PENDING_PLAYLIST, null, 2);
            document.getElementById("confirmPlaylistBtn").disabled = !tracks.length;
            container.innerHTML = tracks.map((track, index) => `
                <div class="flex items-center gap-2 rounded bg-slate-950/70 px-2 py-1.5 text-[10px]">
                    <span class="min-w-0 flex-1 truncate text-slate-200">${escapeHtml(track.title)} <span class="text-slate-400">— ${escapeHtml(track.artist)}</span></span>
                    <span class="shrink-0 text-slate-500">${track.durationSeconds ? `${Math.ceil(track.durationSeconds / 60)}m` : "duration n/a"}</span>
                    <button type="button" aria-label="Remove ${escapeHtml(track.title)}" onclick="removePlaylistPreviewTrack(${index})" class="shrink-0 px-1 text-red-300 hover:text-red-200">Remove</button>
                </div>
            `).join("") || `<p class="text-center text-[10px] text-slate-500 py-2">No tracks remain. Import another playlist.</p>`;
        }

        function removePlaylistPreviewTrack(index) {
            if (!PENDING_PLAYLIST || !Number.isInteger(index) || index < 0 || index >= PENDING_PLAYLIST.tracks.length) return;
            PENDING_PLAYLIST.tracks.splice(index, 1);
            renderPlaylistReview();
        }

        function confirmPlaylistReview() {
            if (!hasListenerConsent() || !PENDING_PLAYLIST?.tracks.length) return;
            NORMALIZED_PLAYLIST = JSON.parse(JSON.stringify(PENDING_PLAYLIST));
            PLAYLIST_ITEMS = NORMALIZED_PLAYLIST.tracks.map(track => ({
                ...track,
                category: "Music",
                duration: track.durationSeconds ? Math.max(1, Math.ceil(track.durationSeconds / 60)) : 4,
                tags: [...new Set(["already-on-playlist", ...track.tags])]
            }));
            playlistVideoIds = new Set(PLAYLIST_ITEMS.map(track => track.id));
            playlistPreferenceSummary = document.getElementById("listenerTasteSummary").value.trim();
            CATALOG_ITEMS = PLAYLIST_ITEMS.map(track => ({
                ...track,
                id: `playlist:${track.id}`,
                tags: [...track.tags, "playlist-seed", "taste-signal"]
            }));
            document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} playlist tracks available as candidates`;
            renderPlaylistHistory();
            renderCatalogTable();
            refreshChatContextDisplay();
            showToast(`Using ${PLAYLIST_ITEMS.length} reviewed tracks from "${NORMALIZED_PLAYLIST.playlistName}".`, "success");
        }

        async function loadPlaylistJsonFile() {
            if (!hasListenerConsent()) return;
            const fileInput = document.getElementById("playlistJsonFileInput");
            const file = fileInput.files?.[0];
            if (!file) {
                showToast("Choose a JSON playlist file first.", "warning");
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                showToast("Playlist JSON files must be 5 MB or smaller.", "warning");
                return;
            }
            try {
                const parsed = JSON.parse(await file.text());
                setPlaylistReview(normalizePlaylistJson(parsed, "json", file.name.replace(/\.json$/i, "")));
                document.getElementById("youtubeAuthStatus").textContent = `Read ${PENDING_PLAYLIST.tracks.length} tracks from ${file.name}. Review before use.`;
                document.getElementById("youtubeAuthStatus").className = "text-[10px] text-emerald-400 mt-1";
                showToast("JSON playlist read and normalized. Review it before use.", "success");
            } catch (err) {
                showToast(`Could not read playlist JSON: ${err.message}`, "error");
            }
        }

        function downloadNormalizedPlaylist() {
            if (!PENDING_PLAYLIST) {
                showToast("Import a playlist before downloading normalized JSON.", "warning");
                return;
            }
            const blob = new Blob([JSON.stringify(PENDING_PLAYLIST, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${(PENDING_PLAYLIST.playlistName || "playlist").replace(/[^a-z0-9-_]+/gi, "-")}.json`;
            link.click();
            URL.revokeObjectURL(url);
        }

        async function loadYouTubePlaylist() {
            if (!hasListenerConsent()) return;
            const playlistUrl = document.getElementById("youtubePlaylistIdInput").value.trim();
            const status = document.getElementById("youtubeAuthStatus");
            const button = document.getElementById("loadYoutubeBtn");

            if (!playlistUrl) {
                showToast("Enter a public YouTube playlist URL.", "warning");
                return;
            }

            button.disabled = true;
            button.classList.add("opacity-50", "cursor-not-allowed");
            status.textContent = "Reading the public playlist and converting it to normalized JSON...";
            status.className = "text-[10px] text-blue-400 mt-1";
            try {
                const response = await fetch("/api/playlist/youtube", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ playlistUrl })
                });
                const playlist = await response.json();
                if (!response.ok) throw new Error(playlist.detail || `Playlist import HTTP ${response.status}`);

                setPlaylistReview(playlist);
                const tracks = playlist.tracks || [];
                status.textContent = `Found ${tracks.length} videos. Review the normalized playlist before using it.`;
                status.className = "text-[10px] text-emerald-400 mt-1";
                showToast(`Converted "${playlist.playlistName}" to normalized playlist JSON. Review it before use.`, "success");
            } catch (err) {
                console.error("YouTube playlist import failed:", err);
                status.textContent = `Import failed: ${err.message}`;
                status.className = "text-[10px] text-red-400 mt-1";
                showToast(`YouTube playlist import failed: ${err.message}`, "error");
            } finally {
                button.disabled = false;
                button.classList.remove("opacity-50", "cursor-not-allowed");
            }
        }

        function saveListenerProfile() {
            if (!hasListenerConsent()) return;
            try {
                const profile = {
                    playlist: NORMALIZED_PLAYLIST,
                    tasteSummary: document.getElementById("listenerTasteSummary").value.trim(),
                    explicitPreferences: document.getElementById("listenerExplicitPreferences").value.trim(),
                    learnedPreferences: CHAT_TASTE_INSIGHTS
                };
                sessionStorage.setItem("goalModeListenerProfile", JSON.stringify(profile));
                document.getElementById("profileSaveStatus").textContent = "Saved in this session";
                showToast("Listener profile saved for this browser session.", "success");
            } catch (err) {
                showToast(`Could not save listener profile: ${err.message}`, "error");
            }
        }

        function loadSavedListenerProfile() {
            try {
                if (sessionStorage.getItem("goalModeListenerConsent") !== "true") return;
                const saved = sessionStorage.getItem("goalModeListenerProfile");
                if (!saved) return;
                const profile = JSON.parse(saved);
                document.getElementById("listenerConsentCheck").checked = true;
                document.getElementById("listenerTasteSummary").value = profile.tasteSummary || "";
                document.getElementById("listenerExplicitPreferences").value = profile.explicitPreferences || "";
                CHAT_TASTE_INSIGHTS = Array.isArray(profile.learnedPreferences) ? profile.learnedPreferences : [];
                if (profile.playlist?.tracks?.length) {
                    NORMALIZED_PLAYLIST = profile.playlist;
                    PENDING_PLAYLIST = JSON.parse(JSON.stringify(profile.playlist));
                    setPlaylistReview(PENDING_PLAYLIST);
                    confirmPlaylistReview();
                }
                document.getElementById("profileSaveStatus").textContent = "Restored for this session";
                renderLearnedTasteNotes();
            } catch (err) {
                showToast(`Could not restore listener profile: ${err.message}`, "error");
            }
        }

        function clearListenerData(skipConfirm = false) {
            if (!skipConfirm && !confirm("Clear this session's playlist, profile, and learned taste preferences?")) return;
            try {
                sessionStorage.removeItem("goalModeListenerProfile");
                sessionStorage.removeItem("goalModeListenerConsent");
                sessionStorage.removeItem("goalModePreviouslyRecommended");
            } catch (err) {
                showToast(`Could not clear saved listener data: ${err.message}`, "error");
                return;
            }
            document.getElementById("listenerConsentCheck").checked = false;
            document.getElementById("listenerTasteSummary").value = "";
            document.getElementById("listenerExplicitPreferences").value = "";
            document.getElementById("profileSaveStatus").textContent = "Not saved";
            document.getElementById("playlistReviewPanel").classList.add("hidden");
            document.getElementById("youtubeAuthStatus").textContent = "No API key needed. Public playlists are imported by the local backend.";
            PENDING_PLAYLIST = null;
            NORMALIZED_PLAYLIST = null;
            PLAYLIST_ITEMS = [];
            CATALOG_ITEMS = [];
            playlistVideoIds = new Set();
            playlistPreferenceSummary = "";
            CHAT_TASTE_INSIGHTS = [];
            CHAT_HISTORY = [];
            LAST_RECOMMENDATION_DATA = null;
            renderPlaylistHistory();
            renderCatalogTable();
            renderLearnedTasteNotes();
            refreshChatContextDisplay();
            if (!skipConfirm) showToast("Cleared listener data for this browser session.", "success");
        }

        function getPreviouslyRecommendedIds() {
            try {
                return JSON.parse(sessionStorage.getItem("goalModePreviouslyRecommended") || "[]");
            } catch {
                return [];
            }
        }

        function rememberRecommendedIds(recommendations) {
            const ids = new Set(getPreviouslyRecommendedIds());
            recommendations.forEach(item => ids.add(item.content_id));
            sessionStorage.setItem("goalModePreviouslyRecommended", JSON.stringify([...ids]));
        }

        function mergeDatabaseCatalogRows(rows) {
            let added = 0;
            for (const row of rows) {
                if (!row || typeof row !== "object") continue;
                const rawId = row.catalog_track_id ?? row.track_id ?? row.id;
                const title = row.title ?? row.track_name;
                const artist = row.artist ?? row.artist_name;
                if (rawId === undefined || !title || !artist) continue;

                const id = `db:${rawId}`;
                if (CATALOG_ITEMS.some(item => item.id === id)) continue;
                const durationMs = Number(row.duration_ms);
                const duration = Number.isFinite(durationMs) && durationMs > 0
                    ? Math.max(1, Math.ceil(durationMs / 60000))
                    : 4;
                const tags = ["music-catalog"];
                for (const field of ["genre", "energy", "valence", "danceability", "acousticness", "instrumentalness", "tempo"]) {
                    const value = row[field];
                    if (value !== undefined && value !== null && value !== "") tags.push(`${field}:${value}`);
                }

                CATALOG_ITEMS.unshift({
                    id,
                    title: String(title),
                    artist: String(artist),
                    category: "Music",
                    duration,
                    durationSeconds: durationMs > 0 ? Math.round(durationMs / 1000) : duration * 60,
                    cover: "",
                    tags,
                    catalogMetadata: row
                });
                added += 1;
            }
            if (added) {
                document.getElementById("catalogStatus").textContent =
                    `${CATALOG_ITEMS.length} candidate songs (${added} matched from music database)`;
                renderCatalogTable();
            }
        }

        async function requestAiJson(systemInstruction, userContent, task = "recommendation", skipCatalog = false) {
            const response = await fetch("/api/ai/json", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ systemInstruction, userContent, task, skipCatalog })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Local recommendation service HTTP ${response.status}`);
            if (!data.result || typeof data.result !== "object") throw new Error("Local recommendation service returned an invalid response.");
            if (Array.isArray(data.catalog)) mergeDatabaseCatalogRows(data.catalog);
            return data.result;
        }

        function normalizeRecommendations(recommendations) {
            if (recommendations === undefined || recommendations === null) return [];
            let normalized;
            if (Array.isArray(recommendations)) {
                normalized = recommendations;
            } else if (
                typeof recommendations === "object" &&
                !Array.isArray(recommendations) &&
                recommendations.content_id !== undefined
            ) {
                normalized = [recommendations];
            } else {
                throw new Error("Local recommendation service returned recommendations in an invalid format.");
            }
            if (normalized.some(recommendation =>
                !recommendation ||
                typeof recommendation !== "object" ||
                (typeof recommendation.content_id !== "string" && typeof recommendation.content_id !== "number")
            )) {
                throw new Error("Local recommendation service returned an invalid recommendation entry.");
            }
            return normalized;
        }

        function trackIdentityKey(track) {
            if (!track || typeof track.title !== "string" || typeof track.artist !== "string") return "";
            return normalizeSongKey(`${track.artist} ${track.title}`);
        }

        function getRecommendationExclusions(ids = []) {
            const excludedIds = new Set(ids.map(id => String(id)));
            PLAYLIST_ITEMS.forEach(track => excludedIds.add(`playlist:${track.id}`));
            const knownTracks = [
                ...PLAYLIST_ITEMS,
                ...CATALOG_ITEMS.filter(track => excludedIds.has(String(track.id)))
            ];
            const excludedIdentities = new Set(knownTracks.map(trackIdentityKey).filter(Boolean));
            return { ids: excludedIds, identities: excludedIdentities };
        }

        function filterExcludedRecommendations(recommendations, exclusions) {
            const seenIds = new Set();
            const seenIdentities = new Set();
            return recommendations.filter(recommendation => {
                const id = String(recommendation.content_id);
                const item = CATALOG_ITEMS.find(candidate => String(candidate.id) === id);
                const identity = item ? trackIdentityKey(item) : "";
                if (
                    exclusions.ids.has(id) ||
                    (identity && exclusions.identities.has(identity)) ||
                    seenIds.has(id) ||
                    (identity && seenIdentities.has(identity))
                ) {
                    return false;
                }
                seenIds.add(id);
                if (identity) seenIdentities.add(identity);
                return true;
            });
        }

        async function fetchExternalDiscoveryTracks({
            goalText,
            budgetMins,
            preferredTopics,
            excludedTopics,
            existingIds,
            currentTracks = [],
            listenerContext = "",
            task = "discovery"
        }) {
            const systemPrompt = `You are the Goal Mode AI Music Discovery Engine.
The listener has requested music based on a specific prompt, franchise, soundtrack, or artist: "${goalText}".

Your job is to identify REAL, authentic, commercially released songs, openings, endings, character songs, or compositions that 100% strictly belong to this prompt.

STRICT MANDATORY RULES:
1. FRANCHISE & SPECIFIC CANON INTEGRITY: If the listener specifies a franchise, anime series, video game, soundtrack, or specific artist (e.g. "Monogatari series", "Persona 5", "NieR:Automata", "Studio Ghibli", "Daft Punk", "Danse Macabre"):
   EVERY track MUST be an official, authentic song strictly from that exact franchise, series, or artist (for Monogatari, provide canonical tracks such as "Renai Circulation" by Kana Hanazawa, "Kimi no Shiranai Monogatari" by supercell, "Platinum Disco" by Yuka Iguchi, "Staple Stable" by Chiwa Saito, "Mousou Express" by Kana Hanazawa, "Sugar Sweet Nightmare" by Yui Horie, "Marshmallow Justice" by Eri Kitamura, "Orange Mint", etc.).
   NEVER return unrelated generic pop, rock, or songs from different franchises.
2. ZERO OFF-TOPIC TRACKS: Do NOT pad with unrelated music. Every single item must be 100% genuine and relevant to "${goalText}".
3. STRICT EXCLUSIONS: Under NO circumstances include any artist, title, or genre matching EXCLUDED TOPICS: ${JSON.stringify(excludedTopics)}.
4. REAL DURATIONS: Provide realistic durations (typically 3 to 5 minutes each).
5. TARGET Duration Range: Return additional authentic tracks totaling as close as possible to ${budgetMins} minutes without exceeding it (typically ${Math.max(3, Math.ceil(budgetMins / 4))} tracks). A later pass may request fewer minutes to fill a verified shortfall.
6. OUTPUT SIZE: Return only the tracks needed to approach the requested duration; do not add commentary outside the JSON object.
7. DO NOT REPEAT tracks already selected for this playlist: ${JSON.stringify(currentTracks)}.

Return ONLY a JSON object matching this schema:
{
  "tracks": [
    {
      "title": "Exact Song Title",
      "artist": "Exact Artist / Vocalist / Composer",
      "duration_minutes": 4,
      "tags": ["franchise or genre tags"],
      "reason": "Exact explanation of how this song belongs to the requested series or prompt"
    }
  ]
}`;

            const userPrompt = `
LISTENER REQUEST:
Goal Text: "${goalText}"
Target Duration: ${budgetMins} minutes
Preferred Topics: ${JSON.stringify(preferredTopics)}
Explicit Excluded Topics: ${JSON.stringify(excludedTopics)}
Previously Recommended / Existing IDs to avoid: ${JSON.stringify((existingIds || []).slice(0, 50))}
Already selected tracks to avoid: ${JSON.stringify(currentTracks)}
${listenerContext ? `\nLISTENER TASTE CONTEXT:\n${listenerContext}` : ""}
`;

            try {
                const exclusions = getRecommendationExclusions(existingIds || []);
                (currentTracks || []).forEach(trackName => {
                    const identity = typeof trackName === "string"
                        ? normalizeSongKey(trackName)
                        : trackIdentityKey(trackName);
                    if (identity) exclusions.identities.add(identity);
                });
                const result = await requestAiJson(systemPrompt, userPrompt, task);
                if (!Array.isArray(result.tracks)) {
                    throw new Error("AI discovery response did not include a tracks array.");
                }
                if (result.tracks.some(track =>
                    !track ||
                    typeof track !== "object" ||
                    typeof track.title !== "string" ||
                    typeof track.artist !== "string"
                )) {
                    throw new Error("AI discovery response included an invalid track.");
                }

                const verificationResponse = await fetch("/api/catalog/verify-tracks", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        tracks: result.tracks.map(track => ({
                            title: track.title,
                            artist: track.artist
                        }))
                    })
                });
                const verificationData = await verificationResponse.json();
                if (!verificationResponse.ok) {
                    throw new Error(verificationData.detail || `Track verification failed with HTTP ${verificationResponse.status}.`);
                }
                if (!Array.isArray(verificationData.tracks)) {
                    throw new Error("Track verification returned an invalid response.");
                }

                mergeDatabaseCatalogRows(verificationData.tracks);
                const seenIds = new Set();
                const seenIdentities = new Set();
                return verificationData.tracks.flatMap(verifiedTrack => {
                    const id = `db:${verifiedTrack.catalog_track_id}`;
                    const item = CATALOG_ITEMS.find(candidate => candidate.id === id);
                    if (!item) {
                        throw new Error("A catalog-verified track could not be loaded into the candidate catalog.");
                    }
                    const identity = trackIdentityKey(item);
                    if (
                        exclusions.ids.has(id) ||
                        exclusions.ids.has(String(verifiedTrack.catalog_track_id)) ||
                        (identity && exclusions.identities.has(identity)) ||
                        seenIds.has(id) ||
                        (identity && seenIdentities.has(identity))
                    ) {
                        return [];
                    }
                    seenIds.add(id);
                    if (identity) seenIdentities.add(identity);
                    item.tags = [...new Set([...item.tags, "outside-discovery", "prompt-curated"])];
                    item.isDiscoveredMatch = true;
                    return [{
                        ...item,
                        reason: verifiedTrack.artist_corrected
                            ? `Catalog verified this title and corrected its artist to ${verifiedTrack.artist}.`
                            : `Catalog verified this title and artist as a match for "${goalText}".`
                    }];
                });
            } catch (err) {
                console.error("Failed to query external discovery tracks:", err);
                throw err;
            }
        }

        async function fetchBudgetFillerTracks({ goalText, remainingBudget, totalBudget, preferredTopics, excludedTopics, existingIds, currentTracks }) {
            const systemPrompt = `You are the Goal Mode AI Duration & Budget Engine.
The listener's current audio queue has not reached their requested time budget of ${totalBudget} minutes.
Your task is to curate additional high-quality, authentic tracks to fill the remaining ${remainingBudget} minutes of listening time without exceeding it.

STRICT MANDATORY RULES:
1. STRICT THEME & FRANCHISE CONSISTENCY: Every single track MUST directly and specifically belong to the listener's prompt: "${goalText}". If the goal mentions a specific franchise, anime, artist, or series (e.g., Monogatari, Ghibli, Zelda, classical), ALL filler tracks MUST strictly come from that exact franchise, series, or style. Absolutely NO random or generic filler songs from outside this theme.
2. Under NO circumstances select any artist, track, or genre matching EXCLUDED TOPICS: ${JSON.stringify(excludedTopics)}.
3. Realistic individual track durations (typically 3 to 5 minutes each).
4. TARGET SUM OF DURATIONS: The sum of durations of your selected filler tracks should be as close to ${remainingBudget} minutes as possible, and MUST NOT exceed ${remainingBudget} minutes.
5. Do NOT repeat any tracks already in the playlist, queue, or candidate pool: ${JSON.stringify((existingIds || []).slice(0, 50))}.

Return ONLY a JSON object matching this schema:
{
  "tracks": [
    {
      "title": "Exact Song/Piece Title",
      "artist": "Exact Artist or Composer Name",
      "duration_minutes": 4,
      "tags": ["genre", "style"],
      "reason": "1-sentence reason why this authentic track belongs to the requested prompt and rounds out the duration"
    }
  ]
}`;

            const userPrompt = `
GOAL: "${goalText}"
PREFERRED TOPICS: ${JSON.stringify(preferredTopics)}
EXCLUDED TOPICS: ${JSON.stringify(excludedTopics)}
REMAINING TIME BUDGET TO FILL: ${remainingBudget} minutes (Total Target: ${totalBudget} minutes)
CURRENT QUEUE PREVIEWS: ${JSON.stringify((currentTracks || []).slice(0, 10))}
`;

            try {
                const result = await requestAiJson(systemPrompt, userPrompt, "discovery");
                if (!Array.isArray(result.tracks)) {
                    throw new Error("AI budget response did not include a tracks array.");
                }
                if (result.tracks.some(track =>
                    !track ||
                    typeof track !== "object" ||
                    typeof track.title !== "string" ||
                    typeof track.artist !== "string"
                )) {
                    throw new Error("AI budget response included an invalid track.");
                }
                
                let accumulatedMinutes = 0;
                const fillerTracks = [];
                const exclusions = getRecommendationExclusions(existingIds || []);
                (currentTracks || []).forEach(trackName => {
                    const identity = typeof trackName === "string"
                        ? normalizeSongKey(trackName)
                        : trackIdentityKey(trackName);
                    if (identity) exclusions.identities.add(identity);
                });

                for (const track of result.tracks) {
                    const dur = Math.min(20, Math.max(1, parseInt(track.duration_minutes) || 4));
                    const identity = trackIdentityKey(track);
                    if (!identity || exclusions.identities.has(identity) || accumulatedMinutes + dur > remainingBudget) continue;
                    const id = `filler:${normalizeSongKey(track.artist + " " + track.title)}`;
                    if (exclusions.ids.has(id)) continue;
                    exclusions.identities.add(identity);
                    exclusions.ids.add(id);
                    accumulatedMinutes += dur;
                    fillerTracks.push({
                        id: id,
                        title: track.title,
                        artist: track.artist,
                        category: "Music",
                        duration: dur,
                        durationSeconds: dur * 60,
                        cover: "",
                        tags: ["budget-filler", "prompt-curated", ...(track.tags || [])],
                        reason: track.reason,
                        isBudgetFiller: true
                    });
                }
                return fillerTracks;
            } catch (err) {
                console.error("Failed to query budget filler tracks:", err);
                throw err;
            }
        }

        async function loadMoreTracksForPrompt() {
            if (!hasListenerConsent()) return;
            const goalText = document.getElementById("goalTextInput").value.trim();
            const budgetMins = parseInt(document.getElementById("budgetInput").value) || 30;
            const explicitExclusions = document.getElementById("exclusionsInput").value.trim();

            if (!goalText) {
                showToast("Please enter a goal or prompt description first.", "warning");
                document.getElementById("goalTextInput").focus();
                return;
            }

            showToast(`Loading authentic tracks for "${goalText}" into candidate catalog...`, "info");
            try {
                const discovered = await fetchExternalDiscoveryTracks({
                    goalText,
                    budgetMins,
                    preferredTopics: [goalText],
                    excludedTopics: explicitExclusions ? explicitExclusions.split(",").map(t => t.trim()) : [],
                    existingIds: CATALOG_ITEMS.map(c => c.id)
                });

                if (discovered.length) {
                    discovered.forEach(t => {
                        if (!CATALOG_ITEMS.some(c => c.id === t.id)) {
                            CATALOG_ITEMS.unshift(t);
                        }
                    });
                    document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} candidate songs (${discovered.length} loaded from prompt)`;
                    renderCatalogTable();
                    showToast(`Loaded ${discovered.length} songs for "${goalText}" into candidate catalog!`, "success");
                } else {
                    showToast("AI did not find any new matching tracks.", "warning");
                }
            } catch (err) {
                showToast(`Could not load tracks from the local AI service: ${err.message}`, "error");
            }
        }

        async function generateGoalQueue() {
            if (!hasListenerConsent()) return;
            const goalText = document.getElementById("goalTextInput").value.trim();
            const budgetMins = parseInt(document.getElementById("budgetInput").value) || 30;
            const explicitExclusions = document.getElementById("exclusionsInput").value.trim();
            const listenerTasteSummary = document.getElementById("listenerTasteSummary").value.trim();
            const listenerPreferences = document.getElementById("listenerExplicitPreferences").value.trim();
            const previouslyRecommendedIds = getPreviouslyRecommendedIds();
            playlistPreferenceSummary = listenerTasteSummary || playlistPreferenceSummary;

            if (!goalText) {
                showToast("Please enter a listening goal description.", "warning");
                document.getElementById("goalTextInput").focus();
                return;
            }

            setLoading(true);

            // Only an imported seed playlist selects playlist-grounded mode.
            const isPlaylistGrounded = PLAYLIST_ITEMS.length > 0;

            if (!isPlaylistGrounded) {
                document.getElementById("loadingStateTitle").textContent = "Direct Prompt Mode: Curating authentic tracks for your goal...";
                document.getElementById("loadingStateSubtitle").textContent = "Generating, verifying, and filling matching tracks";
            } else {
                document.getElementById("loadingStateTitle").textContent = "Parsing goal & evaluating candidate pool...";
                document.getElementById("loadingStateSubtitle").textContent = "Enforcing budget constraints & topic exclusions";
            }

            const exclusionTokens = explicitExclusions.toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
            const recommendationExclusions = getRecommendationExclusions(previouslyRecommendedIds);
            let eligibleCandidates = CATALOG_ITEMS.filter(item => {
                const identity = trackIdentityKey(item);
                if (
                    recommendationExclusions.ids.has(String(item.id)) ||
                    (identity && recommendationExclusions.identities.has(identity))
                ) {
                    return false;
                }
                if (!exclusionTokens.length) return true;
                const searchText = `${item.title} ${item.artist} ${item.tags.join(" ")}`.toLowerCase();
                return !exclusionTokens.some(ex => searchText.includes(ex));
            });

            eligibleCandidates = eligibleCandidates.slice(0, 40);

            const compactCatalogPrompt = eligibleCandidates.length 
                ? eligibleCandidates.map(c => `ID: "${c.id}" | ${c.title} - ${c.artist} | ${c.duration}m | Tags: ${c.tags.slice(0, 3).join(", ")}`).join("\n")
                : "No eligible new candidates are available; discover new tracks instead of reusing excluded songs.";

            const chatInsightsText = CHAT_TASTE_INSIGHTS.length 
                ? `\nLEARNED PREFERENCES FROM CONVERSATIONAL AI CHAT:\n${CHAT_TASTE_INSIGHTS.map(t => `- ${t}`).join("\n")}`
                : "None recorded yet";

            const systemPrompt = `You are the Goal Mode AI Recommendation Engine.
Your job is to parse listener goals, evaluate candidate suitability from the candidate catalog (if available), and assemble the optimal audio queue.

CRITICAL 100% RELEVANCE & ZERO IRRELEVANT FILLER RULES:
1. 100% THEMATIC RELEVANCE ONLY: Only select candidate items if they GENUINELY, DIRECTLY, and AUTHENTICALLY match the listener's specific goal (e.g. if the user asks for "songs from the monogatari series", ONLY select songs that actually belong to the Monogatari series; NEVER select unrelated indie, pop, or rock songs).
2. CONVERSATIONAL TASTE INTEGRATION: Actively honor and incorporate the listener's learned preferences and critiques discovered in recent AI Taste Chat discussions.
2a. LISTENER PROFILE: Incorporate the listener-approved taste summary and explicit preferences when choosing tracks.
3. ZERO UNRELATED BACKFILLING: If the candidate catalog only has 1 or 2 songs that genuinely match, select ONLY those matching songs. NEVER force-fit unrelated catalog songs just to fill the budget!
4. PROMPT-DRIVEN EXPANSION: If no candidates exist, or if the user's prompt requests a specific franchise, soundtrack, artist, or style that is NOT fully populated in the candidate catalog, or if qualified candidates cannot fill at least 80% of the ${budgetMins}-minute budget, set "needs_external_discovery": true and "status": "needs_prompt_expansion".
5. STRICT EXCLUSIONS: Under no circumstances select any item matching EXPLICIT EXCLUSIONS or the imported playlist / previously recommended tracks listed below.
6. GOAL PRIORITY: Override historical preferences when they conflict with the user's goal.

Return valid JSON strictly matching schema:
{
  "normalized_goal": "1-sentence summary of the parsed user goal",
  "specific_franchise_or_artist": "Name of franchise/artist/theme if specific, else null",
  "preferred_topics": ["array", "of", "preferred", "topics"],
  "excluded_topics": ["array", "of", "explicitly", "excluded", "topics"],
  "budget_minutes": ${budgetMins},
  "needs_external_discovery": true | false,
  "ai_comment": "Brief comment explaining candidate evaluation or what prompt-specific songs need to be loaded",
  "recommendations": [{"content_id": "EXACT_ID", "reason": "1-sentence reason why this strictly matches the goal"}],
  "status": "ok" | "outside_discovery" | "needs_prompt_expansion" | "clarify" | "no_match"
}`;

            const userPrompt = `
LISTENER INPUT:
Goal: "${goalText}"
Budget: ${budgetMins} minutes
Explicit Exclusions: "${explicitExclusions}"
Listener-Approved Taste Summary: "${listenerTasteSummary || "None"}"
Listener-Provided Preferences: "${listenerPreferences || "None"}"
Previously Recommended IDs (AVOID): ${JSON.stringify(previouslyRecommendedIds.slice(0, 30))}
Imported Playlist Tracks to Exclude: ${JSON.stringify(PLAYLIST_ITEMS.map(track => `${track.artist} - ${track.title}`).slice(0, 40))}
Playlist Style Summary: ${playlistPreferenceSummary || "None (Direct prompt curation)"}
${chatInsightsText}

CANDIDATE POOL (Compact Format):
${compactCatalogPrompt}
`;

            try {
                let parsedData;
                if (!isPlaylistGrounded) {
                    const excludedTopics = explicitExclusions.split(",").map(topic => topic.trim()).filter(Boolean);
                    const listenerContext = [
                        `Listener-approved taste summary: ${listenerTasteSummary || "None"}`,
                        `Listener-provided preferences: ${listenerPreferences || "None"}`,
                        `Learned chat insights: ${CHAT_TASTE_INSIGHTS.join("; ") || "None"}`
                    ].join("\n");
                    const excludedTokens = excludedTopics.map(topic => topic.toLowerCase()).filter(Boolean);
                    const knownIds = new Set([
                        ...previouslyRecommendedIds,
                        ...PLAYLIST_ITEMS.map(track => `playlist:${track.id}`)
                    ].map(String));
                    const recommendations = [];
                    let totalMinutes = 0;
                    const selectedTrackNames = [];
                    let refillError = "";
                    const maxDiscoveryPasses = 3;

                    for (let pass = 0; pass < maxDiscoveryPasses; pass += 1) {
                        const remainingBudget = budgetMins - totalMinutes;
                        if (remainingBudget <= 0) break;

                        let promptTracks;
                        try {
                            promptTracks = await fetchExternalDiscoveryTracks({
                                goalText,
                                budgetMins: remainingBudget,
                                preferredTopics: [goalText],
                                excludedTopics,
                                existingIds: [...knownIds],
                                currentTracks: selectedTrackNames,
                                listenerContext,
                                task: "discovery"
                            });
                        } catch (err) {
                            if (recommendations.length === 0) throw err;
                            console.error("Could not refill the verified playlist:", err);
                            refillError = err.message;
                            break;
                        }

                        for (const track of promptTracks) {
                            if (knownIds.has(track.id)) continue;
                            knownIds.add(track.id);
                            const searchText = `${track.title} ${track.artist} ${track.tags.join(" ")}`.toLowerCase();
                            if (excludedTokens.some(topic => searchText.includes(topic))) continue;
                            if (totalMinutes + track.duration > budgetMins) continue;

                            totalMinutes += track.duration;
                            selectedTrackNames.push(`${track.artist} - ${track.title}`);
                            if (!CATALOG_ITEMS.some(item => item.id === track.id)) {
                                CATALOG_ITEMS.unshift(track);
                            }
                            recommendations.push({
                                content_id: track.id,
                                reason: track.reason || `Directly matched to "${goalText}".`
                            });
                        }

                        if (totalMinutes >= budgetMins) break;
                    }

                    if (recommendations.length) {
                        document.getElementById("catalogStatus").textContent =
                            `${CATALOG_ITEMS.length} candidate songs (${recommendations.length} verified tracks loaded from prompt)`;
                        renderCatalogTable();
                    }
                    const filledBudget = totalMinutes >= budgetMins;
                    parsedData = {
                        normalized_goal: goalText,
                        preferred_topics: [goalText],
                        excluded_topics: excludedTopics,
                        recommendations,
                        status: recommendations.length ? "discovered_match" : "no_match",
                        ai_comment: recommendations.length
                            ? `Curated ${recommendations.length} catalog-verified tracks (${totalMinutes}/${budgetMins} minutes).${filledBudget ? "" : " The catalog did not provide enough unambiguous matching tracks to fill the full duration."}${refillError ? ` Additional-track request failed: ${refillError}` : ""}`
                            : "No new catalog-verified tracks matched the request and exclusions."
                    };
                    renderResults(parsedData, budgetMins);
                    if (filledBudget) {
                        showToast(`Goal Queue filled (${totalMinutes}/${budgetMins} minutes).`, "success");
                    } else if (recommendations.length) {
                        showToast(`Added ${recommendations.length} verified tracks (${totalMinutes}/${budgetMins} minutes); there were not enough unambiguous catalog matches to fill the target.`, "warning");
                    } else {
                        showToast("No new catalog-verified tracks matched the request.", "warning");
                    }
                    return;
                }

                parsedData = await requestAiJson(systemPrompt, userPrompt, "recommendation", true);

                let currentRecs = filterExcludedRecommendations(
                    normalizeRecommendations(parsedData.recommendations),
                    recommendationExclusions
                );
                parsedData.recommendations = currentRecs;
                let currentDuration = currentRecs.reduce((sum, rec) => {
                    const item = CATALOG_ITEMS.find(c => c.id === rec.content_id);
                    return sum + (item ? (item.duration || 4) : 4);
                }, 0);

                const targetMinDuration = Math.floor(budgetMins * 0.8);

                const needsPromptExpansion =
                    parsedData.status === "outside_discovery" ||
                    parsedData.status === "needs_prompt_expansion" ||
                    parsedData.status === "no_match" ||
                    parsedData.needs_external_discovery === true ||
                    (!currentRecs.length && parsedData.status === "ok") ||
                    (currentDuration < targetMinDuration && parsedData.status !== "clarify");

                if (needsPromptExpansion) {
                    const remainingNeeded = Math.max(budgetMins - currentDuration, 8);
                    showToast(`Curating authentic tracks for "${parsedData.normalized_goal || goalText}"...`, "info");

                    const promptTracks = await fetchExternalDiscoveryTracks({
                        goalText,
                        budgetMins: remainingNeeded,
                        preferredTopics: parsedData.preferred_topics || [goalText],
                        excludedTopics: parsedData.excluded_topics || [],
                        existingIds: [...recommendationExclusions.ids, ...currentRecs.map(r => r.content_id)],
                        currentTracks: [
                            ...PLAYLIST_ITEMS.map(track => `${track.artist} - ${track.title}`),
                            ...currentRecs.map(recommendation => {
                                const item = CATALOG_ITEMS.find(candidate => candidate.id === recommendation.content_id);
                                return item ? `${item.artist} - ${item.title}` : String(recommendation.content_id);
                            })
                        ]
                    });

                    if (promptTracks.length) {
                        promptTracks.forEach(pt => {
                            if (!CATALOG_ITEMS.some(c => c.id === pt.id)) {
                                CATALOG_ITEMS.unshift(pt);
                            }
                            if (currentDuration + pt.duration <= budgetMins + 2) {
                                currentRecs.push({
                                    content_id: pt.id,
                                    reason: pt.reason || `Directly matched to "${goalText}".`
                                });
                                currentDuration += pt.duration;
                            }
                        });

                        document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} candidate songs (${promptTracks.length} loaded from prompt)`;
                        renderCatalogTable();

                        parsedData.status = "prompt_expanded";
                        parsedData.recommendations = currentRecs;
                        parsedData.ai_comment = `Curated ${promptTracks.length} tracks specifically matching "${goalText}".`;

                    }
                }

                // Check for duration shortfall
                const remainingBudget = budgetMins - currentDuration;
                if (currentDuration < targetMinDuration && remainingBudget >= 3 && parsedData.status !== "clarify" && parsedData.status !== "no_match") {
                    showToast(`Queue is ${currentDuration}m. Curating filler tracks for your ${budgetMins}m budget...`, "info");

                    const currentTrackNames = currentRecs.map(r => {
                        const item = CATALOG_ITEMS.find(c => c.id === r.content_id);
                        return item ? `${item.artist} - ${item.title}` : r.content_id;
                    });

                    const fillerTracks = await fetchBudgetFillerTracks({
                        goalText,
                        remainingBudget,
                        totalBudget: budgetMins,
                        preferredTopics: parsedData.preferred_topics || [goalText],
                        excludedTopics: parsedData.excluded_topics || [],
                        existingIds: [...recommendationExclusions.ids, ...currentRecs.map(r => r.content_id)],
                        currentTracks: [
                            ...PLAYLIST_ITEMS.map(track => `${track.artist} - ${track.title}`),
                            ...currentTrackNames
                        ]
                    });

                    if (fillerTracks && fillerTracks.length > 0) {
                        let addedFillerDuration = 0;
                        fillerTracks.forEach(ft => {
                            if (!CATALOG_ITEMS.some(c => c.id === ft.id)) {
                                CATALOG_ITEMS.unshift(ft);
                            }
                            parsedData.recommendations.push({
                                content_id: ft.id,
                                reason: ft.reason || `Curated to fill the ${budgetMins}-minute Duration Range.`
                            });
                            addedFillerDuration += ft.duration;
                        });

                        document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} candidate songs (${fillerTracks.length} budget-filler tracks added)`;
                        renderCatalogTable();

                        const fillerComment = `Added ${fillerTracks.length} supplemental tracks (+${addedFillerDuration}m) to fully utilize your ${budgetMins}-minute duration goal.`;
                        parsedData.ai_comment = parsedData.ai_comment ? `${parsedData.ai_comment} ${fillerComment}` : fillerComment;

                        showToast(`Added ${fillerTracks.length} tracks to fill queue (${currentDuration + addedFillerDuration}/${budgetMins}m)`, "success");
                    }
                }
                renderResults(parsedData, budgetMins);
                showToast("Goal Queue successfully generated!", "success");

            } catch (err) {
                console.error("Queue generation error:", err);
                renderResults({
                    normalized_goal: goalText,
                    preferred_topics: [],
                    excluded_topics: [],
                    recommendations: [],
                    status: "no_match",
                    ai_comment: `Unable to complete queue generation: ${err.message}`
                }, budgetMins);
                showToast(`Generation failed: ${err.message}`, "error");
            } finally {
                setLoading(false);
            }
        }

        function renderResults(data, requestedBudget) {
            document.getElementById("emptyState").classList.add("hidden");
            document.getElementById("outputContent").classList.remove("hidden");

            // Status Badge
            const statusTag = document.getElementById("statusTag");
            const status = data.status || "ok";
            statusTag.textContent = status.replace("_", " ").toUpperCase();
            
            if (status === "ok") {
                statusTag.className = "bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 text-xs px-2.5 py-1 rounded-full font-mono";
            } else if (status === "prompt_expanded" || status === "discovered_match" || status === "outside_discovery") {
                statusTag.className = "bg-purple-900/60 text-purple-300 border border-purple-700/50 text-xs px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5";
                statusTag.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles text-purple-400 text-[10px]"></i> PROMPT MATCHED`;
            } else if (status === "popular_match") {
                statusTag.className = "bg-amber-900/60 text-amber-300 border border-amber-700/50 text-xs px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5";
                statusTag.innerHTML = `<i class="fa-solid fa-fire text-amber-400 text-[10px]"></i> POPULAR MATCH`;
            } else if (status === "clarify") {
                statusTag.className = "bg-purple-900/60 text-purple-300 border border-purple-700/50 text-xs px-2.5 py-1 rounded-full font-mono";
            } else {
                statusTag.className = "bg-red-900/60 text-red-300 border border-red-700/50 text-xs px-2.5 py-1 rounded-full font-mono";
            }

            // Extracted Summary
            document.getElementById("resNormalizedGoal").textContent = data.normalized_goal || "N/A";
            document.getElementById("resAiComment").textContent = data.ai_comment || "No comment provided.";

            const prefEl = document.getElementById("resPreferredTopics");
            prefEl.innerHTML = (data.preferred_topics || []).map(t => 
                `<span class="bg-blue-900/50 text-blue-300 border border-blue-700/40 px-1.5 py-0.5 rounded text-[10px]">${escapeHtml(t)}</span>`
            ).join("") || "<span class='text-slate-500'>None</span>";

            const exclEl = document.getElementById("resExcludedTopics");
            exclEl.innerHTML = (data.excluded_topics || []).map(t => 
                `<span class="bg-red-900/50 text-red-300 border border-red-700/40 px-1.5 py-0.5 rounded text-[10px]">${escapeHtml(t)}</span>`
            ).join("") || "<span class='text-slate-500'>None</span>";

            // Process recommendations
            const queueList = document.getElementById("queueList");
            let totalDuration = 0;
            let containsExcludedItem = false;
            const recommendations = normalizeRecommendations(data.recommendations);
            rememberRecommendedIds(recommendations);

            if (!recommendations.length) {
                queueList.innerHTML = `<div class="p-4 bg-slate-900/70 rounded-lg border border-slate-800 text-xs text-slate-400 italic text-center">No audio recommendations match this goal and exclusion set.</div>`;
            } else {
                queueList.innerHTML = recommendations.map((rec, index) => {
                    const item = CATALOG_ITEMS.find(c => c.id === rec.content_id) || {
                        title: "Curated Selection",
                        artist: "Featured Artist",
                        category: "Music",
                        duration: 4,
                        cover: `https://placehold.co/120x120/1e293b/64748b?text=Music`,
                        tags: []
                    };
                    totalDuration += item.duration;

                    const isViolation = (data.excluded_topics || []).some(ex => 
                        (item.tags || []).some(t => t.toLowerCase().includes(ex.toLowerCase())) ||
                        (item.title || "").toLowerCase().includes(ex.toLowerCase())
                    );
                    if (isViolation) containsExcludedItem = true;

                    const isDiscovered = item.tags.includes("outside-discovery") || item.tags.includes("prompt-curated") || item.isDiscoveredMatch;
                    const isPopular = item.tags.includes("popular-track") || item.isPopularMatch;
                    const isFiller = item.tags.includes("budget-filler") || item.isBudgetFiller;
                    const imgElementId = `queue-cover-${index}`;

                    return `
                        <div class="bg-slate-900/90 border ${isViolation ? 'border-red-500' : 'border-slate-700/80'} rounded-lg p-3 space-y-2 shadow-sm">
                            <div class="flex items-center space-x-3">
                                <img id="${imgElementId}"
                                     src="${escapeHtml(safeHttpsUrl(item.cover) || `https://placehold.co/80x80/1e293b/64748b?text=Music`)}"
                                     alt="${escapeHtml(item.title)}"
                                     class="w-12 h-12 rounded object-cover border border-slate-700 bg-slate-800 flex-shrink-0 shadow"
                                     onerror="this.src='https://placehold.co/80x80/1e293b/64748b?text=Music'">
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center justify-between">
                                        <h4 class="text-xs font-semibold text-white truncate">${escapeHtml(item.title)}</h4>
                                        <span class="text-[11px] font-mono font-medium text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                                            ${escapeHtml(item.duration)}m
                                        </span>
                                    </div>
                                    <div class="flex items-center space-x-2 mt-0.5">
                                        <span class="text-[11px] text-emerald-300 truncate">${escapeHtml(item.artist)}</span>
                                        ${isDiscovered ? '<span class="bg-purple-900/60 text-purple-300 border border-purple-700/50 text-[9px] px-1.5 py-0.2 rounded font-sans flex items-center gap-1"><i class="fa-solid fa-sparkles text-purple-400 text-[8px]"></i>Prompt Match</span>' : ''}
                                        ${isFiller ? '<span class="bg-cyan-900/60 text-cyan-300 border border-cyan-700/50 text-[9px] px-1.5 py-0.2 rounded font-sans flex items-center gap-1"><i class="fa-solid fa-stopwatch text-cyan-400 text-[8px]"></i>Budget Fill</span>' : ''}
                                        ${isPopular && !isDiscovered && !isFiller ? '<span class="bg-amber-900/60 text-amber-300 border border-amber-700/50 text-[9px] px-1.5 py-0.2 rounded font-sans flex items-center gap-1"><i class="fa-solid fa-fire text-amber-400 text-[8px]"></i>Popular</span>' : ''}
                                        <span class="text-[10px] text-slate-400 bg-slate-800/80 px-1.5 py-0.2 rounded font-mono">${escapeHtml(item.id)}</span>
                                    </div>
                                </div>
                            </div>
                            <p class="text-xs text-slate-300 bg-slate-800/50 p-2 rounded border border-slate-800 text-[11px] leading-relaxed">
                                <i class="fa-solid fa-quote-left text-[9px] text-blue-400 mr-1.5"></i>${escapeHtml(rec.reason)}
                            </p>
                        </div>
                    `;
                }).join("");

            }

            // Metrics
            const metricDuration = document.getElementById("metricDuration");
            metricDuration.textContent = `${totalDuration} / ${requestedBudget} m`;
            metricDuration.className = totalDuration <= requestedBudget ? "font-semibold text-emerald-400 font-mono" : "font-semibold text-red-400 font-mono";

            const metricExclusion = document.getElementById("metricExclusion");
            if (containsExcludedItem) {
                metricExclusion.textContent = "Violation Detected";
                metricExclusion.className = "font-semibold text-red-400";
            } else {
                metricExclusion.textContent = "100% Compliant";
                metricExclusion.className = "font-semibold text-emerald-400";
            }

            // Raw JSON Output
            document.getElementById("rawJsonResponse").textContent = JSON.stringify(data, null, 2);

            // Synchronize with AI Taste Chat Tab
            LAST_RECOMMENDATION_DATA = {
                normalized_goal: data.normalized_goal || "Custom Goal",
                preferred_topics: data.preferred_topics || [],
                excluded_topics: data.excluded_topics || [],
                budget_minutes: requestedBudget,
                ai_comment: data.ai_comment || "",
                recommendations: recommendations.map(r => {
                    const found = CATALOG_ITEMS.find(c => c.id === r.content_id);
                    return {
                        id: r.content_id,
                        title: found ? found.title : "Curated Selection",
                        artist: found ? found.artist : "Artist",
                        duration: found ? found.duration : 4,
                        cover: found ? found.cover : "",
                        reason: r.reason || ""
                    };
                }),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            const chatDot = document.getElementById("chatContextDot");
            if (chatDot) chatDot.classList.remove("hidden");
            refreshChatContextDisplay();
        }

        function setLoading(isLoading) {
            const btn = document.getElementById("generateBtn");
            const emptyState = document.getElementById("emptyState");
            const loadingState = document.getElementById("loadingState");
            const outputContent = document.getElementById("outputContent");

            if (isLoading) {
                btn.disabled = true;
                btn.classList.add("opacity-50", "cursor-not-allowed");
                emptyState.classList.add("hidden");
                outputContent.classList.add("hidden");
                loadingState.classList.remove("hidden");
            } else {
                btn.disabled = false;
                btn.classList.remove("opacity-50", "cursor-not-allowed");
                loadingState.classList.add("hidden");
            }
        }

        // =========================================================================
        // AI TASTE CHAT & PREFERENCE SYNCHRONIZATION ENGINE
        // =========================================================================

        function refreshChatContextDisplay() {
            const goalText = document.getElementById("goalTextInput")?.value.trim();
            const budget = document.getElementById("budgetInput")?.value || 30;
            const exclusions = document.getElementById("exclusionsInput")?.value.trim() || "None";

            const ctxGoalEl = document.getElementById("chatContextGoalText");
            const ctxBudgetEl = document.getElementById("chatContextBudget");
            const ctxExclEl = document.getElementById("chatContextExclusions");
            const countBadge = document.getElementById("chatQueueCountBadge");
            const listContainer = document.getElementById("chatQueueSnapshotList");

            if (ctxGoalEl) ctxGoalEl.textContent = goalText || "None entered yet";
            if (ctxBudgetEl) ctxBudgetEl.textContent = `${budget}m`;
            if (ctxExclEl) ctxExclEl.textContent = exclusions;

            if (LAST_RECOMMENDATION_DATA && LAST_RECOMMENDATION_DATA.recommendations?.length) {
                const recs = LAST_RECOMMENDATION_DATA.recommendations;
                if (countBadge) countBadge.textContent = `${recs.length} tracks (${LAST_RECOMMENDATION_DATA.timestamp})`;
                if (listContainer) {
                    listContainer.innerHTML = recs.map((t, idx) => `
                        <div class="flex items-center space-x-2 p-1.5 bg-slate-900/80 rounded border border-slate-800 text-[11px]">
                            <img src="${escapeHtml(safeHttpsUrl(t.cover) || 'https://placehold.co/80x80/1e293b/64748b?text=Music')}"
                                 class="w-6 h-6 rounded object-cover border border-slate-700" 
                                 onerror="this.src='https://placehold.co/80x80/1e293b/64748b?text=Music'">
                            <div class="flex-1 min-w-0">
                                <p class="text-slate-200 font-medium truncate">${idx + 1}. ${escapeHtml(t.title)}</p>
                                <p class="text-slate-400 text-[10px] truncate">${escapeHtml(t.artist)} • ${escapeHtml(t.duration)}m</p>
                            </div>
                        </div>
                    `).join("");
                }
            }

            renderLearnedTasteNotes();
        }

        function renderLearnedTasteNotes() {
            const container = document.getElementById("learnedTasteNotesContainer");
            if (!container) return;
            if (!CHAT_TASTE_INSIGHTS.length) {
                container.innerHTML = `<span class="text-[10px] text-slate-500 italic p-1">No conversational preferences recorded yet. Tell the AI what you like or dislike!</span>`;
                return;
            }
            container.innerHTML = CHAT_TASTE_INSIGHTS.map((note, idx) => `
                <span class="inline-flex items-center bg-purple-950/70 text-purple-200 border border-purple-800/60 px-2 py-0.5 rounded text-[10px] font-medium">
                    <span>${escapeHtml(note)}</span>
                    <button type="button" onclick="removeTasteInsight(${idx})" class="ml-1.5 text-purple-400 hover:text-red-400 focus:outline-none">
                        <i class="fa-solid fa-xmark text-[9px]"></i>
                    </button>
                </span>
            `).join("");
        }

        function removeTasteInsight(index) {
            CHAT_TASTE_INSIGHTS.splice(index, 1);
            renderLearnedTasteNotes();
            showToast("Preference removed from Goal Mode sync.", "info");
        }

        function clearChatPreferences() {
            CHAT_TASTE_INSIGHTS = [];
            renderLearnedTasteNotes();
            showToast("Reset learned chat preferences.", "info");
        }

        function clearChatHistory() {
            CHAT_HISTORY = [];
            const container = document.getElementById("chatMessagesContainer");
            if (container) {
                container.innerHTML = `
                    <div class="flex items-start space-x-3">
                        <div class="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-[11px] flex-shrink-0 mt-0.5 shadow">
                            <i class="fa-solid fa-headphones"></i>
                        </div>
                        <div class="bg-slate-900/90 border border-slate-700/80 rounded-2xl rounded-tl-none p-3.5 text-xs text-slate-200 max-w-xl space-y-2 shadow-sm">
                            <p class="leading-relaxed">Chat history cleared. What kind of audio or playlist goals are you planning next?</p>
                        </div>
                    </div>
                `;
            }
            showToast("Chat history cleared.", "info");
        }

        function sendQuickPrompt(promptText) {
            const input = document.getElementById("chatTextInput");
            if (input) {
                input.value = promptText;
                sendChatMessage();
            }
        }

        function appendMessageToFeed(role, text, actionCard = null) {
            const container = document.getElementById("chatMessagesContainer");
            if (!container) return;

            const isUser = role === "user";
            const msgDiv = document.createElement("div");
            msgDiv.className = `flex items-start space-x-3 ${isUser ? 'flex-row-reverse space-x-reverse' : ''}`;

            const avatar = isUser
                ? `<div class="w-7 h-7 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center text-white text-[11px] flex-shrink-0 mt-0.5 shadow"><i class="fa-solid fa-user"></i></div>`
                : `<div class="w-7 h-7 rounded-full bg-gradient-to-tr from-purple-600 to-blue-500 flex items-center justify-center text-white text-[11px] flex-shrink-0 mt-0.5 shadow"><i class="fa-solid fa-sparkles"></i></div>`;

            let actionHtml = "";
            if (actionCard && actionCard.goal) {
                const budget = Number.isFinite(Number(actionCard.budget)) ? Math.min(120, Math.max(1, Number(actionCard.budget))) : 30;
                actionHtml = `
                    <div class="mt-3 p-3 bg-purple-950/40 border border-purple-700/60 rounded-xl space-y-2">
                        <div class="flex items-center justify-between text-[11px]">
                            <span class="font-semibold text-purple-300 flex items-center gap-1.5">
                                <i class="fa-solid fa-wand-magic-sparkles text-[10px]"></i> Proposed Goal Settings
                            </span>
                            <span class="text-[10px] text-slate-400 font-mono">${budget}m Budget</span>
                        </div>
                        <p class="text-[11px] text-slate-200 font-medium italic">"${escapeHtml(actionCard.goal)}"</p>
                        ${actionCard.exclusions ? `<p class="text-[10px] text-slate-400">Exclusions: <span class="text-red-300 font-mono">${escapeHtml(actionCard.exclusions)}</span></p>` : ''}
                        <div class="pt-1.5 flex gap-2">
                            <button data-goal="${escapeHtml(actionCard.goal)}" data-budget="${budget}" data-exclusions="${escapeHtml(actionCard.exclusions || '')}" data-auto-generate="false"
                                class="flex-1 bg-purple-600 hover:bg-purple-500 text-white font-semibold py-1.5 px-2.5 rounded-lg text-[11px] transition flex items-center justify-center gap-1 shadow">
                                <i class="fa-solid fa-check text-[10px]"></i> Apply to Goal Mode
                            </button>
                            <button data-goal="${escapeHtml(actionCard.goal)}" data-budget="${budget}" data-exclusions="${escapeHtml(actionCard.exclusions || '')}" data-auto-generate="true"
                                class="bg-blue-600 hover:bg-blue-500 text-white font-semibold py-1.5 px-2.5 rounded-lg text-[11px] transition flex items-center justify-center gap-1 shadow">
                                <i class="fa-solid fa-play text-[9px]"></i> Apply & Generate
                            </button>
                        </div>
                    </div>
                `;
            }

            msgDiv.innerHTML = `
                ${avatar}
                <div class="${isUser ? 'bg-blue-600 text-white rounded-2xl rounded-tr-none' : 'bg-slate-900/90 border border-slate-700/80 rounded-2xl rounded-tl-none text-slate-200'} p-3.5 text-xs max-w-xl shadow-sm space-y-1 leading-relaxed">
                    <p class="whitespace-pre-wrap">${escapeHtml(text)}</p>
                    ${actionHtml}
                </div>
            `;

            container.appendChild(msgDiv);
            msgDiv.querySelectorAll("button[data-goal]").forEach(button => {
                button.addEventListener("click", () => {
                    applyChatSuggestionToRecommender(
                        encodeURIComponent(button.dataset.goal),
                        Number(button.dataset.budget),
                        encodeURIComponent(button.dataset.exclusions),
                        button.dataset.autoGenerate === "true"
                    );
                });
            });
            container.scrollTop = container.scrollHeight;
        }

        async function sendChatMessage() {
            const input = document.getElementById("chatTextInput");
            const userText = input ? input.value.trim() : "";
            if (!userText) return;
            if (!hasListenerConsent()) return;

            appendMessageToFeed("user", userText);
            input.value = "";

            const typingEl = document.getElementById("chatTypingIndicator");
            const sendBtn = document.getElementById("chatSendBtn");
            if (typingEl) typingEl.classList.remove("hidden");
            if (sendBtn) {
                sendBtn.disabled = true;
                sendBtn.classList.add("opacity-50", "cursor-not-allowed");
            }

            const currentGoal = document.getElementById("goalTextInput")?.value.trim() || "None";
            const currentBudget = document.getElementById("budgetInput")?.value || 30;
            const currentExclusions = document.getElementById("exclusionsInput")?.value.trim() || "None";
            const listenerTasteSummary = document.getElementById("listenerTasteSummary")?.value.trim() || "None";
            const listenerPreferences = document.getElementById("listenerExplicitPreferences")?.value.trim() || "None";
            const currentQueueSnapshot = LAST_RECOMMENDATION_DATA?.recommendations || [];
            const playlistCount = PLAYLIST_ITEMS.length;

            const systemInstruction = `You are the Goal Mode AI Taste Concierge.
Your purpose is to have an intelligent, musical dialogue with the listener about their audio taste, previous queue recommendations, and listening goals.

CURRENT RECOMMENDER & SESSION CONTEXT:
- Active Goal: "${currentGoal}"
- Duration Range: ${currentBudget} minutes
- Active Exclusions: "${currentExclusions}"
- Playlist Loaded: ${playlistCount > 0 ? `Yes (${playlistCount} songs)` : 'No (direct prompt mode)'}
- Listener-Approved Taste Summary: "${listenerTasteSummary}"
- Listener-Provided Preferences: "${listenerPreferences}"
- Current Active Queue Recommendations: ${JSON.stringify(currentQueueSnapshot.map(t => ({ title: t.title, artist: t.artist, duration: t.duration, reason: t.reason })))}
- Treat the active queue above as authoritative context. An empty database search does not mean the queue is empty; use the actual queue items to answer questions about these recommendations.
- Existing Discovered Taste Notes: ${JSON.stringify(CHAT_TASTE_INSIGHTS)}

MANDATORY RULES:
1. Be musically knowledgeable, conversational, concise, and helpful.
2. If the user asks about specific tracks in their queue, reference the actual titles, artists, durations, and curation reasons from the context above.
3. EXTRACT TASTE INSIGHTS: If the listener shares a like, dislike, favorite artist, subgenre preference, or track critique (e.g. "I love upbeat synth", "Dislike acoustic guitar", "Too repetitive", "Need high energy for running"), identify 1 to 3 concise taste insight strings to be stored in "extracted_taste_insights".
4. SUGGEST REFINED GOALS: If the listener asks for adjustments or if their feedback warrants a modified Goal Mode prompt, provide a "suggested_recommender_action" with a concrete "goal", "budget" (number), and "exclusions" string. Otherwise set it to null.

Return valid JSON strictly matching this schema:
{
  "reply": "Your conversational response to the listener...",
  "extracted_taste_insights": ["Array of discovered taste or critique notes to remember, or empty array"],
  "suggested_recommender_action": {
    "goal": "Refined goal description to load into Goal Mode",
    "budget": 30,
    "exclusions": "comma, separated, exclusions"
  } | null
}`;

            const recentHistory = CHAT_HISTORY.slice(-6).map(h => `${h.role === 'user' ? 'Listener' : 'Concierge'}: ${h.text}`).join("\n");
            const chatPrompt = `
CONVERSATION HISTORY:
${recentHistory || "No previous messages."}

ACTIVE QUEUE ITEMS (authoritative; answer queue questions from these exact items):
${JSON.stringify(currentQueueSnapshot.map(t => ({
                title: t.title,
                artist: t.artist,
                duration: t.duration,
                reason: t.reason
            })))}

NEW LISTENER MESSAGE:
"${userText}"
`;

            try {
                const response = await requestAiJson(systemInstruction, chatPrompt, "chat");
                
                CHAT_HISTORY.push({ role: "user", text: userText });
                CHAT_HISTORY.push({ role: "assistant", text: response.reply });

                if (Array.isArray(response.extracted_taste_insights) && response.extracted_taste_insights.length > 0) {
                    response.extracted_taste_insights.forEach(insight => {
                        const clean = insight.trim();
                        if (clean && !CHAT_TASTE_INSIGHTS.includes(clean)) {
                            CHAT_TASTE_INSIGHTS.push(clean);
                        }
                    });
                    renderLearnedTasteNotes();
                    showToast(`Updated learned taste profile with ${response.extracted_taste_insights.length} insight(s)!`, "success");
                }

                appendMessageToFeed("assistant", response.reply, response.suggested_recommender_action);

            } catch (err) {
                console.error("Chat error:", err);
                appendMessageToFeed("assistant", `I ran into an issue connecting with the Cloudflare AI Worker: ${err.message}. Check the Worker URL and Docker services, then try again.`);
                showToast(`Chat error: ${err.message}`, "error");
            } finally {
                if (typingEl) typingEl.classList.remove("hidden");
                if (sendBtn) {
                    sendBtn.disabled = false;
                    sendBtn.classList.remove("opacity-50", "cursor-not-allowed");
                }
            }
        }

        function applyChatSuggestionToRecommender(encodedGoal, budget, encodedExclusions, autoGenerate = false) {
            const goal = decodeURIComponent(encodedGoal);
            const exclusions = decodeURIComponent(encodedExclusions);

            const goalInput = document.getElementById("goalTextInput");
            const budgetInput = document.getElementById("budgetInput");
            const exclusionsInput = document.getElementById("exclusionsInput");

            if (goalInput) {
                goalInput.value = goal;
                const counter = document.getElementById("charCounter");
                if (counter) counter.textContent = `${goal.length} / 500`;
            }
            if (budgetInput && budget) budgetInput.value = budget;
            if (exclusionsInput) exclusionsInput.value = exclusions;

            switchTab("prototype");
            showToast("Applied suggested goal to Listener Controls!", "success");

            if (autoGenerate) {
                setTimeout(() => {
                    generateGoalQueue();
                }, 300);
            }
        }

        function applyLearnedTasteToRecommender() {
            if (!CHAT_TASTE_INSIGHTS.length) {
                showToast("Chat with the AI first to discover custom taste preferences.", "info");
                return;
            }
            switchTab("prototype");
            showToast(`Syncing ${CHAT_TASTE_INSIGHTS.length} chat preference(s) with Goal Mode...`, "info");
            setTimeout(() => {
                generateGoalQueue();
            }, 300);
        }