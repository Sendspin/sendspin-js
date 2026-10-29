/**
 * Sendspin Sample Player
 *
 * A vanilla JavaScript example demonstrating how to use the sendspin-js SDK
 * to build a synchronized audio player.
 */

// Detect if running on dev server (must match port in package.json "dev-server" script)
const isLocalDev = window.location.port === "6001";

// Import the SDK from local build (development) or unpkg CDN (production)
const sdkPath = isLocalDev
  ? "./dev/index.js"
  : "https://unpkg.com/@sendspin/sendspin-js@latest/dist/index.js";
const { SendspinPlayer } = await import(sdkPath);

console.log(`Loading SDK from: ${sdkPath}`);

// LocalStorage keys
const STORAGE_KEYS = {
  SERVER_URL: "sendspin-server-url",
  // Shared with the SDK, which persists volume, mute and the output delay
  // under these keys.
  VOLUME: "sendspin-volume",
  MUTED: "sendspin-muted",
  SYNC_DELAY: "sendspin-static-delay-ms-v2",
  REQUIRED_LEAD_TIME: "sendspin-required-lead-time",
  MIN_BUFFER: "sendspin-min-buffer",
  CORRECTION_MODE: "sendspin-correction-mode",
  RESYNC_THRESHOLD: "sendspin-resync-threshold",
  DEADBAND_THRESHOLD: "sendspin-deadband-threshold",
  STATIC_PIN: "sendspin-sample-static-pin",
  STATIC_PIN_LOCATIONS: "sendspin-sample-static-pin-locations",
  PAIRING_PSK_LOCATIONS: "sendspin-sample-pairing-psk-locations",
  PIN_SPEAKER: "sendspin-sample-pin-speaker",
  PIN_QR: "sendspin-sample-pin-qr",
};

// DOM Elements
const serverUrlInput = document.getElementById("server-url");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const copyUrlBtn = document.getElementById("copy-url-btn");
const leaveGroupBtn = document.getElementById("leave-group-btn");
const connectedServerUrl = document.getElementById("connected-server-url");
const volumeSlider = document.getElementById("volume-slider");
const volumeValue = document.getElementById("volume-value");
const muteBtn = document.getElementById("mute-btn");
const muteIcon = document.getElementById("mute-icon");
const syncDelayInput = document.getElementById("sync-delay");
const applySyncDelayBtn = document.getElementById("apply-sync-delay");
const requiredLeadTimeInput = document.getElementById("required-lead-time");
const applyRequiredLeadTimeBtn = document.getElementById(
  "apply-required-lead-time",
);
const minBufferInput = document.getElementById("min-buffer");
const applyMinBufferBtn = document.getElementById("apply-min-buffer");
const correctionModeSelect = document.getElementById("correction-mode");
const resyncThresholdInput = document.getElementById("resync-threshold");
const deadbandThresholdInput = document.getElementById("deadband-threshold");
const groupVolumeSlider = document.getElementById("group-volume-slider");
const groupVolumeValue = document.getElementById("group-volume-value");
const groupMuteBtn = document.getElementById("group-mute-btn");
const seekBackBtn = document.getElementById("seek-back-btn");
const seekForwardBtn = document.getElementById("seek-forward-btn");
const groupMuteIcon = document.getElementById("group-mute-icon");
const clientIdEl = document.getElementById("client-id");
const pairingTokenEl = document.getElementById("pairing-token");
const rotatePskBtn = document.getElementById("rotate-psk");
const trustLevelEl = document.getElementById("trust-level");
const unpairedAccessCheckbox = document.getElementById("unpaired-access");
const pairingPinGroup = document.getElementById("pairing-pin-group");
const pairingPinEl = document.getElementById("pairing-pin");
const pairingPinHint = document.getElementById("pairing-pin-hint");
const pairingQrEl = document.getElementById("pairing-qr");
const pairingPendingGroup = document.getElementById("pairing-pending-group");
const cancelPairingBtn = document.getElementById("cancel-pairing");
const staticPinInput = document.getElementById("static-pin");
const staticPinBothEl = document.getElementById("static-pin-both");
const staticPinLocationInputs = document.querySelectorAll(
  "#static-pin-locations input[type=checkbox]",
);
const pairingPskLocationInputs = document.querySelectorAll(
  "#pairing-psk-locations input[type=checkbox]",
);
const pinSpeakerInput = document.getElementById("pin-speaker");
const pinQrInput = document.getElementById("pin-qr");
const openPairingWindowBtn = document.getElementById("open-pairing-window");
const roundLimitEl = document.getElementById("round-limit");
const releasePairingHoldBtn = document.getElementById("release-pairing-hold");

