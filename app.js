// Global state
        let CATALOG_ITEMS = [];
        let PLAYLIST_ITEMS = [];
        let playlistPreferenceSummary = "";
        let playlistVideoIds = new Set();
        let NORMALIZED_PLAYLIST = null;
        let PENDING_PLAYLIST = null;
        let CHAT_HISTORY = [];
        let CONFIRMED_TASTE_INSIGHTS = [];
        let PENDING_TASTE_INSIGHTS = [];
        let LAST_RECOMMENDATION_DATA = null;
        let DEMO_PROFILE = null;

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

        // Preset Scenarios
        const SCENARIOS = {
            1: {
                goal: "Find new indie and alternative music with atmospheric guitars and thoughtful lyrics, similar to my playlist.",
                budget: 30,
                exclusions: "country, holiday music"
            },
            2: {
                goal: "Build a calm focus queue of ambient, downtempo, and instrumental electronic music similar to my playlist.",
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
        window.onload = async function() {
            renderCatalogTable();
            setupCharCounter();
            await loadSavedListenerProfile();
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
            const chatView = document.getElementById("chatTabView");
            const protoBtn = document.getElementById("tabBtnPrototype");
            const chatBtn = document.getElementById("tabBtnChat");

            const activeClass = "tab-active px-4 py-2 text-xs font-semibold rounded-lg text-white transition flex items-center space-x-2";
            const inactiveClass = "px-4 py-2 text-xs font-semibold rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition flex items-center space-x-2 border border-slate-700";

            protoView.classList.add("hidden");
            chatView.classList.add("hidden");
            protoBtn.className = inactiveClass;
            chatBtn.className = inactiveClass;
            protoBtn.setAttribute("aria-selected", "false");
            chatBtn.setAttribute("aria-selected", "false");

            if (tabId === "prototype") {
                protoView.classList.remove("hidden");
                protoBtn.className = activeClass;
                protoBtn.setAttribute("aria-selected", "true");
            } else if (tabId === "chat") {
                chatView.classList.remove("hidden");
                chatBtn.className = activeClass;
                chatBtn.setAttribute("aria-selected", "true");
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
            const demoReferenceIds = new Set(
                (DEMO_PROFILE?.tracks || []).map(track => `db:${track.catalog_track_id}`)
            );
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
                        ${demoReferenceIds.has(String(item.id)) ? '<span class="ml-1.5 bg-amber-900/60 text-amber-300 border border-amber-700/50 text-[9px] px-1.5 py-0.5 rounded font-sans inline-flex items-center">Sample reference</span>' : ''}
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
            return (title || "").normalize("NFKC").toLowerCase()
                .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
                .replace(/\s+[-–—]\s+(?:official\s+)?(?:\d{4}\s+)?(?:audio|(?:music\s+)?video|lyrics?|visualizer|remaster(?:ed)?|live|cover|instrumental|remix|version|edit)\b.*$/i, " ")
                .replace(/\b(official|audio|video|lyrics?|lyric video|live|remaster(ed)?|visualizer|music video|hd|4k|extended|edit|version|remix|cover|instrumental|sped|slowed)\b/g, " ")
                .replace(/[^\p{L}\p{N}]+/gu, " ")
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
            if (!PENDING_PLAYLIST?.tracks.length) return;
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
            appendDemoProfileTracks();
            document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} catalog tracks loaded`;
            renderPlaylistHistory();
            renderCatalogTable();
            refreshChatContextDisplay();
            showToast(`Using ${PLAYLIST_ITEMS.length} reviewed tracks from "${NORMALIZED_PLAYLIST.playlistName}".`, "success");
        }

        async function loadPlaylistJsonFile() {
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
            try {
                const profile = {
                    playlist: NORMALIZED_PLAYLIST,
                    demoProfileId: DEMO_PROFILE?.profile.listener_id ?? null,
                    tasteSummary: document.getElementById("listenerTasteSummary").value.trim(),
                    explicitPreferences: document.getElementById("listenerExplicitPreferences").value.trim(),
                    confirmedLearnedPreferences: CONFIRMED_TASTE_INSIGHTS
                };
                sessionStorage.setItem("goalModeListenerProfile", JSON.stringify(profile));
                document.getElementById("profileSaveStatus").textContent = "Saved in this session";
                showToast("Listener profile saved for this browser session.", "success");
            } catch (err) {
                showToast(`Could not save listener profile: ${err.message}`, "error");
            }
        }

        async function loadSavedListenerProfile() {
            try {
                const saved = sessionStorage.getItem("goalModeListenerProfile");
                if (!saved) return;
                const profile = JSON.parse(saved);
                document.getElementById("listenerTasteSummary").value = profile.tasteSummary || "";
                document.getElementById("listenerExplicitPreferences").value = profile.explicitPreferences || "";
                const hasConfirmedPreferences = Array.isArray(profile.confirmedLearnedPreferences);
                CONFIRMED_TASTE_INSIGHTS = hasConfirmedPreferences
                    ? profile.confirmedLearnedPreferences.filter(insight => typeof insight === "string" && insight.trim())
                    : [];
                PENDING_TASTE_INSIGHTS = hasConfirmedPreferences
                    ? []
                    : Array.isArray(profile.learnedPreferences)
                        ? profile.learnedPreferences.filter(insight => typeof insight === "string" && insight.trim())
                        : [];
                if (!hasConfirmedPreferences && Object.prototype.hasOwnProperty.call(profile, "learnedPreferences")) {
                    delete profile.learnedPreferences;
                    profile.confirmedLearnedPreferences = [];
                    sessionStorage.setItem("goalModeListenerProfile", JSON.stringify(profile));
                }
                if (profile.playlist?.tracks?.length) {
                    NORMALIZED_PLAYLIST = profile.playlist;
                    PENDING_PLAYLIST = JSON.parse(JSON.stringify(profile.playlist));
                    setPlaylistReview(PENDING_PLAYLIST);
                    confirmPlaylistReview();
                }
                if (Number.isInteger(profile.demoProfileId) && profile.demoProfileId > 0) {
                    await loadDemoProfileById(profile.demoProfileId);
                }
                document.getElementById("profileSaveStatus").textContent = "Restored for this session";
                renderLearnedTasteNotes();
                renderPendingTasteInsights();
            } catch (err) {
                showToast(`Could not restore listener profile: ${err.message}`, "error");
            }
        }

        function clearListenerData(skipConfirm = false) {
            if (!skipConfirm && !confirm("Clear this session's playlist, profile, and learned taste preferences?")) return;
            try {
                sessionStorage.removeItem("goalModeListenerProfile");
                sessionStorage.removeItem("goalModePreviouslyRecommended");
                sessionStorage.removeItem("goalModePreviouslyRecommendedTracks");
            } catch (err) {
                showToast(`Could not clear saved listener data: ${err.message}`, "error");
                return;
            }
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
            CONFIRMED_TASTE_INSIGHTS = [];
            PENDING_TASTE_INSIGHTS = [];
            DEMO_PROFILE = null;
            CHAT_HISTORY = [];
            LAST_RECOMMENDATION_DATA = null;
            document.getElementById("demoProfileDetails").classList.add("hidden");
            document.getElementById("clearDemoProfileBtn").classList.add("hidden");
            document.getElementById("demoProfileStatus").textContent = "No sample profile loaded.";
            document.getElementById("demoProfileIdInput").value = "1";
            renderPlaylistHistory();
            renderCatalogTable();
            renderLearnedTasteNotes();
            renderPendingTasteInsights();
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

        function clearRecommendationHistory() {
            if (!confirm("Clear previously recommended tracks for this session? Your playlist and profile will be kept.")) return;
            try {
                sessionStorage.removeItem("goalModePreviouslyRecommended");
                sessionStorage.removeItem("goalModePreviouslyRecommendedTracks");
                showToast("Recommendation history cleared. You can generate the queue again.", "success");
            } catch (err) {
                showToast(`Could not clear recommendation history: ${err.message}`, "error");
            }
        }

        function rememberRecommendedIds(recommendations) {
            const ids = new Set(getPreviouslyRecommendedIds());
            recommendations.forEach(item => ids.add(item.content_id));
            sessionStorage.setItem("goalModePreviouslyRecommended", JSON.stringify([...ids]));
            const tracks = getPreviouslyRecommendedTracks();
            const knownIds = new Set(tracks.map(track => String(track.id)));
            recommendations.forEach(recommendation => {
                const item = CATALOG_ITEMS.find(candidate => String(candidate.id) === String(recommendation.content_id));
                if (item && !knownIds.has(String(item.id))) {
                    tracks.push({ id: String(item.id), title: item.title, artist: item.artist });
                    knownIds.add(String(item.id));
                }
            });
            sessionStorage.setItem("goalModePreviouslyRecommendedTracks", JSON.stringify(tracks));
        }

        function getPreviouslyRecommendedTracks() {
            const tracks = JSON.parse(sessionStorage.getItem("goalModePreviouslyRecommendedTracks") || "[]");
            if (!Array.isArray(tracks) || tracks.some(track =>
                !track || typeof track.id !== "string" ||
                typeof track.title !== "string" || typeof track.artist !== "string"
            )) {
                throw new Error("Saved recommendation history is invalid.");
            }
            return tracks;
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
                const durationMs = Number(row.duration_ms);
                const existing = CATALOG_ITEMS.find(item => item.id === id);
                if (existing) {
                    if (Number.isFinite(durationMs) && durationMs > 0) {
                        existing.durationMs = durationMs;
                        existing.durationSeconds = durationMs / 1000;
                        existing.duration = Math.max(1, Math.ceil(durationMs / 60000));
                    }
                    continue;
                }
                const duration = Number.isFinite(durationMs) && durationMs > 0
                    ? Math.max(1, Math.ceil(durationMs / 60000))
                    : 4;
                const profileSources = Array.isArray(row.profile_match) ? row.profile_match : [];
                const tags = ["music-catalog"];
                if (profileSources.length) {
                    tags.push("demo-profile-seed", ...profileSources.map(source => `profile-${source}`));
                }
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
                    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
                    durationSeconds: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : duration * 60,
                    cover: "",
                    tags,
                    catalogMetadata: row
                });
                added += 1;
            }
            if (added) {
                document.getElementById("catalogStatus").textContent =
                    `${CATALOG_ITEMS.length} catalog tracks (${added} matched from music database)`;
                renderCatalogTable();
            }
        }

        function appendDemoProfileTracks() {
            if (!DEMO_PROFILE?.tracks?.length) return;
            mergeDatabaseCatalogRows(DEMO_PROFILE.tracks);
        }

        function formatDemoProfileValue(value) {
            if (typeof value === "boolean") return value ? "Yes" : "No";
            if (value === null || value === undefined || value === "") return "Not provided";
            return String(value);
        }

        function renderDemoProfile() {
            const details = document.getElementById("demoProfileDetails");
            const clearButton = document.getElementById("clearDemoProfileBtn");
            const status = document.getElementById("demoProfileStatus");
            if (!DEMO_PROFILE) {
                details.classList.add("hidden");
                clearButton.classList.add("hidden");
                status.textContent = "No sample profile loaded.";
                return;
            }
            const profile = DEMO_PROFILE.profile;
            const rows = [
                ["Top artist", profile.top_artist],
                ["Top genre", profile.top_genre],
                ["Top mood", profile.top_mood],
                ["Platform", profile.platform],
                ["Subscription", profile.subscription],
                ["Country", profile.country],
                ["Age", profile.age],
                ["Daily listening", `${profile.daily_listening_minutes} min`],
                ["Songs per day", profile.songs_per_day],
                ["Skip rate", `${profile.skip_rate_pct}%`],
                ["Playlists", profile.playlists_count],
                ["Discover Weekly", profile.discover_weekly_user],
                ["Offline mode", profile.uses_offline_mode],
                ["Podcasts too", profile.podcasts_too]
            ];
            details.innerHTML = rows.map(([label, value]) => `
                <div class="min-w-0"><span class="block text-slate-500">${escapeHtml(label)}</span>
                    <span class="block truncate text-slate-200">${escapeHtml(formatDemoProfileValue(value))}</span></div>
            `).join("");
            details.classList.remove("hidden");
            clearButton.classList.remove("hidden");
            const artistStatus = DEMO_PROFILE.artist_mapping_status;
            const genreStatus = DEMO_PROFILE.genre_mapping_status;
            const mappedGenre = DEMO_PROFILE.matched_genre?.genre_name;
            const noGenreReferences = genreStatus === "matched" && !DEMO_PROFILE.tracks.some(track => track.profile_match.includes("top_genre"));
            status.textContent = `Loaded sample #${profile.listener_id}. Artist: ${artistStatus}; genre: ${genreStatus}${mappedGenre ? ` (${mappedGenre})` : ""}${noGenreReferences ? ", no genre references among these matches" : ""}. ${DEMO_PROFILE.tracks.length} catalog matches are taste references, eligible when requesting the sample's top artist.`;
            status.className = "text-[10px] text-emerald-300";
        }

        async function loadDemoProfile() {
            const listenerId = Number(document.getElementById("demoProfileIdInput").value);
            if (!Number.isInteger(listenerId) || listenerId < 1 || listenerId > 4000) {
                showToast("Enter a demo listener ID from 1 to 4,000.", "warning");
                return;
            }
            await loadDemoProfileById(listenerId);
        }

        async function loadDemoProfileById(listenerId) {
            const button = document.getElementById("loadDemoProfileBtn");
            const status = document.getElementById("demoProfileStatus");
            button.disabled = true;
            button.classList.add("opacity-50", "cursor-not-allowed");
            status.textContent = `Loading demo listener #${listenerId} and matching catalog tracks...`;
            status.className = "text-[10px] text-blue-300";
            try {
                const response = await fetch(`/api/demo-profile/${listenerId}`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || `Demo profile HTTP ${response.status}`);
                if (
                    !data.profile || data.profile.listener_id !== listenerId ||
                    !Array.isArray(data.tracks) ||
                    typeof data.profile.top_artist !== "string" ||
                    typeof data.profile.top_genre !== "string" ||
                    typeof data.profile.top_mood !== "string" ||
                    !["matched", "unmatched", "ambiguous"].includes(data.artist_mapping_status) ||
                    !["matched", "unmatched", "ambiguous"].includes(data.genre_mapping_status) ||
                    data.tracks.some(track =>
                        !track ||
                        (typeof track.catalog_track_id !== "string" && typeof track.catalog_track_id !== "number") ||
                        typeof track.title !== "string" ||
                        typeof track.artist !== "string" ||
                        !Array.isArray(track.profile_match) ||
                        track.profile_match.some(source => !["top_artist", "top_genre"].includes(source))
                    )
                ) {
                    throw new Error("The local service returned an invalid demo profile.");
                }
                CATALOG_ITEMS = CATALOG_ITEMS.filter(item => !item.tags.includes("demo-profile-seed"));
                DEMO_PROFILE = data;
                appendDemoProfileTracks();
                document.getElementById("demoProfileIdInput").value = String(listenerId);
                renderDemoProfile();
                renderCatalogTable();
                refreshChatContextDisplay();
            } catch (err) {
                status.textContent = `Could not load demo profile: ${err.message}`;
                status.className = "text-[10px] text-red-300";
                showToast(`Could not load demo profile: ${err.message}`, "error");
            } finally {
                button.disabled = false;
                button.classList.remove("opacity-50", "cursor-not-allowed");
            }
        }

        function clearDemoProfile() {
            DEMO_PROFILE = null;
            CATALOG_ITEMS = CATALOG_ITEMS.filter(item => !item.tags.includes("demo-profile-seed"));
            try {
                const saved = sessionStorage.getItem("goalModeListenerProfile");
                if (saved) {
                    const profile = JSON.parse(saved);
                    profile.demoProfileId = null;
                    sessionStorage.setItem("goalModeListenerProfile", JSON.stringify(profile));
                }
            } catch (err) {
                showToast(`Could not clear the saved demo profile selection: ${err.message}`, "error");
            }
            renderDemoProfile();
            renderCatalogTable();
            refreshChatContextDisplay();
        }

        function getDemoTasteContext() {
            if (!DEMO_PROFILE?.profile) return "None";
            const profile = DEMO_PROFILE.profile;
            return [
                `Top artist: ${profile.top_artist}`,
                `Top genre: ${profile.top_genre}`,
                `Top mood: ${profile.top_mood}`
            ].join("; ");
        }

        function getDemoCatalogContext() {
            if (!DEMO_PROFILE?.tracks?.length) return "None";
            return DEMO_PROFILE.tracks.slice(0, 12)
                .map(track => `${track.title} — ${track.artist} (${track.genre || "genre unavailable"}; ${track.profile_match.join(", ")})`)
                .join("\n");
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

        function trackTitleKey(track) {
            if (!track || typeof track.title !== "string") return "";
            return normalizeSongKey(track.title) ||
                track.title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
        }

        function trackTitleKeys(track) {
            const keys = [trackTitleKey(track)];
            if (!track || typeof track.title !== "string" || typeof track.artist !== "string") {
                return keys.filter(Boolean);
            }
            const artist = trackTitleKey({ title: track.artist.replace(/\s+[-–—]\s+topic\s*$/i, "") });
            const parts = track.title.split(/\s+[-–—]\s+/);
            let prefixCount = 0;
            while (
                artist &&
                prefixCount < parts.length - 1 &&
                trackTitleKey({ title: parts[prefixCount] }) === artist
            ) {
                prefixCount += 1;
            }
            if (prefixCount) keys.push(trackTitleKey({ title: parts.slice(prefixCount).join(" - ") }));
            return keys.filter(Boolean);
        }

        function playlistTitleKeys(track) {
            const keys = [trackTitleKey(track)];
            if (typeof track.title !== "string") return keys.filter(Boolean);
            const parts = track.title.split(/\s+[-–—]\s+/);
            if (parts.length >= 2) {
                keys.push(...parts.map(title => trackTitleKey({ title })));
            }
            return keys.filter(Boolean);
        }

        function similarReferenceTitle(title, referenceTitles) {
            const characters = Array.from(title);
            if (characters.length < 8) return false;
            for (const candidate of referenceTitles) {
                const other = Array.from(candidate);
                if (other.length < 8) continue;
                const limit = Math.max(characters.length, other.length) >= 12 ? 2 : 1;
                if (Math.abs(characters.length - other.length) > limit) continue;
                let previous = Array.from(
                    { length: other.length + 1 },
                    (_, index) => index <= limit ? index : limit + 1
                );
                for (let i = 0; i < characters.length; i += 1) {
                    const current = Array(other.length + 1).fill(limit + 1);
                    if (i + 1 <= limit) current[0] = i + 1;
                    let minimum = current[0];
                    for (let j = Math.max(1, i + 1 - limit); j <= Math.min(other.length, i + 1 + limit); j += 1) {
                        current[j] = Math.min(
                            current[j - 1] + 1,
                            previous[j] + 1,
                            previous[j - 1] + (characters[i] === other[j - 1] ? 0 : 1)
                        );
                        minimum = Math.min(minimum, current[j]);
                    }
                    previous = current;
                    if (minimum > limit) break;
                }
                if (previous[other.length] <= limit) return true;
            }
            return false;
        }

        function isExcludedTitle(title, exclusions) {
            return Boolean(title) && (
                exclusions.titles.has(title) ||
                similarReferenceTitle(title, exclusions.referenceFuzzyTitles)
            );
        }

        function artistCreditMatches(credits, artist) {
            if (typeof credits !== "string" || !artist) return false;
            const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`(?:^|,\\s*)${escaped}(?=\\s*(?:,|$))`, "i").test(credits);
        }

        function getRecommendationExclusions(ids = [], sampleArtist = null) {
            const excludedIds = new Set(ids.map(id => String(id)));
            PLAYLIST_ITEMS.forEach(track => excludedIds.add(`playlist:${track.id}`));
            const demoTracks = (DEMO_PROFILE?.tracks || []).filter(
                track => !sampleArtist || !artistCreditMatches(track.artist, sampleArtist)
            );
            demoTracks.forEach(track => excludedIds.add(`db:${track.catalog_track_id}`));
            const knownTracks = [
                ...PLAYLIST_ITEMS,
                ...demoTracks,
                ...getPreviouslyRecommendedTracks().filter(track => excludedIds.has(track.id)),
                ...CATALOG_ITEMS.filter(track => excludedIds.has(String(track.id)))
            ];
            const excludedIdentities = new Set(knownTracks.map(trackIdentityKey).filter(Boolean));
            const playlistTitles = new Set(PLAYLIST_ITEMS.flatMap(playlistTitleKeys));
            const referenceFuzzyTitles = new Set(PLAYLIST_ITEMS.flatMap(track => {
                const artist = trackTitleKey({
                    title: typeof track.artist === "string"
                        ? track.artist.replace(/\s+[-–—]\s+topic\s*$/i, "")
                        : ""
                });
                return playlistTitleKeys(track).filter(title => title !== artist);
            }));
            demoTracks.flatMap(trackTitleKeys).forEach(title => referenceFuzzyTitles.add(title));
            const excludedTitles = new Set([
                ...playlistTitles,
                ...knownTracks.flatMap(trackTitleKeys)
            ]);
            return { ids: excludedIds, identities: excludedIdentities, titles: excludedTitles, referenceFuzzyTitles };
        }

        function filterExcludedRecommendations(recommendations, exclusions) {
            const seenIds = new Set();
            const seenIdentities = new Set();
            const seenTitles = new Set();
            return recommendations.filter(recommendation => {
                const id = String(recommendation.content_id);
                const item = CATALOG_ITEMS.find(candidate => String(candidate.id) === id);
                const identity = item ? trackIdentityKey(item) : "";
                const titles = item ? trackTitleKeys(item) : [];
                if (
                    exclusions.ids.has(id) ||
                    (identity && exclusions.identities.has(identity)) ||
                    titles.some(title => isExcludedTitle(title, exclusions)) ||
                    seenIds.has(id) ||
                    (identity && seenIdentities.has(identity)) ||
                    titles.some(title => seenTitles.has(title))
                ) {
                    return false;
                }
                seenIds.add(id);
                if (identity) seenIdentities.add(identity);
                titles.forEach(title => seenTitles.add(title));
                return true;
            });
        }

        class InvalidAiResponseError extends Error {}

        async function fetchExternalDiscoveryTracks({
            goalText,
            budgetMins,
            preferredTopics,
            excludedTopics,
            existingIds,
            currentTracks = [],
            listenerContext = "",
            attemptedTracks = [],
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
5. TARGET Duration Range: Propose up to ${Math.min(30, Math.max(6, Math.ceil(budgetMins / 4) * 2))} distinct tracks so that catalog verification can discard mismatches; the application will select tracks that fit the ${budgetMins}-minute budget.
6. OUTPUT SIZE: Do not add commentary outside the JSON object.
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
Previously attempted tracks to avoid: ${JSON.stringify(attemptedTracks)}
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
                    throw new InvalidAiResponseError("AI discovery response did not include a tracks array.");
                }
                if (result.tracks.some(track =>
                    !track ||
                    typeof track !== "object" ||
                    typeof track.title !== "string" ||
                    !track.title.trim() ||
                    track.title.length > 300 ||
                    typeof track.artist !== "string" ||
                    !track.artist.trim() ||
                    track.artist.length > 300
                )) {
                    throw new InvalidAiResponseError("AI discovery response included an invalid track.");
                }
                attemptedTracks.push(...result.tracks.map(track => `${track.artist} - ${track.title}`));

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
                const seenTitles = new Set();
                return verificationData.tracks.flatMap(verifiedTrack => {
                    const id = `db:${verifiedTrack.catalog_track_id}`;
                    const item = CATALOG_ITEMS.find(candidate => candidate.id === id);
                    if (!item) {
                        throw new Error("A catalog-verified track could not be loaded into the candidate catalog.");
                    }
                    const identity = trackIdentityKey(item);
                    const titles = trackTitleKeys(item);
                    if (
                        exclusions.ids.has(id) ||
                        exclusions.ids.has(String(verifiedTrack.catalog_track_id)) ||
                        (identity && exclusions.identities.has(identity)) ||
                        titles.some(title => isExcludedTitle(title, exclusions)) ||
                        seenIds.has(id) ||
                        (identity && seenIdentities.has(identity)) ||
                        titles.some(title => seenTitles.has(title))
                    ) {
                        return [];
                    }
                    seenIds.add(id);
                    if (identity) seenIdentities.add(identity);
                    titles.forEach(title => {
                        seenTitles.add(title);
                        exclusions.titles.add(title);
                    });
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

        async function loadMoreTracksForPrompt() {
            const goalText = document.getElementById("goalTextInput").value.trim();
            const budgetMins = parseInt(document.getElementById("budgetInput").value) || 30;
            const explicitExclusions = document.getElementById("exclusionsInput").value.trim();

            if (!goalText) {
                showToast("Please enter a goal or prompt description first.", "warning");
                document.getElementById("goalTextInput").focus();
                return;
            }

            showToast(`Loading authentic tracks for "${goalText}" into candidate catalog...`, "info");
            setLoading(true);
            setGenerationProgress(12, "Asking the AI for matching tracks", "Catalog verification will follow");
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
                    document.getElementById("catalogStatus").textContent = `${CATALOG_ITEMS.length} catalog tracks (${discovered.length} loaded from prompt)`;
                    renderCatalogTable();
                    setGenerationProgress(100, "Prompt tracks loaded", `${discovered.length} verified tracks added to the candidate catalog`);
                    showToast(`Loaded ${discovered.length} songs for "${goalText}" into candidate catalog!`, "success");
                } else {
                    setGenerationProgress(100, "No new prompt tracks found", "The catalog did not return additional matches");
                    showToast("AI did not find any new matching tracks.", "warning");
                }
            } catch (err) {
                setGenerationProgress(100, "Prompt track loading failed", "No unverified tracks were added");
                showToast(`Could not load tracks from the local AI service: ${err.message}`, "error");
            } finally {
                setTimeout(() => setLoading(false), 350);
            }
        }

        async function fetchSemanticCatalogCandidates(goal, excludeTerms, limit = 40) {
            const response = await fetch("/api/catalog/semantic-candidates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ goal, exclude_terms: excludeTerms, limit })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Semantic catalog search failed with HTTP ${response.status}.`);
            if (!Array.isArray(data.candidates)) {
                throw new Error("The semantic catalog returned an invalid candidate list.");
            }
            return data.candidates;
        }

        async function fetchCatalogCandidates(goal, excludeTerms, offset = 0) {
            const response = await fetch("/api/catalog/candidates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ goal, exclude_terms: excludeTerms, offset })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Catalog search failed with HTTP ${response.status}.`);
            if (
                !Array.isArray(data.goal_candidates) ||
                !Array.isArray(data.fallback_candidates) ||
                (data.next_offset !== null && (!Number.isInteger(data.next_offset) || data.next_offset <= offset))
            ) {
                throw new Error("The catalog returned an invalid candidate page.");
            }
            return data;
        }

        function trackDurationMs(item) {
            if (Number.isFinite(item.durationMs) && item.durationMs > 0) return item.durationMs;
            if (Number.isFinite(item.durationSeconds) && item.durationSeconds > 0) return item.durationSeconds * 1000;
            return item.duration * 60000;
        }

        function formatDuration(durationMs) {
            const seconds = Math.floor(durationMs / 1000);
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        }

        function setGenerationProgress(percent, title, subtitle) {
            const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
            const bar = document.getElementById("loadingProgressBar");
            const label = document.getElementById("loadingProgressPercent");
            if (bar && bar.style) {
                bar.style.width = `${clamped}%`;
                if (typeof bar.setAttribute === "function") bar.setAttribute("aria-valuenow", String(clamped));
            }
            if (label) label.textContent = `${clamped}%`;
            const titleElement = document.getElementById("loadingStateTitle");
            if (title && titleElement) titleElement.textContent = title;
            const subtitleElement = document.getElementById("loadingStateSubtitle");
            if (subtitle && subtitleElement) subtitleElement.textContent = subtitle;
        }

        async function yieldForProgressFrame() {
            await new Promise(resolve => {
                if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(() => resolve());
                } else if (typeof setTimeout === "function") {
                    setTimeout(resolve, 0);
                } else {
                    resolve();
                }
            });
        }

        async function generateGoalQueue() {
            const goalText = document.getElementById("goalTextInput").value.trim();
            const budgetMins = Number(document.getElementById("budgetInput").value);
            const excludedTopics = document.getElementById("exclusionsInput").value
                .split(",").map(topic => topic.trim()).filter(Boolean);
            const listenerTasteSummary = document.getElementById("listenerTasteSummary").value.trim();
            const listenerPreferences = document.getElementById("listenerExplicitPreferences").value.trim();
            if (!goalText) {
                showToast("Please enter a listening goal description.", "warning");
                document.getElementById("goalTextInput").focus();
                return;
            }
            if (!Number.isInteger(budgetMins) || budgetMins < 1 || budgetMins > 120) {
                showToast("Enter a duration from 1 to 120 minutes.", "warning");
                return;
            }
            if (excludedTopics.length > 20 || excludedTopics.some(topic => topic.length > 100)) {
                showToast("Use at most 20 exclusions of 100 characters each.", "warning");
                return;
            }

            const sampleArtistReference = /\b(?:my|the)\s+(?:top|favorite|favourite)\s+artist\b/i;
            const directSampleArtistRequest =
                !/\b(?:similar|like|related|inspired|style)\b/i.test(goalText) &&
                (/^(?:my|the)\s+(?:top|favorite|favourite)\s+artist[.!?]*$/i.test(goalText) ||
                 /\b(?:songs?|tracks?|music|playlist)\s+(?:by|from)\s+(?:my|the)\s+(?:top|favorite|favourite)\s+artist\b/i.test(goalText));
            const sampleArtist = directSampleArtistRequest ? DEMO_PROFILE?.profile?.top_artist?.trim() : null;
            if (directSampleArtistRequest && !sampleArtist) {
                showToast("Load a sample profile or name an artist in your goal.", "warning");
                return;
            }
            const searchGoal = sampleArtist ? goalText.replace(sampleArtistReference, sampleArtist) : goalText;
            let exclusions;
            let referenceExclusions;
            try {
                exclusions = getRecommendationExclusions(getPreviouslyRecommendedIds(), sampleArtist);
                if (sampleArtist) referenceExclusions = getRecommendationExclusions([], sampleArtist);
            } catch (err) {
                showToast(`Could not read recommendation history: ${err.message}`, "error");
                return;
            }
            setLoading(true);
            setGenerationProgress(8, "Searching the catalog...", "Matching exact goal terms and exclusions");
            document.getElementById("loadingStateTitle").textContent = "Finding catalog tracks for your goal...";
            document.getElementById("loadingStateSubtitle").textContent = "Ranking goal matches, then filling with eligible tracks";
            const targetMs = budgetMins * 60000;
            const exclusionTokens = excludedTopics.map(topic => topic.toLowerCase());
            const candidates = [];
            const seenIds = new Set();
            const seenTitles = new Set();
            const selectedIds = new Set();
            const recommendations = [];
            const stats = { proposed: 0, verified: 0, excluded: 0, ai_proposed: 0, ai_ranked: 0, search_fill: 0, broad_fill: 0, artist_matches: 0, history_excluded: 0 };
            let totalMs = 0;
            let rankingError = "";
            let catalogError = "";

            function addRows(rows, source) {
                const validRows = [];
                for (const row of rows) {
                    if (!row || (typeof row.catalog_track_id !== "string" && typeof row.catalog_track_id !== "number")) {
                        throw new Error("The catalog returned a track without a valid ID.");
                    }
                    const id = `db:${row.catalog_track_id}`;
                    if (seenIds.has(id)) continue;
                    seenIds.add(id);
                    stats.proposed += 1;
                    const durationMs = Number(row.duration_ms);
                    if (
                        typeof row.title !== "string" || !row.title.trim() ||
                        typeof row.artist !== "string" || !row.artist.trim() ||
                        !Number.isFinite(durationMs) || durationMs <= 0
                    ) continue;
                    stats.verified += 1;
                    validRows.push(row);
                }
                mergeDatabaseCatalogRows(validRows);
                for (const row of validRows) {
                    const item = CATALOG_ITEMS.find(candidate => candidate.id === `db:${row.catalog_track_id}`);
                    if (item && exclusions.ids.has(String(item.id))) {
                        const identity = trackIdentityKey(item);
                        if (identity) exclusions.identities.add(identity);
                        trackTitleKeys(item).forEach(title => exclusions.titles.add(title));
                    }
                }
                for (const row of validRows) {
                    const item = CATALOG_ITEMS.find(candidate => candidate.id === `db:${row.catalog_track_id}`);
                    if (!item) throw new Error("A catalog candidate could not be loaded.");
                    const titles = trackTitleKeys(item);
                    const identity = trackIdentityKey(item);
                    const searchText = `${item.title} ${item.artist} ${item.tags.join(" ")}`.toLowerCase();
                    const matchesArtist = !sampleArtist || artistCreditMatches(item.artist, sampleArtist);
                    const excludedByReference = referenceExclusions && (
                        referenceExclusions.ids.has(String(item.id)) ||
                        (identity && referenceExclusions.identities.has(identity)) ||
                        titles.some(title => isExcludedTitle(title, referenceExclusions))
                    );
                    const excludedByHistoryOrReference =
                        exclusions.ids.has(String(item.id)) ||
                        (identity && exclusions.identities.has(identity)) ||
                        titles.some(title => isExcludedTitle(title, exclusions));
                    if (sampleArtist && matchesArtist) {
                        stats.artist_matches += 1;
                        if (excludedByHistoryOrReference && !excludedByReference) stats.history_excluded += 1;
                    }
                    if (
                        !matchesArtist ||
                        excludedByHistoryOrReference ||
                        titles.some(title => seenTitles.has(title)) ||
                        exclusionTokens.some(topic => searchText.includes(topic))
                    ) {
                        stats.excluded += 1;
                        continue;
                    }
                    titles.forEach(title => seenTitles.add(title));
                    candidates.push({ item, source });
                }
            }

            function selectCandidate(candidate, reason, source) {
                const item = candidate.item;
                if (selectedIds.has(item.id) || totalMs >= targetMs) return;
                selectedIds.add(item.id);
                totalMs += trackDurationMs(item);
                stats[source] += 1;
                recommendations.push({ content_id: item.id, reason, source });
            }

            try {
                const preloadedRows = CATALOG_ITEMS.filter(item => item.isDiscoveredMatch && item.catalogMetadata)
                    .map(item => item.catalogMetadata);
                let page = await fetchCatalogCandidates(searchGoal, excludedTopics, 0);
                addRows(page.goal_candidates, "search");
                setGenerationProgress(32, "Catalog matches found", `${stats.verified} usable tracks are being evaluated`);
                await yieldForProgressFrame();
                addRows(preloadedRows, "fallback");
                addRows(page.fallback_candidates, "fallback");
                if (!sampleArtist) {
                    try {
                        const semanticRows = await fetchSemanticCatalogCandidates(goalText, excludedTopics, 40);
                        addRows(semanticRows, "search");
                    } catch (err) {
                        console.warn("Semantic catalog retrieval unavailable:", err);
                    }
                }
                setGenerationProgress(42, "Ranking the best matches...", `${candidates.length} eligible tracks in the candidate pool`);
                await yieldForProgressFrame();

                const systemPrompt = `Rank catalog tracks for the listener's goal. The goal has priority over profile and playlist taste signals.
Return only tracks that plausibly match the goal, ranked best first. Select only exact IDs from the candidate list.
Do not invent tracks. ${sampleArtist ? "Sample reference tracks by the sample's top artist are eligible." : "Do not select reference tracks."} If none match, return an empty array.
Return only JSON: {"recommendations":[{"content_id":"EXACT_ID","reason":"brief goal-specific reason"}]}.`;
                for (let pass = 0; pass < 3 && totalMs < targetMs; pass += 1) {
                    setGenerationProgress(48 + (pass * 12), `AI ranking pass ${pass + 1} of 3`, `${recommendations.length} tracks selected so far`);
                    const pool = candidates.filter(candidate => !selectedIds.has(candidate.item.id)).slice(0, 40);
                    if (!pool.length) break;
                    const userPrompt = [
                        `Goal: ${searchGoal}`,
                        `Explicit exclusions: ${excludedTopics.join(", ") || "None"}`,
                        `Listener taste summary: ${listenerTasteSummary || "None"}`,
                        `Listener preferences: ${listenerPreferences || "None"}`,
                        `Sample taste signals: ${getDemoTasteContext()}`,
                        `Confirmed chat preferences: ${CONFIRMED_TASTE_INSIGHTS.join("; ") || "None"}`,
                        `Playlist examples (taste references only): ${JSON.stringify(PLAYLIST_ITEMS.slice(0, 20).map(track => `${track.artist} - ${track.title}`))}`,
                        `Remaining target: ${formatDuration(targetMs - totalMs)}`,
                        `Catalog candidates: ${JSON.stringify(pool.map(({ item }) => ({
                            id: item.id, title: item.title, artist: item.artist,
                            duration_seconds: item.durationSeconds, tags: item.tags.slice(0, 5)
                        })))}`
                    ].join("\n");
                    try {
                        const result = await requestAiJson(systemPrompt, userPrompt, "recommendation", true);
                        if (!Array.isArray(result.recommendations) || result.recommendations.some(recommendation =>
                            !recommendation || typeof recommendation !== "object" ||
                            (typeof recommendation.content_id !== "string" && typeof recommendation.content_id !== "number")
                        )) {
                            throw new InvalidAiResponseError("AI ranking response included an invalid recommendations array.");
                        }
                        const ranked = normalizeRecommendations(result.recommendations);
                        rankingError = "";
                        stats.ai_proposed += ranked.length;
                        const byId = new Map(pool.map(candidate => [candidate.item.id, candidate]));
                        for (const recommendation of ranked) {
                            const candidate = byId.get(String(recommendation.content_id));
                            if (!candidate) continue;
                            const reason = typeof recommendation.reason === "string" && recommendation.reason.trim()
                                ? recommendation.reason
                                : "AI ranked this catalog track for the listening goal.";
                            selectCandidate(candidate, reason, "ai_ranked");
                        }
                        if (recommendations.length) {
                            renderResults({
                                normalized_goal: goalText,
                                preferred_topics: [goalText],
                                excluded_topics: excludedTopics,
                                recommendations,
                                status: "generating",
                                ai_comment: `${recommendations.length} tracks selected; generation is still in progress.`
                            }, budgetMins, true, sampleArtist);
                            await yieldForProgressFrame();
                        }
                    } catch (err) {
                        console.error("Catalog ranking failed:", err);
                        rankingError = err.message;
                        if (!(err instanceof InvalidAiResponseError)) break;
                    }
                }

                function fillFromCandidates() {
                    for (const candidate of candidates) {
                        const isSearch = candidate.source === "search";
                        selectCandidate(
                            candidate,
                            isSearch
                                ? "Catalog search matched a goal term; added to reach the duration target."
                                : "Broader catalog fallback added to reach the duration target; it may not match the goal.",
                            isSearch ? "search_fill" : "broad_fill"
                        );
                        if (totalMs >= targetMs) break;
                    }
                }

                fillFromCandidates();
                if (recommendations.length) {
                    setGenerationProgress(82, "Filling the listening target", `${formatDuration(totalMs)} of ${formatDuration(targetMs)} reached`);
                    renderResults({
                        normalized_goal: goalText,
                        preferred_topics: [goalText],
                        excluded_topics: excludedTopics,
                        recommendations,
                        status: "generating",
                        ai_comment: `${recommendations.length} tracks selected; checking additional catalog pages if needed.`
                    }, budgetMins, true, sampleArtist);
                    await yieldForProgressFrame();
                }
                while (!sampleArtist && totalMs < targetMs && page.next_offset !== null) {
                    try {
                        page = await fetchCatalogCandidates(searchGoal, excludedTopics, page.next_offset);
                        addRows(page.fallback_candidates, "fallback");
                        fillFromCandidates();
                        setGenerationProgress(86, "Loading more catalog tracks", `${recommendations.length} tracks selected`);
                        if (recommendations.length) {
                            renderResults({
                                normalized_goal: goalText,
                                preferred_topics: [goalText],
                                excluded_topics: excludedTopics,
                                recommendations,
                                status: "generating",
                                ai_comment: `${recommendations.length} tracks selected; generation is still in progress.`
                            }, budgetMins, true, sampleArtist);
                            await yieldForProgressFrame();
                        }
                    } catch (err) {
                        console.error("Could not load additional catalog candidates:", err);
                        catalogError = err.message;
                        break;
                    }
                }

                const filled = totalMs >= targetMs;
                const note = [
                    `Catalog candidates: ${stats.proposed} retrieved, ${stats.verified} with usable details and duration, ${stats.excluded} excluded or duplicate among returned tracks. Explicit exclusions are text-matched against available metadata during catalog search.`,
                    `AI proposed ${stats.ai_proposed}; selected ${stats.ai_ranked} AI-ranked, ${stats.search_fill} goal-search fill, and ${stats.broad_fill} broader fallback tracks.`,
                    `Audio: ${formatDuration(totalMs)} / ${formatDuration(targetMs)} minimum.`,
                    sampleArtist ? `Only catalog tracks credited to the sample's top artist, ${sampleArtist}, were considered; matching sample references were eligible.` : "",
                    sampleArtist ? `${stats.artist_matches} returned track${stats.artist_matches === 1 ? "" : "s"} credit${stats.artist_matches === 1 ? "s" : ""} that artist; ${stats.history_excluded} ${stats.history_excluded === 1 ? "was" : "were"} excluded by recommendation history${stats.history_excluded ? ". Use Clear recommendation history to allow repeats." : "."}` : "",
                    filled ? "The final full track may exceed the target." : "The catalog search did not return enough eligible audio to reach the target.",
                    rankingError ? `AI ranking failed: ${rankingError} Catalog search order was used instead.` : "",
                    catalogError ? `Additional catalog search failed: ${catalogError}` : ""
                ].filter(Boolean).join(" ");
                const data = {
                    normalized_goal: goalText,
                    preferred_topics: [goalText],
                    excluded_topics: excludedTopics,
                    recommendations,
                    selection_stats: stats,
                    status: recommendations.length ? (stats.search_fill || stats.broad_fill ? "catalog_fill" : "discovered_match") : "no_match",
                    ai_comment: note
                };
                setGenerationProgress(100, "Queue ready", "Final exclusions and formatting complete");
                await yieldForProgressFrame();
                renderResults(data, budgetMins, false, sampleArtist);
                if (!filled || rankingError || catalogError) {
                    showToast(filled ? "Queue filled using catalog fallback; see the recommendation note." : "The queue is shorter than requested; see the recommendation note.", "warning");
                } else {
                    showToast("Goal Queue reached the requested minimum duration.", "success");
                }
            } catch (err) {
                console.error("Queue generation error:", err);
                renderResults({
                    normalized_goal: goalText,
                    preferred_topics: [],
                    excluded_topics: excludedTopics,
                    recommendations: [],
                    status: "no_match",
                    ai_comment: `Unable to complete queue generation: ${err.message}`
                }, budgetMins);
                showToast(`Generation failed: ${err.message}`, "error");
            } finally {
                setLoading(false);
            }
        }

        function renderResults(data, requestedBudget, partial = false, sampleArtist = null) {
            document.getElementById("emptyState").classList.add("hidden");
            document.getElementById("outputContent").classList.remove("hidden");

            // Status Badge
            const statusTag = document.getElementById("statusTag");
            const status = data.status || "ok";
            statusTag.textContent = status.replace("_", " ").toUpperCase();
            
            if (partial || status === "generating") {
                statusTag.className = "bg-violet-900/60 text-violet-300 border border-violet-700/50 text-xs px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5";
                statusTag.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles text-violet-400 text-[10px]"></i> BUILDING';
            } else if (status === "ok") {
                statusTag.className = "bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 text-xs px-2.5 py-1 rounded-full font-mono";
            } else if (status === "prompt_expanded" || status === "discovered_match" || status === "outside_discovery") {
                statusTag.className = "bg-purple-900/60 text-purple-300 border border-purple-700/50 text-xs px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5";
                statusTag.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles text-purple-400 text-[10px]"></i> PROMPT MATCHED`;
            } else if (status === "popular_match") {
                statusTag.className = "bg-amber-900/60 text-amber-300 border border-amber-700/50 text-xs px-2.5 py-1 rounded-full font-mono flex items-center gap-1.5";
                statusTag.innerHTML = `<i class="fa-solid fa-fire text-amber-400 text-[10px]"></i> POPULAR MATCH`;
            } else if (status === "catalog_fill") {
                statusTag.className = "bg-amber-900/60 text-amber-300 border border-amber-700/50 text-xs px-2.5 py-1 rounded-full font-mono";
                statusTag.textContent = "CATALOG FILL";
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
            let totalDurationMs = 0;
            let containsExcludedItem = false;
            const recommendations = filterExcludedRecommendations(
                normalizeRecommendations(data.recommendations),
                getRecommendationExclusions(getPreviouslyRecommendedIds(), sampleArtist)
            );
            data.recommendations = recommendations;
            if (!partial) rememberRecommendedIds(recommendations);

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
                    totalDurationMs += trackDurationMs(item);

                    const isViolation = (data.excluded_topics || []).some(ex => 
                        (item.tags || []).some(t => t.toLowerCase().includes(ex.toLowerCase())) ||
                        (item.title || "").toLowerCase().includes(ex.toLowerCase()) ||
                        (item.artist || "").toLowerCase().includes(ex.toLowerCase())
                    );
                    if (isViolation) containsExcludedItem = true;

                    const isDiscovered = rec.source === "ai_ranked" || (
                        !rec.source && (item.tags.includes("outside-discovery") || item.tags.includes("prompt-curated") || item.isDiscoveredMatch)
                    );
                    const isPopular = item.tags.includes("popular-track") || item.isPopularMatch;
                    const isFiller = rec.source === "search_fill" || rec.source === "broad_fill" ||
                        item.tags.includes("budget-filler") || item.isBudgetFiller;
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
                                            ${escapeHtml(formatDuration(trackDurationMs(item)))}
                                        </span>
                                    </div>
                                    <div class="flex items-center space-x-2 mt-0.5">
                                        <span class="text-[11px] text-emerald-300 truncate">${escapeHtml(item.artist)}</span>
                                        ${isDiscovered ? '<span class="bg-purple-900/60 text-purple-300 border border-purple-700/50 text-[9px] px-1.5 py-0.2 rounded font-sans flex items-center gap-1"><i class="fa-solid fa-sparkles text-purple-400 text-[8px]"></i>AI Ranked</span>' : ''}
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
            metricDuration.textContent = `${formatDuration(totalDurationMs)} / ${formatDuration(requestedBudget * 60000)}`;
            metricDuration.className = totalDurationMs >= requestedBudget * 60000 ? "font-semibold text-emerald-400 font-mono" : "font-semibold text-amber-400 font-mono";

            const metricExclusion = document.getElementById("metricExclusion");
            if (containsExcludedItem) {
                metricExclusion.textContent = "Violation Detected";
                metricExclusion.className = "font-semibold text-red-400";
            } else {
                metricExclusion.textContent = "No text matches";
                metricExclusion.className = "font-semibold text-emerald-400";
            }

            if (!partial) {
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
        }

        function setLoading(isLoading) {
            const btn = document.getElementById("generateBtn");
            const clearHistoryBtn = document.getElementById("clearRecommendationHistoryBtn");
            const emptyState = document.getElementById("emptyState");
            const loadingState = document.getElementById("loadingState");
            if (clearHistoryBtn) clearHistoryBtn.disabled = isLoading;

            if (isLoading) {
                btn.disabled = true;
                btn.classList.add("opacity-50", "cursor-not-allowed");
                emptyState.classList.add("hidden");
                loadingState.classList.remove("hidden");
                setGenerationProgress(4, "Preparing generation", "Validating goal and loading the catalog");
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
            if (!CONFIRMED_TASTE_INSIGHTS.length) {
                container.innerHTML = `<span class="text-[10px] text-slate-500 italic p-1">No confirmed preferences yet. Confirm a suggestion above to use it in Goal Mode.</span>`;
                return;
            }
            container.innerHTML = CONFIRMED_TASTE_INSIGHTS.map((note, idx) => `
                <span class="inline-flex items-center bg-purple-950/70 text-purple-200 border border-purple-800/60 px-2 py-0.5 rounded text-[10px] font-medium">
                    <span>${escapeHtml(note)}</span>
                    <button type="button" onclick="removeTasteInsight(${idx})" class="ml-1.5 text-purple-400 hover:text-red-400 focus:outline-none">
                        <i class="fa-solid fa-xmark text-[9px]"></i>
                    </button>
                </span>
            `).join("");
        }

        function renderPendingTasteInsights() {
            const container = document.getElementById("pendingTasteNotesContainer");
            if (!container) return;
            if (!PENDING_TASTE_INSIGHTS.length) {
                container.innerHTML = `<span class="text-[10px] text-slate-500 italic">No suggestions awaiting review.</span>`;
                return;
            }
            container.innerHTML = PENDING_TASTE_INSIGHTS.map((note, idx) => `
                <div class="flex items-center gap-2 rounded border border-amber-800/60 bg-amber-950/20 p-2">
                    <span class="min-w-0 flex-1 text-[10px] text-slate-200">${escapeHtml(note)}</span>
                    <button type="button" onclick="confirmTasteInsight(${idx})" class="shrink-0 rounded bg-emerald-800/70 px-2 py-1 text-[10px] font-medium text-emerald-100 hover:bg-emerald-700">Confirm</button>
                    <button type="button" aria-label="Dismiss preference suggestion" onclick="removePendingTasteInsight(${idx})" class="shrink-0 px-1 text-slate-400 hover:text-red-300">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            `).join("");
        }

        function confirmTasteInsight(index) {
            if (!Number.isInteger(index) || index < 0 || index >= PENDING_TASTE_INSIGHTS.length) return;
            const [insight] = PENDING_TASTE_INSIGHTS.splice(index, 1);
            if (!CONFIRMED_TASTE_INSIGHTS.includes(insight)) {
                CONFIRMED_TASTE_INSIGHTS.push(insight);
            }
            const saveStatus = document.getElementById("profileSaveStatus");
            if (saveStatus) saveStatus.textContent = "Unsaved preference changes";
            renderPendingTasteInsights();
            renderLearnedTasteNotes();
            showToast("Preference confirmed for Goal Mode. Save your listener profile to retain it for this session.", "success");
        }

        function removePendingTasteInsight(index) {
            if (!Number.isInteger(index) || index < 0 || index >= PENDING_TASTE_INSIGHTS.length) return;
            PENDING_TASTE_INSIGHTS.splice(index, 1);
            renderPendingTasteInsights();
            showToast("Preference suggestion dismissed.", "info");
        }

        function removeTasteInsight(index) {
            CONFIRMED_TASTE_INSIGHTS.splice(index, 1);
            renderLearnedTasteNotes();
            if (!updateSavedTastePreferences()) return;
            showToast("Preference removed from Goal Mode sync.", "info");
        }

        function updateSavedTastePreferences() {
            try {
                const saved = sessionStorage.getItem("goalModeListenerProfile");
                if (!saved) return true;
                const profile = JSON.parse(saved);
                delete profile.learnedPreferences;
                profile.confirmedLearnedPreferences = CONFIRMED_TASTE_INSIGHTS;
                sessionStorage.setItem("goalModeListenerProfile", JSON.stringify(profile));
                return true;
            } catch (err) {
                showToast(`Could not update saved chat preferences: ${err.message}`, "error");
                return false;
            }
        }

        function clearChatPreferences() {
            CONFIRMED_TASTE_INSIGHTS = [];
            PENDING_TASTE_INSIGHTS = [];
            renderLearnedTasteNotes();
            renderPendingTasteInsights();
            if (!updateSavedTastePreferences()) return;
            showToast("Reset confirmed and pending chat preferences.", "info");
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

        function normalizeChatResponse(response) {
            if (!response || typeof response.reply !== "string" || !response.reply.trim()) {
                throw new Error("The AI returned an invalid chat response.");
            }

            const text = response.reply.trim();
            const unwrapped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
            if (/^\s*\{\s*"/.test(unwrapped)) {
                let nested;
                try {
                    nested = JSON.parse(unwrapped);
                } catch {
                    const match = /"reply"\s*:\s*"([\s\S]*?)"\s*(?=,\s*"(?:extracted_taste_insights|suggested_recommender_action)"\s*:|}\s*$)/.exec(unwrapped);
                    if (!match) throw new Error("The AI returned malformed chat JSON.");
                    try {
                        const escapedReply = match[1].replace(/\\[\s\S]|["\r\n\t]/g, character =>
                            character.startsWith("\\") ? character : JSON.stringify(character).slice(1, -1)
                        );
                        const reply = JSON.parse(`"${escapedReply}"`);
                        const repaired = unwrapped.slice(0, match.index) + `"reply":${JSON.stringify(reply)}` +
                            unwrapped.slice(match.index + match[0].length);
                        nested = JSON.parse(repaired);
                        console.warn("Recovered a chat response with unescaped quotes or line breaks.");
                    } catch {
                        throw new Error("The AI returned malformed chat JSON.");
                    }
                }
                if (!nested || typeof nested.reply !== "string" || !nested.reply.trim()) {
                    throw new Error("The AI returned an invalid chat response.");
                }
                response = {
                    ...response,
                    ...nested
                };
                if (/^\s*(?:```(?:json)?\s*)?\{\s*"/i.test(response.reply)) {
                    throw new Error("The AI returned nested chat JSON.");
                }
            }
            return response;
        }

        async function requestChatResponse(systemInstruction, chatPrompt) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const instruction = attempt === 0
                    ? systemInstruction
                    : `${systemInstruction}\n\nYour previous response was invalid. Return a single valid JSON object; escape all quotation marks inside strings.`;
                const response = await requestAiJson(instruction, chatPrompt, "chat");
                try {
                    return normalizeChatResponse(response);
                } catch (error) {
                    if (attempt === 1) throw error;
                    console.warn("Retrying invalid chat response:", error);
                }
            }
        }

        function renderChatMarkdown(text) {
            if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
                showToast("Markdown formatting is unavailable; showing plain text.", "warning");
                return `<p class="whitespace-pre-wrap">${escapeHtml(text)}</p>`;
            }
            return DOMPurify.sanitize(marked.parse(text), {
                FORBID_TAGS: ["img", "style", "iframe"]
            });
        }

        function answerTopArtistQuestion(text) {
            if (!/^(?:who|what)(?:'s| is) (?:my|the sample(?: profile)?(?:'s)?) (?:top|favorite|favourite) artist(?: currently| right now)?[?.!]*$/i.test(text.trim())) {
                return null;
            }
            const artist = DEMO_PROFILE?.profile?.top_artist?.trim();
            if (!artist) {
                return { reply: "I don't have an account-based top artist. You can load a sample profile to see its top artist, or tell me about your favorite artists." };
            }
            const safeArtist = artist.replace(/[\\`*_{}\[\]()#+.!|>-]/g, "\\$&");
            return { reply: `The loaded **sample profile** lists **${safeArtist}** as its top artist. It's synthetic, so it doesn't tell me your real favorite artist.` };
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
                    <div class="${isUser ? '' : 'chat-markdown'}">${isUser ? `<p class="whitespace-pre-wrap">${escapeHtml(text)}</p>` : renderChatMarkdown(text)}</div>
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
            const demoTasteContext = getDemoTasteContext();
            const demoCatalogContext = getDemoCatalogContext();

            const systemInstruction = `You are the Goal Mode AI Taste Concierge.
Your purpose is to have an intelligent, musical dialogue with the listener about their audio taste, previous queue recommendations, and listening goals.

CURRENT RECOMMENDER & SESSION CONTEXT:
- Active Goal: "${currentGoal}"
- Duration Range: ${currentBudget} minutes
- Active Exclusions: "${currentExclusions}"
- Playlist Loaded: ${playlistCount > 0 ? `Yes (${playlistCount} songs)` : 'No (direct prompt mode)'}
- Listener-Approved Taste Summary: "${listenerTasteSummary}"
- Listener-Provided Preferences: "${listenerPreferences}"
- Loaded demo-profile taste signals (synthetic sample, not the listener's account): ${demoTasteContext}
- Profile-matched catalog examples (use only when relevant): ${demoCatalogContext}
- Current Active Queue Recommendations: ${JSON.stringify(currentQueueSnapshot.map(t => ({ title: t.title, artist: t.artist, duration: t.duration, reason: t.reason })))}
- Treat the active queue above as authoritative context. An empty database search does not mean the queue is empty; use the actual queue items to answer questions about these recommendations.
- Listener-Confirmed Chat Preferences: ${JSON.stringify(CONFIRMED_TASTE_INSIGHTS)}

MANDATORY RULES:
1. Be musically knowledgeable, conversational, concise, and helpful. Use Markdown in the reply when it improves readability.
2. Base claims about the listener only on the supplied profile, confirmed preferences, and conversation. The sample profile's top artist is a synthetic profile field, not evidence about the listener's real favorite artist or their listening history. If no sample is loaded and no artist is explicitly stated, say you do not know. Never infer a top artist from catalog search results or queue tracks. Do not invent songs, queue contents, emotional reactions, or audio characteristics. Correct earlier unsupported claims when asked.
3. If the user asks about specific tracks in their queue, reference only the actual titles, artists, durations, and curation reasons in the active queue. If the queue is empty, say so. Catalog matches and profile reference tracks are not queue items or listening history.
4. SUGGEST TASTE INSIGHTS: Only suggest preferences that the listener explicitly shares, such as a like, dislike, favorite artist, subgenre preference, or track critique. Do not turn sample data, model guesses, or questions into preferences. The listener must confirm each suggestion before it affects recommendations or is saved.
5. SUGGEST REFINED GOALS: If the listener asks for adjustments or if their feedback warrants a modified Goal Mode prompt, provide a "suggested_recommender_action" with a concrete "goal", "budget" (number), and "exclusions" string. Otherwise set it to null.
6. Answer the latest message directly. Correct information may be repeated when answering a follow-up.

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

SAMPLE PROFILE (synthetic, not the listener's account):
${demoTasteContext}

NEW LISTENER MESSAGE:
"${userText}"
`;

            try {
                const response = answerTopArtistQuestion(userText) || await requestChatResponse(systemInstruction, chatPrompt);
                
                CHAT_HISTORY.push({ role: "user", text: userText });
                CHAT_HISTORY.push({ role: "assistant", text: response.reply });

                let addedSuggestions = 0;
                if (Array.isArray(response.extracted_taste_insights) && response.extracted_taste_insights.length > 0) {
                    response.extracted_taste_insights.forEach(insight => {
                        const clean = typeof insight === "string" ? insight.trim() : "";
                        if (clean && !CONFIRMED_TASTE_INSIGHTS.includes(clean) && !PENDING_TASTE_INSIGHTS.includes(clean)) {
                            PENDING_TASTE_INSIGHTS.push(clean);
                            addedSuggestions += 1;
                        }
                    });
                    if (addedSuggestions) {
                        renderPendingTasteInsights();
                        showToast(`${addedSuggestions} preference suggestion(s) added for your review. Confirm any you want to use.`, "info");
                    }
                }

                appendMessageToFeed("assistant", response.reply, response.suggested_recommender_action);

            } catch (err) {
                console.error("Chat error:", err);
                appendMessageToFeed("assistant", "I couldn't prepare a reply. Please try again; if the issue persists, check the AI service.");
                showToast("Could not prepare a chat reply. Check the console for details.", "error");
            } finally {
                if (typingEl) typingEl.classList.add("hidden");
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
            if (!CONFIRMED_TASTE_INSIGHTS.length) {
                showToast(PENDING_TASTE_INSIGHTS.length
                    ? "Confirm a preference suggestion before using it in Goal Mode."
                    : "Chat with the AI first to discover custom taste preferences.", "info");
                return;
            }
            switchTab("prototype");
            showToast(`Using ${CONFIRMED_TASTE_INSIGHTS.length} confirmed chat preference(s) with Goal Mode...`, "info");
            setTimeout(() => {
                generateGoalQueue();
            }, 300);
        }