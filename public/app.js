/**
 * Sendspin Sample Player
 *
 * A vanilla JavaScript example demonstrating how to use the sendspin-js SDK
 * to build a synchronized audio player.
 */

// Detect if running on localhost for development
const isLocalhost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

// Import the SDK from local build (development) or unpkg CDN (production)
const sdkPath = isLocalhost
  ? "./dev/index.js"
  : "https://unpkg.com/@music-assistant/sendspin-js@latest/dist/index.js";
const { SendspinPlayer } = await import(sdkPath);

console.log(`Loading SDK from: ${sdkPath}`);

// LocalStorage keys
const STORAGE_KEYS = {
  SERVER_URL: "sendspin-server-url",
  PLAYER_ID: "sendspin-player-id",
  VOLUME: "sendspin-volume",
  MUTED: "sendspin-muted",
  SYNC_DELAY: "sendspin-sync-delay",
};

// DOM Elements
const serverUrlInput = document.getElementById("server-url");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const copyUrlBtn = document.getElementById("copy-url-btn");
const connectedServerUrl = document.getElementById("connected-server-url");
const volumeSlider = document.getElementById("volume-slider");
const volumeValue = document.getElementById("volume-value");
const muteBtn = document.getElementById("mute-btn");
const muteIcon = document.getElementById("mute-icon");
const syncDelayInput = document.getElementById("sync-delay");
const applySyncDelayBtn = document.getElementById("apply-sync-delay");
const audioElement = document.getElementById("audio-element");

// Transport control buttons
const prevBtn = document.getElementById("prev-btn");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const stopBtn = document.getElementById("stop-btn");
const nextBtn = document.getElementById("next-btn");
const shuffleBtn = document.getElementById("shuffle-btn");
const unshuffleBtn = document.getElementById("unshuffle-btn");
const repeatOffBtn = document.getElementById("repeat-off-btn");
const repeatOneBtn = document.getElementById("repeat-one-btn");
const repeatAllBtn = document.getElementById("repeat-all-btn");
const switchGroupBtn = document.getElementById("switch-group-btn");

// Status elements
const connectionStatus = document.getElementById("connection-status");
const playbackStatus = document.getElementById("playback-status");
const syncStatus = document.getElementById("sync-status");
const formatStatus = document.getElementById("format-status");
const clockDrift = document.getElementById("clock-drift");
const syncError = document.getElementById("sync-error");
const outputLatency = document.getElementById("output-latency");
const resyncCount = document.getElementById("resync-count");

// Now Playing elements
const trackTitle = document.getElementById("track-title");
const trackArtist = document.getElementById("track-artist");
const trackAlbum = document.getElementById("track-album");
const groupName = document.getElementById("group-name");
const artwork = document.getElementById("artwork");
const artworkPlaceholder = document.getElementById("artwork-placeholder");

// Player instance
let player = null;
let statusUpdateInterval = null;

/**
 * Generate a unique player ID
 */
function generatePlayerId() {
  const stored = localStorage.getItem(STORAGE_KEYS.PLAYER_ID);
  if (stored) return stored;

  const id = "web-player-" + Math.random().toString(36).substring(2, 10);
  localStorage.setItem(STORAGE_KEYS.PLAYER_ID, id);
  return id;
}

/**
 * Detect if running on Android
 */
function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

/**
 * Detect if running on iOS
 */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * Get server URL from query params
 */
function getServerFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("server") || "";
}

/**
 * Check if the page is served over HTTPS
 */
function isSecureContext() {
  return window.location.protocol === "https:";
}

/**
 * Normalize server URL to ensure it has a protocol prefix.
 * When running on HTTPS, defaults to HTTPS to avoid mixed content issues.
 */
function normalizeServerUrl(input) {
  if (!input) return "";

  const url = input.trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    // Default to HTTPS when page is served over HTTPS to avoid mixed content
    const protocol = isSecureContext() ? "https://" : "http://";
    return protocol + url;
  }

  return url;
}

/**
 * Check if URL would cause mixed content issues (HTTP URL on HTTPS page)
 */
function isMixedContentUrl(url) {
  return isSecureContext() && url.startsWith("http://");
}