// Status elements
const connectionStatus = document.getElementById("connection-status");
const playbackStatus = document.getElementById("playback-status");
const syncStatus = document.getElementById("sync-status");
const formatStatus = document.getElementById("format-status");
const clockDrift = document.getElementById("clock-drift");
const syncError = document.getElementById("sync-error");
const outputLatency = document.getElementById("output-latency");
const resyncCount = document.getElementById("resync-count");
const correctionModeStatus = document.getElementById("correction-mode-status");
const correctionMethod = document.getElementById("correction-method");
const playbackRate = document.getElementById("playback-rate");
const samplesAdjusted = document.getElementById("samples-adjusted");
const timeSyncSynced = document.getElementById("time-sync-synced");
const timeSyncOffset = document.getElementById("time-sync-offset");
const timeSyncError = document.getElementById("time-sync-error");

// Now Playing elements
const trackTitle = document.getElementById("track-title");
const trackArtist = document.getElementById("track-artist");
const trackAlbum = document.getElementById("track-album");
const groupName = document.getElementById("group-name");
const artwork = document.getElementById("artwork");
const artworkPlaceholder = document.getElementById("artwork-placeholder");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const progressCurrent = document.getElementById("progress-current");
const progressDuration = document.getElementById("progress-duration");

// Player instance
let player = null;
let idlePlayer = null;
let idlePlayerConfigKey = null;
let controllerState = null;
let statusUpdateInterval = null;

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
 * Turn the typed server address into a WebSocket URL.
 * Bare addresses get ws:// and, without a port, the default 8927, since the
 * spec requires plain ws:// for addresses advertised over mDNS. Without a
 * path, the URL gets the default /sendspin.
 */
