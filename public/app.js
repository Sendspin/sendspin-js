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
const copyUrlBtn = document.getElementById("copy-url-btn");
const controlsSection = document.getElementById("controls-section");
const volumeSlider = document.getElementById("volume-slider");
const volumeValue = document.getElementById("volume-value");
const muteBtn = document.getElementById("mute-btn");
const muteIcon = document.getElementById("mute-icon");
const syncDelayInput = document.getElementById("sync-delay");
const applySyncDelayBtn = document.getElementById("apply-sync-delay");
const audioElement = document.getElementById("audio-element");

// Status elements
const connectionStatus = document.getElementById("connection-status");
const playbackStatus = document.getElementById("playback-status");
const syncStatus = document.getElementById("sync-status");
const formatStatus = document.getElementById("format-status");
const clockDrift = document.getElementById("clock-drift");
const syncError = document.getElementById("sync-error");
const outputLatency = document.getElementById("output-latency");
const resyncCount = document.getElementById("resync-count");

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
 * Normalize server URL to ensure it has a protocol prefix
 */
function normalizeServerUrl(input) {
  if (!input) return "";

  const url = input.trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "http://" + url;
  }

  return url;
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
function updateConnectionUI(connected) {
  if (connected) {
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("connected");
    connectionStatus.textContent = "Connected";
    connectionStatus.className = "status-value connected";
    controlsSection.classList.add("enabled");
  } else {
    connectBtn.textContent = "Connect";
    connectBtn.classList.remove("connected");
    connectionStatus.textContent = "Disconnected";
    connectionStatus.className = "status-value disconnected";
    controlsSection.classList.remove("enabled");
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

    updateConnectionUI(true);
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
    // Use 'user_request' reason when user explicitly clicks disconnect
    player.disconnect("user_request");
    player = null;
  }

  updateConnectionUI(false);
  showToast("Disconnected from server");
}

/**
 * Toggle connection state
 */
function toggleConnection() {
  if (player?.isConnected) {
    disconnect();
  } else {
    connect();
  }
}

/**
 * Copy shareable URL to clipboard
 */
async function copyShareUrl() {
  const rawUrl = serverUrlInput.value.trim();
  if (!rawUrl) {
    showToast("Please enter a server URL first", "error");
    return;
  }

  // Normalize and use the server URL
  const serverUrl = normalizeServerUrl(rawUrl);

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
  connectBtn.addEventListener("click", toggleConnection);
  copyUrlBtn.addEventListener("click", copyShareUrl);
  volumeSlider.addEventListener("input", updateVolume);
  muteBtn.addEventListener("click", toggleMute);
  applySyncDelayBtn.addEventListener("click", applySyncDelay);

  // Handle Enter key in server URL input
  serverUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      toggleConnection();
    }
  });

  // Handle Enter key in sync delay input
  syncDelayInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applySyncDelay();
    }
  });

  // Cleanup on page unload - use 'shutdown' reason (browser/tab closing)
  window.addEventListener("beforeunload", () => {
    if (player) {
      player.disconnect("shutdown");
    }
  });

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