/**
 * Show a toast notification
 */
function showToast(message, type = "info") {
  // Remove existing toast
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  // Remove after delay
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Update UI based on connection state
 */
function updateConnectionUI(connected, serverUrl = "") {
  if (connected) {
    document.body.classList.add("connected");
    connectedServerUrl.textContent = serverUrl;
    connectionStatus.textContent = "Connected";
    connectionStatus.className = "status-value connected";
  } else {
    document.body.classList.remove("connected");
    connectedServerUrl.textContent = "";
    connectionStatus.textContent = "Disconnected";
    connectionStatus.className = "status-value disconnected";
    resetStatusDisplay();
  }
  connectBtn.disabled = false;
}

/**
 * Reset status display to default values
 */
function resetStatusDisplay() {
  playbackStatus.textContent = "Stopped";
  playbackStatus.className = "status-value";
  syncStatus.textContent = "-";
  syncStatus.className = "status-value";
  formatStatus.textContent = "-";
  clockDrift.textContent = "-";
  syncError.textContent = "-";
  outputLatency.textContent = "-";
  resyncCount.textContent = "-";
}

/**
 * Update status display with current player info
 */
function updateStatusDisplay() {
  if (!player) return;

  // Playback status
  if (player.isPlaying) {
    playbackStatus.textContent = "Playing";
    playbackStatus.className = "status-value playing";
  } else {
    playbackStatus.textContent = "Stopped";
    playbackStatus.className = "status-value";
  }

  // Sync state
  const state = player.playerState;
  if (state === "synchronized") {
    syncStatus.textContent = "Synchronized";
    syncStatus.className = "status-value synchronized";
  } else if (state === "error") {
    syncStatus.textContent = "Error";
    syncStatus.className = "status-value disconnected";
  } else {
    syncStatus.textContent = state || "-";
    syncStatus.className = "status-value";
  }

  // Format info
  const format = player.currentFormat;
  if (format) {
    formatStatus.textContent = `${format.codec.toUpperCase()} ${format.sampleRate / 1000}kHz ${format.channels}ch`;
  }

  // Sync info
  const sync = player.syncInfo;
  if (sync) {
    if (sync.clockDriftPercent !== undefined) {
      const drift = sync.clockDriftPercent;
      clockDrift.textContent = `${drift > 0 ? "+" : ""}${drift.toFixed(3)}%`;
      clockDrift.className =
        Math.abs(drift) > 0.1 ? "status-value warning" : "status-value";
    }

    if (sync.syncErrorMs !== undefined) {
      const error = sync.syncErrorMs;
      syncError.textContent = `${error.toFixed(1)}ms`;
      syncError.className =
        Math.abs(error) > 50 ? "status-value warning" : "status-value";
    }

    if (sync.outputLatencyMs !== undefined) {
      outputLatency.textContent = `${sync.outputLatencyMs.toFixed(0)}ms`;
    }

    if (sync.resyncCount !== undefined) {
      resyncCount.textContent = sync.resyncCount.toString();
      resyncCount.className =
        sync.resyncCount > 5 ? "status-value warning" : "status-value";
    }
  }
}

/**
 * Handle state changes from the player
 */
function onStateChange(state) {
  console.log("Player state changed:", state);
  updateStatusDisplay();

  // Update now playing from cached server state
  if (state.serverState?.metadata) {
    updateNowPlaying(state.serverState.metadata);
  }

  // Update group info from cached group state
  if (state.groupState) {
    updateGroupInfo(state.groupState);
  }
}

/**
 * Update now playing display with metadata
 */
function updateNowPlaying(metadata) {
  trackTitle.textContent = metadata.title || "-";
  trackArtist.textContent = metadata.artist || "-";
  trackAlbum.textContent = metadata.album || "-";

  // Handle artwork
  if (metadata.artwork_url) {
    artwork.src = metadata.artwork_url;
    artwork.style.display = "block";
    artworkPlaceholder.style.display = "none";
  } else {
    artwork.style.display = "none";
    artworkPlaceholder.style.display = "flex";
  }
}

/**
 * Update group info display
 */
function updateGroupInfo(group) {
  groupName.textContent = group.group_name || "";
}

/**
 * Load saved settings from localStorage
 */
function loadSettings() {
  // Load volume
  const savedVolume = localStorage.getItem(STORAGE_KEYS.VOLUME);
  if (savedVolume !== null) {
    const volume = parseInt(savedVolume, 10);
    volumeSlider.value = volume;
    volumeValue.textContent = `${volume}%`;
  }

  // Load muted state
  const savedMuted = localStorage.getItem(STORAGE_KEYS.MUTED);
  if (savedMuted !== null) {
    updateMuteIcon(savedMuted === "true");
  }

  // Load sync delay
  const savedSyncDelay = localStorage.getItem(STORAGE_KEYS.SYNC_DELAY);
  if (savedSyncDelay !== null) {
    syncDelayInput.value = savedSyncDelay;
  }
}

/**
 * Save volume to localStorage
 */
function saveVolume(volume) {
  localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
}

/**
 * Save muted state to localStorage
 */
function saveMuted(muted) {
  localStorage.setItem(STORAGE_KEYS.MUTED, muted.toString());
}

/**
 * Save sync delay to localStorage
 */
function saveSyncDelay(delay) {
  localStorage.setItem(STORAGE_KEYS.SYNC_DELAY, delay.toString());
}

/**
 * Connect to the Sendspin server
 */
async function connect() {
  const rawUrl = serverUrlInput.value.trim();

  if (!rawUrl) {
    showToast("Please enter a server URL", "error");
    serverUrlInput.focus();
    return;
  }

  // Normalize the URL
  const serverUrl = normalizeServerUrl(rawUrl);

  // Update the input with normalized URL
  serverUrlInput.value = serverUrl;
  localStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);

  // Validate URL format
  try {
    new URL(serverUrl);
  } catch {
    showToast("Invalid URL format", "error");
    serverUrlInput.focus();
    return;
  }

  // Check for mixed content (HTTP URL on HTTPS page)
  if (isMixedContentUrl(serverUrl)) {
    showToast(
      "Cannot connect to HTTP server from HTTPS page. Browsers block mixed content for security. Use an HTTPS server URL instead.",
      "error",
    );
    serverUrlInput.focus();
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting...";

  try {
    // Determine audio output mode based on platform
    // Use media-element for mobile (better background playback support)
    const isMobile = isAndroid() || isIOS();

    // Get saved settings
    const savedVolume = parseInt(
      localStorage.getItem(STORAGE_KEYS.VOLUME) || "80",
      10,
    );
    const savedSyncDelay = parseInt(
      localStorage.getItem(STORAGE_KEYS.SYNC_DELAY) || "0",
      10,
    );

    player = new SendspinPlayer({
      playerId: generatePlayerId(),
      baseUrl: serverUrl,
      clientName: "Sendspin Sample Player",
      audioOutputMode: isMobile ? "media-element" : "direct",
      audioElement: isMobile ? audioElement : undefined,
      isAndroid: isAndroid(),
      useOutputLatencyCompensation: true,
      useHardwareVolume: false,
      syncDelay: savedSyncDelay,
      onStateChange,
    });

    await player.connect();

    // Apply saved volume
    player.setVolume(savedVolume);

    // Apply saved muted state
    const savedMuted = localStorage.getItem(STORAGE_KEYS.MUTED) === "true";
    player.setMuted(savedMuted);

    updateConnectionUI(true, serverUrl);
    showToast("Connected to server", "success");

    // Start status update interval
    statusUpdateInterval = setInterval(updateStatusDisplay, 500);

    // Sync volume UI with player
    volumeSlider.value = player.volume;
    volumeValue.textContent = `${player.volume}%`;
    updateMuteIcon(player.muted);
  } catch (error) {
    console.error("Connection failed:", error);
    showToast(`Connection failed: ${error.message}`, "error");
    updateConnectionUI(false);
    player = null;
  }
}

/**
 * Disconnect from the Sendspin server
 */
function disconnect() {
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
    statusUpdateInterval = null;
  }

  if (player) {
    player.disconnect("user_request");
    player = null;
  }

  updateConnectionUI(false);
  showToast("Disconnected from server");
}