function normalizeServerUrl(input) {
  if (!input) return "";

  let url = input.trim();
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const bare = rest === url;
  const hasPort = /:\d+$/.test(rest.split("/")[0]);
  const hasPath = rest.includes("/");
  if (bare) url = "ws://" + url;
  url = url.replace(/^http(s?):/i, "ws$1:");

  try {
    const parsed = new URL(url);
    if (bare && !hasPort) parsed.port = "8927";
    if (!hasPath) parsed.pathname = "/sendspin";
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Check if URL would cause mixed content issues (ws:// URL on HTTPS page)
 * Note: localhost is considered a secure context, so ws:// to localhost is allowed
 */
function isMixedContentUrl(url) {
  if (!isSecureContext() || !url.startsWith("ws://")) {
    return false;
  }
  // localhost is a secure context, so ws:// is allowed
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return false;
    }
  } catch {
    // Invalid URL, let it fail later
  }
  return true;
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
  connectBtn.textContent = "Connect";
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
  correctionModeStatus.textContent = "-";
  correctionMethod.textContent = "-";
  playbackRate.textContent = "-";
  samplesAdjusted.textContent = "-";
  timeSyncSynced.textContent = "-";
  timeSyncOffset.textContent = "-";
  timeSyncError.textContent = "-";
  groupVolumeValue.textContent = "-";
  groupMuteIcon.textContent = "🔊";
  progressFill.style.width = "0%";
  progressCurrent.textContent = "--:--";
  progressDuration.textContent = "--:--";
  clientIdEl.textContent = "-";
  pairingTokenEl.textContent = "-";
  trustLevelEl.textContent = "-";
  pairingPinGroup.hidden = true;
  pairingPendingGroup.hidden = true;
  pairingPinEl.textContent = "-";
  roundLimitEl.textContent = "-";
}

/**
 * Populate the pairing panel from the current player instance
 */
function updatePairingDisplay() {
  clientIdEl.textContent = player.clientId;
  pairingTokenEl.textContent = player.pairingToken;
  updateRoundLimitDisplay();
}

function isValidStaticPin(pin) {
  return /^[0-9]{8}$/.test(pin);
}

/** The checked location hints in a group, in spec order. */
function selectedLocations(inputs) {
  const picked = Array.from(inputs)
    .filter((input) => input.checked)
    .map((input) => input.value);
  // undefined omits the hint; an empty list would advertise nothing useful.
  return picked.length ? picked : undefined;
}

/**
 * Show whether dynamic pairing is held back at the round limit.
 */
function updateRoundLimitDisplay() {
  if (!player) return;
  roundLimitEl.textContent = player.isRoundLimitReached() ? "yes" : "no";
}

/**
 * Handle Pairing PSK lifecycle events from the SDK
 */
function onPairing(event, detail) {
  console.log("Pairing event:", event, detail ?? "");
  pairingPendingGroup.hidden = event !== "pending";
  if (event === "pending") {
    trustLevelEl.textContent = "awaiting operator...";
    showToast("Pairing needs an operator action", "info");
  } else if (event === "started") {
    trustLevelEl.textContent = "pairing...";
  } else if (event === "finalized") {
    trustLevelEl.textContent = "user (just paired)";
    showToast("Pairing complete", "success");
  } else if (event === "aborted") {
    trustLevelEl.textContent = `aborted (${detail ?? "unknown"})`;
    showToast(`Pairing aborted: ${detail ?? "unknown"}`, "error");
  }
  updateRoundLimitDisplay();
}

/**
 * Show or hide the dynamic pairing code (null = attempt ended). languages is
 * the server's spoken-code preference, absent when it sent none. In the
 * qr_code format the code is a pairing token to show as a QR code.
 */
function onPairingCode(pin, languages, format) {
  pairingPinGroup.hidden = pin === null;
  pairingQrEl.hidden = format !== "qr_code";
  if (format === "qr_code") {
    pairingPinEl.textContent = pin;
    pairingPinHint.textContent =
      "Scan this QR code with the server, or paste the token into it.";
    renderQrCode(pin).catch(() =>
      showToast("Could not load the QR code library", "error"),
    );
    return;
  }
  pairingPinEl.textContent = pin === null ? "-" : codeGroups(pin).join("-");
  pairingPinHint.textContent = languages?.length
    ? `Enter this code into the server. Spoken preference: ${languages.join(", ")}.`
    : "Enter this code into the server to complete pairing.";
  if (pin === null) {
    // Stop mid-utterance: the attempt this PIN belonged to is over.
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    return;
  }
  if (pinSpeakerInput.checked) speakPin(pin, languages);
}

/** Render the token as a QR code with a QR library loaded on first use. */
async function renderQrCode(token) {
  const { qrcode } =
    await import("https://unpkg.com/qrcode-generator@2.0.4/dist/qrcode.mjs");
  const qr = qrcode(0, "M");
  qr.addData(token, "Alphanumeric");
  qr.make();
  pairingQrEl.innerHTML = qr.createSvgTag(4);
}

/** Split the 6-digit code into the 3-3 groups the spec presents it in. */
function codeGroups(pin) {
  return [pin.slice(0, 3), pin.slice(3)];
}

/**
 * Read the PIN aloud, digit by digit with a longer pause between groups,
 * picking the best voice for the server's language preferences under
 * RFC 4647 Lookup matching.
 */
function speakPin(pin, languages) {
  if (typeof speechSynthesis === "undefined") return;
  const text = codeGroups(pin)
    .map((group) => group.split("").join(" "))
    .join(". ");
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = bestVoice(languages ?? []);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/**
 * Lookup matching: try each tag in order, truncating at "-" until a voice
 * matches. Returns undefined so the browser default applies.
 */
function bestVoice(languages) {
  const voices = speechSynthesis.getVoices();
  for (const tag of languages) {
    let candidate = tag.toLowerCase();
    while (candidate) {
      const match = voices.find(
        (v) =>
          v.lang.toLowerCase() === candidate ||
          v.lang.toLowerCase().startsWith(`${candidate}-`),
      );
      if (match) return match;
      const cut = candidate.lastIndexOf("-");
      if (cut < 0) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return undefined;
}

/**
 * Format milliseconds as mm:ss
 */
function formatTime(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Update progress bar display
 */
function updateProgressDisplay() {
  const progress = player.trackProgress;
  if (!progress) {
    progressFill.style.width = "0%";
    progressCurrent.textContent = "--:--";
    progressDuration.textContent = "--:--";
    return;
  }

  const percent =
    progress.durationMs > 0
      ? (progress.positionMs / progress.durationMs) * 100
      : 0;
  progressFill.style.width = `${percent}%`;
  progressCurrent.textContent = formatTime(progress.positionMs);
  progressDuration.textContent = formatTime(progress.durationMs);
}

/**
 * Update status display with current player info
 */
function updateStatusDisplay() {
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
    formatStatus.textContent = `${format.codec.toUpperCase()} ${format.sample_rate / 1000}kHz ${format.channels}ch`;
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

    if (sync.correctionMode) {
      correctionModeStatus.textContent = sync.correctionMode;
    } else if (player.correctionMode) {
      correctionModeStatus.textContent = player.correctionMode;
    }

    if (sync.correctionMethod) {
      correctionMethod.textContent = sync.correctionMethod;
    }

    if (sync.playbackRate !== undefined) {
      playbackRate.textContent = sync.playbackRate.toFixed(3);
    }

    if (sync.samplesAdjusted !== undefined) {
      samplesAdjusted.textContent = sync.samplesAdjusted.toString();
    }
  }

  const timeSync = player.timeSyncInfo;
  if (timeSync) {
    timeSyncSynced.textContent = timeSync.synced ? "Yes" : "No";
    timeSyncOffset.textContent = `${timeSync.offset.toFixed(0)}ms`;
    timeSyncError.textContent = `${timeSync.error.toFixed(0)}ms`;
  }

  // Update track progress
  updateProgressDisplay();
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

  // Update group volume from controller state
  controllerState = state.serverState?.controller ?? null;
  if (controllerState) {
    updateGroupVolume(controllerState);
  }
}

/**
 * Send a controller command, showing an error toast if the SDK rejects it
 */
function sendServerCommand(command, params) {
  try {
    player.sendCommand(command, params);
    return true;
  } catch (error) {
    showToast(error.message, "error");
    return false;
  }
}

/**
 * Seek to the clicked point of the progress bar, within the seekable range
 */
function seekFromProgressBar(event) {
  const seekMaxMs = controllerState?.seek_max_ms;
  if (seekMaxMs === undefined) {
    showToast("Seeking is not available for this track", "error");
    return;
  }
  const rect = progressBar.getBoundingClientRect();
  const fraction = Math.min(
    Math.max((event.clientX - rect.left) / rect.width, 0),
    1,
  );
  const durationMs = player.trackProgress?.durationMs || seekMaxMs;
  sendServerCommand("seek", {
    position_ms: Math.min(fraction * durationMs, seekMaxMs),
  });
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
 * Update group volume display from controller state
 */
function updateGroupVolume(controller) {
  if (controller.volume !== undefined) {
    groupVolumeSlider.value = controller.volume;
    groupVolumeValue.textContent = `${controller.volume}%`;
  }
  if (controller.muted !== undefined) {
    groupMuteIcon.textContent = controller.muted ? "🔇" : "🔊";
  }
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
    syncDelayInput.value = sanitizeSyncDelay(parseInt(savedSyncDelay, 10));
  }

  const savedLeadTime = localStorage.getItem(STORAGE_KEYS.REQUIRED_LEAD_TIME);
  if (savedLeadTime !== null) {
    requiredLeadTimeInput.value = sanitizeBufferMs(
      parseInt(savedLeadTime, 10),
      250,
    );
  }

  const savedMinBuffer = localStorage.getItem(STORAGE_KEYS.MIN_BUFFER);
  if (savedMinBuffer !== null) {
    minBufferInput.value = sanitizeBufferMs(parseInt(savedMinBuffer, 10), 250);
  }

  const savedStaticPin = localStorage.getItem(STORAGE_KEYS.STATIC_PIN);
  if (savedStaticPin !== null) {
    staticPinInput.value = savedStaticPin;
  }
  staticPinBothEl.hidden = !isValidStaticPin(staticPinInput.value);

  for (const [inputs, key] of [
    [staticPinLocationInputs, STORAGE_KEYS.STATIC_PIN_LOCATIONS],
    [pairingPskLocationInputs, STORAGE_KEYS.PAIRING_PSK_LOCATIONS],
  ]) {
    const saved = localStorage.getItem(key);
    if (saved === null) continue;
    // Stored by hand or left over from an older build: fall back to no hint
    // rather than letting one bad value break the whole panel.
    let picked = [];
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) picked = parsed;
    } catch {
      picked = [];
    }
    inputs.forEach((input) => {
      input.checked = picked.includes(input.value);
    });
  }

  pinSpeakerInput.checked =
    localStorage.getItem(STORAGE_KEYS.PIN_SPEAKER) === "true";
  pinQrInput.checked = localStorage.getItem(STORAGE_KEYS.PIN_QR) === "true";

  const savedCorrectionMode = localStorage.getItem(
    STORAGE_KEYS.CORRECTION_MODE,
  );
  if (savedCorrectionMode !== null) {
    correctionModeSelect.value = savedCorrectionMode;
  }

  const savedResyncThreshold = localStorage.getItem(
    STORAGE_KEYS.RESYNC_THRESHOLD,
  );
  if (savedResyncThreshold !== null && resyncThresholdInput) {
    resyncThresholdInput.value = savedResyncThreshold;
  }

  const savedDeadbandThreshold = localStorage.getItem(
    STORAGE_KEYS.DEADBAND_THRESHOLD,
  );
  if (savedDeadbandThreshold !== null && deadbandThresholdInput) {
    deadbandThresholdInput.value = savedDeadbandThreshold;
  }
}

/**
 * Save sync delay to localStorage
 */
function saveSyncDelay(delay) {
  localStorage.setItem(STORAGE_KEYS.SYNC_DELAY, delay.toString());
}

function sanitizeSyncDelay(delay) {
  if (!Number.isFinite(delay)) {
    return 0;
  }
  return Math.max(0, Math.min(5000, Math.round(delay)));
}

function sanitizeBufferMs(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(10000, Math.round(value)));
}

/**
 * Build a correctionThresholds override from the Advanced inputs.
 * Returns undefined when no override is set for the current mode.
 */
function buildCorrectionThresholds(mode) {
  const overrides = {};
  const resyncRaw = resyncThresholdInput?.value;
  const deadbandRaw = deadbandThresholdInput?.value;
  const resync = resyncRaw ? parseFloat(resyncRaw) : NaN;
  const deadband = deadbandRaw ? parseFloat(deadbandRaw) : NaN;
  if (Number.isFinite(resync) && resync >= 0) {
    overrides.resyncAboveMs = resync;
  }
  if (Number.isFinite(deadband) && deadband >= 0) {
    overrides.deadbandBelowMs = deadband;
  }
  if (Object.keys(overrides).length === 0) {
    return undefined;
  }
  return { [mode]: overrides };
}

/**
 * Save correction mode to localStorage
 */
function saveCorrectionMode(mode) {
  localStorage.setItem(STORAGE_KEYS.CORRECTION_MODE, mode);
}

/**
 * Connect to the Sendspin server
 */
async function connect() {
  // Guard re-entry: the Enter-key handler bypasses the disabled connect button.
  if (player) return;
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

  // Check for mixed content (ws:// URL on HTTPS page)
  if (isMixedContentUrl(serverUrl)) {
    showToast(
      "Cannot connect to a ws:// server from an HTTPS page. Browsers block mixed content for security. Use a wss:// server URL instead.",
      "error",
    );
    serverUrlInput.focus();
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting...";

  try {
    // Get saved settings
    const savedCorrectionMode =
      localStorage.getItem(STORAGE_KEYS.CORRECTION_MODE) || "sync";

    const correctionThresholds = buildCorrectionThresholds(savedCorrectionMode);

    const requiredLeadTimeMs = sanitizeBufferMs(
      parseInt(requiredLeadTimeInput.value, 10),
      250,
    );
    const minBufferMs = sanitizeBufferMs(
      parseInt(minBufferInput.value, 10),
      250,
    );

    const config = {
      url: serverUrl,
      clientName: "Sendspin Sample Player",
      productName: "Sendspin JS Sample Player",
      requiredLeadTimeMs,
      minBufferMs,
      correctionMode: savedCorrectionMode,
      correctionThresholds,
      reconnect: {
        onReconnecting: (attempt) =>
          showToast(`Reconnecting (attempt ${attempt})`, "info"),
        onReconnected: () => showToast("Reconnected", "success"),
        onExhausted: () => showToast("Reconnect failed", "error"),
      },
      onDelayCommand: (delayMs) => {
        syncDelayInput.value = delayMs;
        showToast(`Server set sync delay to ${delayMs}ms`, "info");
      },
      unpairedAccess: unpairedAccessCheckbox.checked,
      // Enables static pairing only once the field holds a complete code.
      staticPairingCode: isValidStaticPin(staticPinInput.value)
        ? staticPinInput.value
        : undefined,
      // Omitted entirely when nothing is picked: the hint is optional.
      staticPairingCodeLocations: selectedLocations(staticPinLocationInputs),
      pairingPskLocations: selectedLocations(pairingPskLocationInputs),
      pairingCodeOutChannels: pinSpeakerInput.checked
        ? ["display", "speaker"]
        : ["display"],
      pairingCodeFormats: pinQrInput.checked
        ? ["digits", "qr_code"]
        : ["digits"],
      onPairing,
      onPairingCode,
      onStateChange,
    };

    // Reuse the disconnected player when its settings are unchanged, so it
    // keeps its audio output.
    const configKey = JSON.stringify(config);
    if (idlePlayer && idlePlayerConfigKey === configKey) {
      player = idlePlayer;
      // Reapply settings the player may have changed at runtime since it was built.
      player.setRequiredLeadTimeMs(requiredLeadTimeMs);
      player.setMinBufferMs(minBufferMs);
      player.setCorrectionMode(savedCorrectionMode);
    } else {
      idlePlayer?.destroy();
      player = new SendspinPlayer(config);
    }
    idlePlayer = null;
    idlePlayerConfigKey = configKey;

    await player.unlock();
    await player.connect();
    updatePairingDisplay();

    updateConnectionUI(true, serverUrl);
    showToast("Connected to server", "success");

    // Start status update interval
    statusUpdateInterval = setInterval(updateStatusDisplay, 500);

    // Sync volume UI with player
    volumeSlider.value = player.volume;
    volumeValue.textContent = `${player.volume}%`;
    updateMuteIcon(player.muted);
    correctionModeSelect.value = savedCorrectionMode;
  } catch (error) {
    console.error("Connection failed:", error);
    showToast(`Connection failed: ${error.message}`, "error");
    updateConnectionUI(false);
    if (player) {
      player.disconnect("user_request");
      idlePlayer = player;
    }
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
    idlePlayer = player;
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
  player.setVolume(volume);
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
  const newMuted = !player.muted;
  player.setMuted(newMuted);
  updateMuteIcon(newMuted);
}

/**
 * Apply sync delay
 */
function applySyncDelay() {
  const delay = sanitizeSyncDelay(parseInt(syncDelayInput.value, 10));
  syncDelayInput.value = delay;
  const activePlayer = player ?? idlePlayer;
  if (activePlayer) {
    activePlayer.setSyncDelay(delay);
  } else {
    // No player yet, so seed the SDK's key for the next connect.
    saveSyncDelay(delay);
  }
  showToast(`Sync delay set to ${delay}ms`, "success");
}

/**
 * Apply required lead time
 */
function applyRequiredLeadTime() {
  const leadTime = sanitizeBufferMs(
    parseInt(requiredLeadTimeInput.value, 10),
    250,
  );
  requiredLeadTimeInput.value = leadTime;
  localStorage.setItem(STORAGE_KEYS.REQUIRED_LEAD_TIME, leadTime.toString());
  player?.setRequiredLeadTimeMs(leadTime);
  showToast(`Required lead time set to ${leadTime}ms`, "success");
}

/**
 * Apply min buffer
 */
function applyMinBuffer() {
  const minBuffer = sanitizeBufferMs(parseInt(minBufferInput.value, 10), 250);
  minBufferInput.value = minBuffer;
  localStorage.setItem(STORAGE_KEYS.MIN_BUFFER, minBuffer.toString());
  player?.setMinBufferMs(minBuffer);
  showToast(`Min buffer set to ${minBuffer}ms`, "success");
}

/**
 * Apply correction mode
 */
function applyCorrectionMode() {
  const mode = correctionModeSelect.value;
  saveCorrectionMode(mode);
  if (player) {
    player.setCorrectionMode(mode);
    showToast(`Correction mode set to ${mode}`, "success");
  }
}

/**
 * Initialize the application
 */
function init() {
  // Load saved settings first
  loadSettings();

  // Voice lists load asynchronously and start out empty, so ask for them now:
  // by the time a PIN arrives, bestVoice can honor the server's languages.
  if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();

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
  leaveGroupBtn.addEventListener("click", () => {
    player.leaveGroup();
    showToast("Left the group", "info");
  });
  volumeSlider.addEventListener("input", updateVolume);
  muteBtn.addEventListener("click", toggleMute);
  applySyncDelayBtn.addEventListener("click", applySyncDelay);
  applyRequiredLeadTimeBtn.addEventListener("click", applyRequiredLeadTime);
  applyMinBufferBtn.addEventListener("click", applyMinBuffer);
  correctionModeSelect.addEventListener("change", applyCorrectionMode);
  resyncThresholdInput?.addEventListener("change", () => {
    localStorage.setItem(
      STORAGE_KEYS.RESYNC_THRESHOLD,
      resyncThresholdInput.value,
    );
  });
  deadbandThresholdInput?.addEventListener("change", () => {
    localStorage.setItem(
      STORAGE_KEYS.DEADBAND_THRESHOLD,
      deadbandThresholdInput.value,
    );
  });
  groupVolumeSlider.addEventListener("input", () => {
    sendServerCommand("volume", {
      volume: parseInt(groupVolumeSlider.value, 10),
    });
  });
  groupMuteBtn.addEventListener("click", () => {
    const currentMuted = groupMuteIcon.textContent === "🔇";
    sendServerCommand("mute", { mute: !currentMuted });
  });
  progressBar.addEventListener("click", seekFromProgressBar);
  seekBackBtn.addEventListener("click", () => {
    sendServerCommand("seek_relative", { offset_ms: -10_000 });
  });
  seekForwardBtn.addEventListener("click", () => {
    sendServerCommand("seek_relative", { offset_ms: 10_000 });
  });
  rotatePskBtn.addEventListener("click", () => {
    if (!player) return;
    pairingTokenEl.textContent = player.rotatePairingPsk();
    showToast("Pairing token rotated", "success");
  });
  staticPinInput.addEventListener("change", () => {
    const pin = staticPinInput.value.trim();
    staticPinBothEl.hidden = !isValidStaticPin(pin);
    if (pin && !isValidStaticPin(pin)) {
      showToast("Static pairing code must be exactly 8 digits", "error");
      return;
    }
    localStorage.setItem(STORAGE_KEYS.STATIC_PIN, pin);
    if (player)
      showToast("Static pairing code applies on the next connect", "info");
  });
  const locationGroups = [
    [staticPinLocationInputs, STORAGE_KEYS.STATIC_PIN_LOCATIONS],
    [pairingPskLocationInputs, STORAGE_KEYS.PAIRING_PSK_LOCATIONS],
  ];
  for (const [inputs, key] of locationGroups) {
    inputs.forEach((input) => {
      input.addEventListener("change", () => {
        localStorage.setItem(
          key,
          JSON.stringify(selectedLocations(inputs) ?? []),
        );
        if (player)
          showToast("Location hints apply on the next connect", "info");
      });
    });
  }
  pinSpeakerInput.addEventListener("change", () => {
    localStorage.setItem(
      STORAGE_KEYS.PIN_SPEAKER,
      String(pinSpeakerInput.checked),
    );
    if (player) showToast("Out-channels apply on the next connect", "info");
  });
  pinQrInput.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.PIN_QR, String(pinQrInput.checked));
    if (player) showToast("Formats apply on the next connect", "info");
  });
  openPairingWindowBtn.addEventListener("click", () => {
    if (!player) {
      showToast("Connect first", "error");
      return;
    }
    player.openPairingWindow();
    showToast("Pairing window open (~5 minutes)", "info");
  });
  releasePairingHoldBtn.addEventListener("click", () => {
    if (!player) {
      showToast("Connect first", "error");
      return;
    }
    player.releasePairingHold();
    updateRoundLimitDisplay();
  });
  cancelPairingBtn.addEventListener("click", () => {
    if (!player) return;
    player.cancelPairing();
    showToast("Pairing cancelled", "info");
  });

  // Transport control event listeners
  document.querySelectorAll(".transport-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (sendServerCommand(btn.dataset.command)) showToast(btn.title);
    });
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

  requiredLeadTimeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyRequiredLeadTime();
    }
  });

  minBufferInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyMinBuffer();
    }
  });

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    (player ?? idlePlayer)?.destroy("shutdown");
  });

  // Show HTTPS warning when page is served over HTTPS
  if (isSecureContext()) {
    const httpsWarning = document.getElementById("https-warning");
    if (httpsWarning) {
      httpsWarning.style.display = "block";
    }
  }

  console.log("Sendspin Sample Player initialized");
  if (isLocalDev) {
    console.log("Development mode: using local SDK build");
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