/**
 * Copy shareable URL to clipboard
 */
async function copyShareUrl() {
  // Get server URL from localStorage (more reliable when input is hidden)
  const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
  if (!serverUrl) {
    showToast("No server URL to share", "error");
    return;
  }

  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("server", serverUrl);

  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("Share URL copied to clipboard", "success");
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.value = url.toString();
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    showToast("Share URL copied to clipboard", "success");
  }
}

/**
 * Update volume
 */
function updateVolume() {
  const volume = parseInt(volumeSlider.value, 10);
  volumeValue.textContent = `${volume}%`;
  saveVolume(volume);

  if (player) {
    player.setVolume(volume);
  }
}

/**
 * Update mute icon based on state
 */
function updateMuteIcon(muted) {
  muteIcon.textContent = muted ? "🔇" : "🔊";
}

/**
 * Toggle mute state
 */
function toggleMute() {
  if (player) {
    const newMuted = !player.muted;
    player.setMuted(newMuted);
    updateMuteIcon(newMuted);
    saveMuted(newMuted);
  } else {
    // Toggle UI even when not connected
    const currentMuted = muteIcon.textContent === "🔇";
    updateMuteIcon(!currentMuted);
    saveMuted(!currentMuted);
  }
}

/**
 * Apply sync delay
 */
function applySyncDelay() {
  const delay = parseInt(syncDelayInput.value, 10) || 0;
  saveSyncDelay(delay);

  if (player) {
    player.setSyncDelay(delay);
    showToast(`Sync delay set to ${delay}ms`, "success");
  } else {
    showToast(`Sync delay saved: ${delay}ms`, "success");
  }
}

/**
 * Initialize the application
 */
function init() {
  // Load saved settings first
  loadSettings();

  // Load server URL from query params or localStorage
  const serverFromUrl = getServerFromUrl();
  const serverFromStorage = localStorage.getItem(STORAGE_KEYS.SERVER_URL);

  if (serverFromUrl) {
    // Normalize the URL from query params
    serverUrlInput.value = normalizeServerUrl(serverFromUrl);
  } else if (serverFromStorage) {
    serverUrlInput.value = serverFromStorage;
  }

  // Save server URL to localStorage when changed
  serverUrlInput.addEventListener("input", () => {
    localStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrlInput.value);
  });

  // Event listeners
  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  copyUrlBtn.addEventListener("click", copyShareUrl);
  volumeSlider.addEventListener("input", updateVolume);
  muteBtn.addEventListener("click", toggleMute);
  applySyncDelayBtn.addEventListener("click", applySyncDelay);

  // Transport control event listeners
  prevBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("previous");
      showToast("Previous");
    }
  });
  playBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("play");
      showToast("Play");
    }
  });
  pauseBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("pause");
      showToast("Pause");
    }
  });
  stopBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("stop");
      showToast("Stop");
    }
  });
  nextBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("next");
      showToast("Next");
    }
  });
  shuffleBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("shuffle");
      showToast("Shuffle");
    }
  });
  unshuffleBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("unshuffle");
      showToast("Unshuffle");
    }
  });
  repeatOffBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("repeat_off");
      showToast("Repeat Off");
    }
  });
  repeatOneBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("repeat_one");
      showToast("Repeat One");
    }
  });
  repeatAllBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("repeat_all");
      showToast("Repeat All");
    }
  });
  switchGroupBtn.addEventListener("click", () => {
    if (player) {
      player.sendCommand("switch");
      showToast("Switch Group");
    }
  });

  // Handle Enter key in server URL input
  serverUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      connect();
    }
  });

  // Handle Enter key in sync delay input
  syncDelayInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applySyncDelay();
    }
  });

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    if (player) {
      player.disconnect("shutdown");
    }
  });

  // Show HTTPS hint when page is served over HTTPS
  if (isSecureContext()) {
    const hint = document.getElementById("server-url-hint");
    if (hint) {
      hint.textContent = "HTTPS server URL required (browser blocks HTTP from HTTPS pages)";
    }
  }

  console.log("Sendspin Sample Player initialized");
  console.log("Player ID:", generatePlayerId());
  if (isLocalhost) {
    console.log("Development mode: using local SDK build");
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
