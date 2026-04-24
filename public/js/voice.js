// ═══════════════════════════════════════════════════════════
// Haven — WebRTC Voice Chat Manager
// ═══════════════════════════════════════════════════════════

class VoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null; // Processed stream (sent to peers)
    this.rawStream = null; // Raw mic stream (for local talk detection)
    this.screenStream = null; // Screen share MediaStream
    this.webcamStream = null; // Webcam video MediaStream
    this.isScreenSharing = false;
    this.isWebcamActive = false;
    this.peers = new Map(); // userId → { connection, stream, username }
    this._lateRenegotiationTimers = new Map(); // key(type:userId) -> timeout id
    this._negotiationSeq = 0;
    this._incomingOfferQueues = new Map();
    this._orphanRemoteCandidates = new Map();
    this.currentChannel = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.inVoice = false;
    this.noiseSensitivity = 10; // Noise gate sensitivity 0 (off) to 100 (aggressive)
    this.currentMicLevel = 0; // Real-time mic input level 0-100 for UI meter
    this.audioCtx = null; // Web Audio context for volume boost
    this.gainNodes = new Map(); // userId → GainNode
    this.localUserId = null; // set by app.js so stopScreenShare can reference own tile
    this.onScreenStream = null; // callback(userId, stream|null) — set by app.js
    this.onWebcamStream = null; // callback(userId, stream|null) — set by app.js
    this.onVoiceJoin = null; // callback(userId, username)
    this.onVoiceLeave = null; // callback(userId, username)
    this.onTalkingChange = null; // callback(userId, isTalking)
    this.screenSharers = new Set(); // userIds currently sharing
    this.webcamUsers = new Set(); // userIds currently broadcasting webcam
    this.screenGainNodes = new Map(); // userId → GainNode for screen share audio
    this.onScreenAudio = null; // callback(userId) — screen share audio available
    this.talkingState = new Map(); // userId → boolean
    this.analysers = new Map(); // userId → { analyser, dataArray, interval }
    this.onScreenShareStarted = null; // callback(userId, username) — someone started streaming
    this.onWebcamStatusChange = null; // callback() — webcam started/stopped, re-render user list
    this.onCodecDebugUpdate = null; // callback(state) — codec mode/default/preferred/active for UI readout
    this.deafenedUsers = new Set(); // userIds we've muted our audio towards
    this._localTalkInterval = null;
    this._noiseGateInterval = null;
    this._noiseGateGain = null;
    this._noiseGateAnalyser = null;
    this._vcDest = null; // MediaStreamDestination node for mixing soundboard audio into VC

    // Voice audio bitrate cap (0 = auto, otherwise kbps from server)
    this.audioBitrate = 0;

    // RNNoise noise suppression state
    this._rnnoiseNode = null; // AudioWorkletNode for RNNoise
    this._rnnoiseReady = false; // true once WASM is loaded in the worklet
    this._rnnoiseSource = null; // MediaStreamSource feeding the chain
    // Noise mode: 'off' | 'gate' | 'suppress'
    const savedMode = localStorage.getItem("haven_noise_mode");
    this.noiseMode = savedMode || "gate";

    // Screen share quality settings (populated from localStorage)
    const savedRes = localStorage.getItem("haven_screen_res");
    this.screenResolution = savedRes !== null ? parseInt(savedRes, 10) : 1080; // 0 = source
    this.screenFrameRate = parseInt(localStorage.getItem("haven_screen_fps") || "30", 10) || 30;
    const savedCodecMode = localStorage.getItem("haven_video_codec_mode");
    this.videoCodecMode = savedCodecMode === "auto" ? "auto" : "preferhwaccel";
    this._codecDebugState = {
      mode: this.videoCodecMode,
      defaultCodec: null,
      preferredCodec: null,
      activeCodec: null,
      liveStats: null,
    };
    this._videoStatsWatchers = new Map(); // sender -> interval id
    this._videoStatsSamples = new Map(); // sender -> { bytesSent, timestamp }
    this._videoCodecModeSwitchInFlight = null;

    // Bitrate map: resolution → bits/sec  (sensible defaults per resolution)
    this._screenBitrates = {
      0: 4_000_000, // 4 Mbps fallback for unconstrained (source)
      720: 1_500_000, // 1.5 Mbps
      1080: 3_000_000, // 3 Mbps
      1440: 5_000_000, // 5 Mbps
    };

    this.rtcConfig = {
      iceServers: [{ urls: "stun:stun.stunprotocol.org:3478" }, { urls: "stun:stun.nextcloud.com:3478" }],
    };

    // Fetch server-provided ICE config (may include TURN)
    this._fetchIceServers();

    this._setupSocketListeners();
  }

  // ── Fetch ICE servers from backend (STUN + optional TURN) ──

  async _fetchIceServers() {
    try {
      const token = localStorage.getItem("haven_token");
      if (!token) return;
      const res = await fetch("/api/ice-servers", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.iceServers && data.iceServers.length) {
          this.rtcConfig.iceServers = data.iceServers;
          console.log(
            `🧊 ICE servers loaded (${data.iceServers.length} servers${data.iceServers.some((s) => String(s.urls).includes("turn:")) ? ", TURN enabled" : ""})`,
          );
        }
      }
    } catch (err) {
      console.warn("Could not fetch ICE servers, using defaults:", err.message);
    }
  }

  // ── Socket event listeners ──────────────────────────────

  _setupSocketListeners() {
    // We just joined: create peer connections + send offers to all existing users
    this.socket.on("voice-existing-users", async (data) => {
      // Apply audio bitrate cap from channel settings
      this.audioBitrate = data.voiceBitrate || 0;
      for (const user of data.users) {
        await this._createPeer(user.id, user.username, true);
      }
    });

    // Someone new joined our voice channel — they'll send us an offer
    this.socket.on("voice-user-joined", (data) => {
      // The new user handles creating offers to existing users,
      // so we just wait for their offer via 'voice-offer'.
      if (this.onVoiceJoin && data && data.user) {
        this.onVoiceJoin(data.user.id, data.user.username);
      }
    });

    // Received an offer — create peer & answer
    this.socket.on("voice-offer", async (data) => {
      const { from, offer, negotiationId } = data;

      let peer = this.peers.get(from.id);
      if (!peer) {
        await this._createPeer(from.id, from.username, false);
        peer = this.peers.get(from.id);
      }

      this._enqueueIncomingOffer(from.id, async () => {
        try {
          await this._acceptIncomingOffer(from.id, from.username, offer, negotiationId);
        } catch (err) {
          console.error("Error handling voice offer:", err);
        }
      });
    });

    // Received an answer to our offer
    this.socket.on("voice-answer", async (data) => {
      const peer = this.peers.get(data.from.id);
      if (peer) {
        try {
          const expectedNegotiationId = peer._pendingLocalOfferId;
          console.log("[Voice] voice-answer received", {
            from: data.from.id,
            negotiationId: data.negotiationId,
            expectedNegotiationId,
            signalingState: peer.connection.signalingState,
          });
          if (expectedNegotiationId && data.negotiationId && data.negotiationId !== expectedNegotiationId) {
            console.log("[Voice] voice-answer: stale negotiationId, ignoring");
            return;
          }

          // Only accept answer if we're actually waiting for one
          // (we may have rolled back our offer due to glare)
          if (peer.connection.signalingState === "have-local-offer") {
            const pendingNegotiationId = peer._pendingLocalOfferId;
            const answerWatchdog = setTimeout(() => {
              const currentPeer = this.peers.get(data.from.id);
              if (!currentPeer) return;
              if (currentPeer !== peer) return;
              if (currentPeer._pendingLocalOfferId !== pendingNegotiationId) return;
              if (currentPeer.connection.signalingState !== "have-local-offer") return;

              console.error("[Voice] voice-answer: apply timed out, rebuilding peer", {
                from: data.from.id,
                negotiationId: data.negotiationId,
                signalingState: currentPeer.connection.signalingState,
              });

              const username = currentPeer.username;
              this._removePeer(data.from.id);
              this._createPeer(data.from.id, username, false).catch((rebuildErr) => {
                console.error("[Voice] voice-answer: peer rebuild failed", rebuildErr);
              });
            }, 3000);

            try {
              await peer.connection.setRemoteDescription(new RTCSessionDescription(data.answer));
            } finally {
              clearTimeout(answerWatchdog);
            }

            if (this.peers.get(data.from.id) !== peer) {
              return;
            }
            peer._pendingLocalOfferId = null;
            console.log("[Voice] voice-answer: applied successfully", { from: data.from.id });
            peer._remoteUfrag = this._extractSdpUfrag(peer.connection.remoteDescription?.sdp || "");
            await this._flushQueuedRemoteCandidates(data.from.id);
          }
        } catch (err) {
          const msg = String(err && (err.message || err));
          if (msg.includes("Remote description indicates ICE restart but offer did not request ICE restart")) {
            peer._pendingLocalOfferId = null;
            this._restartIce(data.from.id, peer.connection);
            return;
          }
          const shouldRollback =
            peer.connection.signalingState === "have-local-offer" &&
            peer._pendingLocalOfferId &&
            (!data.negotiationId || data.negotiationId === peer._pendingLocalOfferId);
          if (shouldRollback) {
            const username = peer.username;
            try {
              await peer.connection.setLocalDescription({ type: "rollback" });
              console.error("[Voice] voice-answer: rolled back failed local offer", {
                from: data.from.id,
                negotiationId: data.negotiationId,
                error: msg,
              });
            } catch (rollbackErr) {
              console.error("[Voice] voice-answer: rollback failed", {
                from: data.from.id,
                negotiationId: data.negotiationId,
                error: String(rollbackErr && (rollbackErr.message || rollbackErr)),
              });
            } finally {
              peer._pendingLocalOfferId = null;
            }

            const rebuiltPeer = this.peers.get(data.from.id);
            if (rebuiltPeer?.connection?.signalingState !== "stable") {
              console.error("[Voice] voice-answer: peer remained non-stable after rollback, rebuilding", {
                from: data.from.id,
                negotiationId: data.negotiationId,
                signalingState: rebuiltPeer?.connection?.signalingState,
              });
              this._removePeer(data.from.id);
              await this._createPeer(data.from.id, username, false);
            }
            return;
          }
          console.error("Error handling voice answer:", err);
        }
      }
    });

    // Received an ICE candidate
    this.socket.on("voice-ice-candidate", async (data) => {
      const peer = this.peers.get(data.from.id);
      if (!peer && data.candidate) {
        const queued = this._orphanRemoteCandidates.get(data.from.id) || [];
        queued.push(data.candidate);
        this._orphanRemoteCandidates.set(data.from.id, queued);
        return;
      }

      if (peer && data.candidate) {
        const conn = peer.connection;
        if (!conn.remoteDescription) {
          if (!peer._pendingRemoteCandidates) peer._pendingRemoteCandidates = [];
          peer._pendingRemoteCandidates.push(data.candidate);
          return;
        }

        const candidateUfrag = data.candidate.usernameFragment || this._extractCandidateUfrag(data.candidate.candidate || "");
        if (candidateUfrag && peer._remoteUfrag && candidateUfrag !== peer._remoteUfrag) {
          return;
        }

        try {
          await conn.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          const msg = String(err && (err.message || err));
          if (msg.includes("Unknown ufrag")) return;
          console.error("Error adding ICE candidate:", err);
        }
      }
    });

    // Server relays speaking state from any voice user (including self)
    this.socket.on("voice-speaking", (data) => {
      if (data && data.userId != null) {
        const uid = data.userId === this.localUserId ? "self" : data.userId;
        if (this.onTalkingChange) this.onTalkingChange(uid, !!data.speaking);
      }
    });

    // Someone left voice
    this.socket.on("voice-user-left", (data) => {
      if (this.onVoiceLeave && data && data.user) {
        this.onVoiceLeave(data.user.id, data.user.username);
      }
      this._stopAnalyser(data.user.id);
      this._removePeer(data.user.id);
      // If they were screen sharing, clean up
      if (this.screenSharers.has(data.user.id)) {
        this.screenSharers.delete(data.user.id);
        if (this.onScreenStream) this.onScreenStream(data.user.id, null);
      }
      // If they had their webcam on, clean up
      if (this.webcamUsers.has(data.user.id)) {
        this.webcamUsers.delete(data.user.id);
        if (this.onWebcamStream) this.onWebcamStream(data.user.id, null);
      }
    });

    // Channel voice bitrate was changed mid-session
    this.socket.on("voice-bitrate-updated", (data) => {
      if (data && data.code === this.currentChannel) {
        this.audioBitrate = data.bitrate || 0;
        // Reapply to all existing peer connections
        for (const [, peer] of this.peers) {
          this._applyAudioBitrate(peer.connection);
        }
      }
    });

    // AFK auto-move: server says we've been idle too long
    this.socket.on("voice-afk-move", async (data) => {
      if (!data || !data.channelCode) return;
      // Leave current voice channel
      this.leave();
      // Notify the app layer
      if (this.onAfkMove) this.onAfkMove(data.channelCode);
    });

    // Kicked from voice because user joined from another client/tab
    this.socket.on("voice-kicked", (data) => {
      if (!data || !data.channelCode) return;
      // Only act if we're currently in the channel we got kicked from
      if (this.currentChannel !== data.channelCode) return;
      this.leave();
      if (this.onVoiceKicked) this.onVoiceKicked(data.channelCode, data.reason);
    });

    // Someone started screen sharing
    this.socket.on("screen-share-started", (data) => {
      this.screenSharers.add(data.userId);
      this._requestRemoteScreenRenegotiation(data.userId).catch(() => {});
      // Play stream start notification sound
      if (this.onScreenShareStarted) {
        this.onScreenShareStarted(data.userId, data.username);
      }
      // Notify UI about audio availability for this stream
      if (!data.hasAudio && this.onScreenNoAudio) {
        this.onScreenNoAudio(data.userId);
      }
    });

    // Someone stopped screen sharing
    this.socket.on("screen-share-stopped", (data) => {
      this.screenSharers.delete(data.userId);
      if (this.onScreenStream) this.onScreenStream(data.userId, null);
    });

    // Someone started their webcam
    this.socket.on("webcam-started", (data) => {
      this.webcamUsers.add(data.userId);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    // Someone stopped their webcam
    this.socket.on("webcam-stopped", (data) => {
      this.webcamUsers.delete(data.userId);
      if (this.onWebcamStream) this.onWebcamStream(data.userId, null);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    // Late joiner: server tells us about active screen sharers
    this.socket.on("active-screen-sharers", (data) => {
      if (data && data.sharers) {
        data.sharers.forEach((s) => {
          this.screenSharers.add(s.id);
          this._requestRemoteScreenRenegotiation(s.id).catch(() => {});
        });
      }
    });

    // Late joiner: server tells us about active webcam users
    this.socket.on("active-webcam-users", (data) => {
      if (data && data.users) {
        data.users.forEach((u) => this.webcamUsers.add(u.id));
        if (this.onWebcamStatusChange) this.onWebcamStatusChange();
      }
    });

    // Server asks us to renegotiate our screen share with a late joiner
    this.socket.on("renegotiate-screen", async (data) => {
      if (!this.screenStream || !this.isScreenSharing || !data || !data.targetUserId) return;
      await this._renegotiateStreamForLateJoiner("screen", data.targetUserId);
    });

    // Server asks us to renegotiate our webcam with a late joiner
    this.socket.on("renegotiate-webcam", async (data) => {
      if (!this.webcamStream || !this.isWebcamActive || !data || !data.targetUserId) return;
      await this._renegotiateStreamForLateJoiner("webcam", data.targetUserId);
    });
  }

  // ── Public API ──────────────────────────────────────────

  async join(channelCode) {
    try {
      const preservedMuteState = this.isMuted;
      const preservedDeafenState = this.isDeafened;

      // Leave existing voice channel if connected elsewhere
      if (this.inVoice) this.leave();

      // Refresh ICE config (TURN credentials may have expired)
      await this._fetchIceServers();

      // Create/resume AudioContext with user gesture (needed for volume boost)
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();

      // Use saved input device if the user picked one
      const savedInputId = localStorage.getItem("haven_input_device") || "";
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (savedInputId) audioConstraints.deviceId = { exact: savedInputId };

      try {
        this.rawStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      } catch (deviceErr) {
        if (savedInputId) {
          // Saved device may be stale — retry with default mic
          console.warn("Saved mic device failed, falling back to default:", deviceErr.message);
          localStorage.removeItem("haven_input_device");
          delete audioConstraints.deviceId;
          this.rawStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false,
          });
        } else {
          throw deviceErr;
        }
      }

      // Opt out of Windows audio ducking (Desktop app only).
      // Must be called after getUserMedia so our audio session exists.
      if (window.havenDesktop?.audio?.optOutOfDucking) {
        setTimeout(() => window.havenDesktop.audio.optOutOfDucking().catch(() => {}), 500);
      }

      // ── Noise Gate via Web Audio ──
      // Route mic through an analyser + gain node so we can silence
      // audio below a threshold before sending it to peers.
      const source = this.audioCtx.createMediaStreamSource(this.rawStream);
      this._rnnoiseSource = source;
      const gateAnalyser = this.audioCtx.createAnalyser();
      gateAnalyser.fftSize = 2048;
      gateAnalyser.smoothingTimeConstant = 0.3;
      source.connect(gateAnalyser);

      const gateGain = this.audioCtx.createGain();
      source.connect(gateGain);

      const dest = this.audioCtx.createMediaStreamDestination();
      gateGain.connect(dest);

      this._noiseGateAnalyser = gateAnalyser;
      this._noiseGateGain = gateGain;
      this._vcDest = dest;
      this.localStream = dest.stream; // processed stream → peers
      this._startNoiseGate();

      // Initialize RNNoise and apply saved noise mode
      await this._initRNNoise();
      if (this.noiseMode === "suppress" && this._rnnoiseReady) {
        this.setNoiseSensitivity(0);
        this._enableRNNoise();
      } else if (this.noiseMode === "off") {
        this.setNoiseSensitivity(0);
      } else if (this.noiseMode === "gate") {
        const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
        this.setNoiseSensitivity(saved);
      }

      this.currentChannel = channelCode;
      this.inVoice = true;
      this.isMuted = preservedMuteState;
      this.isDeafened = preservedDeafenState;

      this._applyMuteStateToLocalTracks();

      // Persist voice channel for auto-rejoin after page refresh or server restart
      try {
        localStorage.setItem("haven_voice_channel", channelCode);
      } catch {}

      this.socket.emit("voice-join", { code: channelCode });

      // Start local talk indicator (use raw stream for accurate detection)
      this._startLocalTalkDetection();

      return true;
    } catch (err) {
      console.error("Microphone access failed:", err);
      return false;
    }
  }

  leave() {
    // Stop screen share first if active
    if (this.isScreenSharing) {
      this.stopScreenShare();
    }
    // Stop webcam if active
    if (this.isWebcamActive) {
      this.stopWebcam();
    }

    // Stop noise gate and talk detection
    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    for (const [id] of this.analysers) this._stopAnalyser(id);

    // Capture channel code BEFORE clearing state
    const leavingChannel = this.currentChannel;

    if (leavingChannel) {
      // Use Socket.IO acknowledgment to confirm server received the leave.
      // If no ack within 2s (socket glitch, transport switch), retry.
      let acked = false;
      this.socket.emit("voice-leave", { code: leavingChannel }, (response) => {
        acked = true;
      });
      setTimeout(() => {
        if (!acked && this.socket.connected) {
          console.warn("[Voice] voice-leave not acked, retrying...");
          this.socket.emit("voice-leave", { code: leavingChannel });
        }
      }, 2000);
    }

    // Close all peer connections
    for (const [id] of this.peers) {
      this._removePeer(id);
    }
    this.gainNodes.clear();

    // Stop local tracks (both raw and processed)
    if (this.rawStream) {
      this.rawStream.getTracks().forEach((t) => t.stop());
      this.rawStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.audioBitrate = 0;
    this.screenSharers.clear();
    this.screenGainNodes.clear();
    this.webcamUsers.clear();
    this._vcDest = null;
    this._clearAllCodecStatsWatches();
    this._updateCodecDebugState({
      defaultCodec: null,
      preferredCodec: null,
      activeCodec: null,
      liveStats: null,
    });

    // Close AudioContext to free resources
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    // Clear cached silent track
    this._cachedSilentTrack = null;

    // Clear persisted voice channel
    try {
      localStorage.removeItem("haven_voice_channel");
    } catch {}

    // Clear any pending disconnect-recovery timers
    if (this._disconnectTimers) {
      for (const key of Object.keys(this._disconnectTimers)) {
        clearTimeout(this._disconnectTimers[key]);
      }
      this._disconnectTimers = {};
    }

    for (const [, timer] of this._lateRenegotiationTimers) {
      clearTimeout(timer);
    }
    this._lateRenegotiationTimers.clear();
  }

  /**
   * Soft-leave: clean up local voice state WITHOUT emitting to the server.
   * Used when the socket disconnects unexpectedly (e.g. mobile screen timeout)
   * so the client state is reset and the auto-rejoin on reconnect can work.
   * Intentionally keeps haven_voice_channel in localStorage for that rejoin.
   */
  _softLeave() {
    if (!this.inVoice) return;

    // Stop screen share / webcam (local cleanup only)
    if (this.isScreenSharing && this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.isScreenSharing = false;
    }
    if (this.isWebcamActive && this.webcamStream) {
      this.webcamStream.getTracks().forEach((t) => t.stop());
      this.webcamStream = null;
      this.isWebcamActive = false;
    }

    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    for (const [id] of this.analysers) this._stopAnalyser(id);

    for (const [id] of this.peers) {
      this._removePeer(id);
    }
    this.gainNodes.clear();

    if (this.rawStream) {
      this.rawStream.getTracks().forEach((t) => t.stop());
      this.rawStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.screenSharers.clear();
    this.screenGainNodes.clear();
    this.webcamUsers.clear();
    this._vcDest = null;
    this._clearAllCodecStatsWatches();
    this._updateCodecDebugState({
      defaultCodec: null,
      preferredCodec: null,
      activeCodec: null,
      liveStats: null,
    });

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this._cachedSilentTrack = null;

    if (this._disconnectTimers) {
      for (const key of Object.keys(this._disconnectTimers)) {
        clearTimeout(this._disconnectTimers[key]);
      }
      this._disconnectTimers = {};
    }

    for (const [, timer] of this._lateRenegotiationTimers) {
      clearTimeout(timer);
    }
    this._lateRenegotiationTimers.clear();
    // NOTE: leaves haven_voice_channel in localStorage so auto-rejoin on reconnect works
  }

  // Play a soundboard audio file and mix it into the VC stream so other users hear it
  playSoundToVC(url, localVolume = 0.5) {
    if (!this.inVoice || !this.audioCtx || !this._vcDest) return false;
    // Use fetch + decodeAudioData for reliable mixing into VC destination
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        return this.audioCtx.decodeAudioData(buf);
      })
      .then((audioBuffer) => {
        const bufferSource = this.audioCtx.createBufferSource();
        bufferSource.buffer = audioBuffer;
        // Mix into the VC destination so peers hear it
        const vcGain = this.audioCtx.createGain();
        vcGain.gain.value = 0.7;
        bufferSource.connect(vcGain);
        vcGain.connect(this._vcDest);
        // Also play locally for the user's own preview
        const localGain = this.audioCtx.createGain();
        localGain.gain.value = localVolume;
        bufferSource.connect(localGain);
        localGain.connect(this.audioCtx.destination);
        bufferSource.start(0);
      })
      .catch(() => {});
    return true;
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this._applyMuteStateToLocalTracks();
    return this.isMuted;
  }

  _applyMuteStateToLocalTracks() {
    if (this.rawStream) {
      this.rawStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    // Mute/unmute all incoming audio (voice)
    for (const [userId, gainNode] of this.gainNodes) {
      gainNode.gain.value = this.isDeafened ? 0 : this._getSavedVolume(userId);
    }
    // Mute/unmute screen share audio
    for (const [userId, gainNode] of this.screenGainNodes) {
      gainNode.gain.value = this.isDeafened ? 0 : this._getSavedStreamVolume(userId);
    }
    // Also mute all audio elements as fallback
    document.querySelectorAll("#audio-container audio").forEach((el) => {
      if (this.isDeafened) {
        el.dataset.prevVolume = el.volume;
        el.volume = 0;
      } else {
        el.volume = parseFloat(el.dataset.prevVolume || 1);
      }
    });
    return this.isDeafened;
  }

  _getAppliedIncomingVolume(volume) {
    return this.isDeafened ? 0 : volume;
  }

  // ── Screen Sharing ──────────────────────────────────────

  async shareScreen() {
    if (!this.inVoice || this.isScreenSharing) return false;
    try {
      // Build video constraints from quality settings
      const videoConstraints = { cursor: "always" };
      const res = this.screenResolution; // 720 | 1080 | 1440 | 0 (source)
      const fps = this.screenFrameRate; // 15 | 30 | 60

      if (res && res !== 0) {
        // 16:9 width from height
        const widths = { 720: 1280, 1080: 1920, 1440: 2560 };
        videoConstraints.width = { ideal: widths[res] || 1920 };
        videoConstraints.height = { ideal: res };
      }
      videoConstraints.frameRate = { ideal: fps };

      const displayMediaOptions = {
        video: videoConstraints,
        audio: true,
      };

      // These options aren't supported in Electron's Chromium — only add them
      // when running in a regular browser to avoid immediate rejection.
      const isElectron = !!(window.havenDesktop || navigator.userAgent.includes("Electron"));
      if (!isElectron) {
        displayMediaOptions.surfaceSwitching = "exclude";
        displayMediaOptions.selfBrowserSurface = "include";
        displayMediaOptions.monitorTypeSurfaces = "include";

        // Use CaptureController if available to manage the capture session
        if (typeof CaptureController !== "undefined") {
          this._captureController = new CaptureController();
          displayMediaOptions.controller = this._captureController;
        }
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

      this.isScreenSharing = true;

      // When user clicks browser "Stop sharing" button
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      // If screen audio track dies independently, update flag
      const screenAudioTrack = this.screenStream.getAudioTracks()[0];
      if (screenAudioTrack) {
        screenAudioTrack.onended = () => {
          this.screenHasAudio = false;
        };
      }

      // Add screen tracks to all existing peer connections and cap bitrate
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      for (const [userId, peer] of this.peers) {
        this.screenStream.getTracks().forEach((track) => {
          peer.connection.addTrack(track, this.screenStream);
        });
        // Enable hardware acceleration for video codec
        this._preferHardwareAcceleration(peer.connection);
        // Cap the video bitrate so WebRTC doesn't starve framerate
        this._applyScreenBitrate(peer.connection, maxBitrate);
        // Renegotiate with each peer
        await this._renegotiate(userId, peer.connection);
      }

      // Tell the server we're sharing (include audio availability)
      const hasAudio = this.screenStream.getAudioTracks().length > 0;
      this.screenHasAudio = hasAudio;
      this.socket.emit("screen-share-started", {
        code: this.currentChannel,
        hasAudio,
      });

      return true;
    } catch (err) {
      console.error("Screen share failed:", err);
      this.isScreenSharing = false;
      this.screenStream = null;
      return false;
    }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing || !this.screenStream) return;

    const tracks = this.screenStream.getTracks();

    // Remove screen tracks from all peer connections FIRST, then stop them.
    // Stopping tracks before all peers have removed them causes renegotiation
    // to reference dead tracks and corrupt audio.
    const renegotiations = [];
    for (const [userId, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      tracks.forEach((track) => {
        const sender = senders.find((s) => s.track === track);
        if (sender) {
          try {
            peer.connection.removeTrack(sender);
          } catch {}
        }
      });
      // Renegotiate and track the promise so we can wait for completion
      renegotiations.push(this._renegotiate(userId, peer.connection).catch(() => {}));
    }

    // Wait for all renegotiations to complete (with a timeout so we don't hang forever)
    try {
      await Promise.race([Promise.all(renegotiations), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch {
      /* proceed anyway */
    }

    // Now safe to stop tracks — all peers have detached them
    tracks.forEach((t) => t.stop());

    this.screenStream = null;
    this.isScreenSharing = false;
    this._captureController = null;
    this._clearAllCodecStatsWatches();
    if (!this.isWebcamActive) {
      this._updateCodecDebugState({ activeCodec: null, liveStats: null });
    }

    this.socket.emit("screen-share-stopped", { code: this.currentChannel });
    // Notify local UI — pass localUserId so tile is found by its real ID
    if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
  }

  // ── Webcam Video ────────────────────────────────────────

  async startWebcam() {
    if (!this.inVoice || this.isWebcamActive) return false;
    try {
      const savedCamId = localStorage.getItem("haven_cam_device") || "";
      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      };
      if (savedCamId) videoConstraints.deviceId = { exact: savedCamId };

      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false, // mic already captured separately
      });

      this.isWebcamActive = true;

      // When user revokes camera permission
      this.webcamStream.getVideoTracks()[0].onended = () => {
        this.stopWebcam();
      };

      // Add webcam video track to all existing peer connections
      const camTrack = this.webcamStream.getVideoTracks()[0];
      for (const [userId, peer] of this.peers) {
        peer.connection.addTrack(camTrack, this.webcamStream);
        // Enable hardware acceleration for video codec
        this._preferHardwareAcceleration(peer.connection);
        await this._renegotiate(userId, peer.connection);
      }

      // Tell the server
      this.socket.emit("webcam-started", { code: this.currentChannel });
      return true;
    } catch (err) {
      console.error("Webcam access failed:", err);
      this.isWebcamActive = false;
      this.webcamStream = null;
      return false;
    }
  }

  async stopWebcam() {
    if (!this.isWebcamActive || !this.webcamStream) return;

    const tracks = this.webcamStream.getTracks();

    // Remove webcam track from all peer connections
    const renegotiations = [];
    for (const [userId, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      tracks.forEach((track) => {
        const sender = senders.find((s) => s.track === track);
        if (sender) {
          try {
            peer.connection.removeTrack(sender);
          } catch {}
        }
      });
      renegotiations.push(this._renegotiate(userId, peer.connection).catch(() => {}));
    }

    try {
      await Promise.race([Promise.all(renegotiations), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch {}

    tracks.forEach((t) => t.stop());

    this.webcamStream = null;
    this.isWebcamActive = false;
    this._clearAllCodecStatsWatches();
    if (!this.isScreenSharing) {
      this._updateCodecDebugState({ activeCodec: null, liveStats: null });
    }

    this.socket.emit("webcam-stopped", { code: this.currentChannel });
    if (this.onWebcamStream) this.onWebcamStream(this.localUserId, null);
  }

  async switchCamera(deviceId) {
    if (!this.isWebcamActive) return;
    const videoConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (err) {
      console.error("[Voice] Failed to switch camera:", err);
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];

    // Replace track on all peers and re-apply hardware acceleration
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const camSender = senders.find(
        (s) => s.track && s.track.kind === "video" && this.webcamStream && this.webcamStream.getVideoTracks().includes(s.track),
      );
      if (camSender) {
        await camSender.replaceTrack(newTrack).catch((e) => console.warn("[Voice] replaceTrack (cam) failed:", e));
      }
    }

    // Stop old tracks and update stream reference
    this.webcamStream.getTracks().forEach((t) => t.stop());
    this.webcamStream = newStream;

    // Re-hook ended
    newTrack.onended = () => this.stopWebcam();

    // Re-apply hardware acceleration with new track
    for (const [, peer] of this.peers) {
      this._preferHardwareAcceleration(peer.connection);
    }

    localStorage.setItem("haven_cam_device", deviceId || "");
    console.log(`[Voice] Camera switched: ${deviceId || "default"}`);
  }

  // ── Screen Share Quality Helpers ───────────────────────

  setScreenResolution(h) {
    this.screenResolution = h; // 720 | 1080 | 1440 | 0 = source
    localStorage.setItem("haven_screen_res", h);
    if (this.isScreenSharing) this._applyLiveQualityChange();
  }

  setScreenFrameRate(fps) {
    this.screenFrameRate = fps; // 15 | 30 | 60
    localStorage.setItem("haven_screen_fps", fps);
    if (this.isScreenSharing) this._applyLiveQualityChange();
  }

  getCodecDebugState() {
    return { ...this._codecDebugState };
  }

  _updateCodecDebugState(patch) {
    this._codecDebugState = {
      ...this._codecDebugState,
      ...patch,
    };
    if (this.onCodecDebugUpdate) {
      this.onCodecDebugUpdate(this.getCodecDebugState());
    }
  }

  _clearCodecStatsWatch(sender) {
    const watcher = this._videoStatsWatchers.get(sender);
    if (watcher) {
      clearInterval(watcher);
      this._videoStatsWatchers.delete(sender);
    }
    this._videoStatsSamples.delete(sender);
  }

  _clearAllCodecStatsWatches() {
    for (const [, watcher] of this._videoStatsWatchers) {
      clearInterval(watcher);
    }
    this._videoStatsWatchers.clear();
    this._videoStatsSamples.clear();
  }

  _formatCodecLiveStats(report, bitrateBps) {
    const framesSent = report.framesSent ?? 0;
    const width = report.frameWidth || 0;
    const height = report.frameHeight || 0;
    const resolution = width && height ? `${width}x${height}` : "-";
    const bitrateKbps = bitrateBps > 0 ? `${Math.round(bitrateBps / 1000)} kbps` : "-";
    return `${framesSent} fr | ${resolution} | ${bitrateKbps}`;
  }

  _pickVideoOutboundReport(stats, sender) {
    let preferred = null;
    let fallback = null;
    const senderTrackId = sender?.track?.id;

    stats.forEach((report) => {
      if (report.type !== "outbound-rtp" || report.isRemote) return;

      if (senderTrackId && report.trackIdentifier && report.trackIdentifier !== senderTrackId) {
        return;
      }

      const mediaType = String(report.kind || report.mediaType || "").toLowerCase();
      const codec = report.codecId ? stats.get(report.codecId) : null;
      const mimeType = String(codec?.mimeType || "").toLowerCase();
      const hasVideoLikeMetrics =
        typeof report.framesSent === "number" ||
        typeof report.frameWidth === "number" ||
        typeof report.frameHeight === "number" ||
        typeof report.framesPerSecond === "number";
      const looksVideo = mediaType === "video" || mimeType.startsWith("video/") || hasVideoLikeMetrics;
      if (!looksVideo) return;

      if (senderTrackId && report.trackIdentifier === senderTrackId) {
        preferred = report;
        return;
      }

      if (!fallback) {
        fallback = report;
      }
    });

    return preferred || fallback;
  }

  _startCodecStatsWatch(sender) {
    this._clearCodecStatsWatch(sender);

    const pollStats = async () => {
      if (!sender || !sender.track || sender.track.readyState === "ended") {
        this._clearCodecStatsWatch(sender);
        return;
      }

      try {
        const stats = await sender.getStats();
        const selectedReport = this._pickVideoOutboundReport(stats, sender);

        if (!selectedReport) {
          this._updateCodecDebugState({ activeCodec: null, liveStats: null });
          return;
        }

        const codec = selectedReport.codecId ? stats.get(selectedReport.codecId) : null;
        const activeMimeType = (codec?.mimeType || "unknown").toLowerCase();
        const isVideoCodec = activeMimeType.startsWith("video/");

        const sample = this._videoStatsSamples.get(sender);
        let bitrateBps = 0;
        if (sample && typeof selectedReport.bytesSent === "number" && typeof selectedReport.timestamp === "number") {
          const bytesDelta = selectedReport.bytesSent - sample.bytesSent;
          const timeDeltaMs = selectedReport.timestamp - sample.timestamp;
          if (bytesDelta >= 0 && timeDeltaMs > 0) {
            bitrateBps = (bytesDelta * 8 * 1000) / timeDeltaMs;
          }
        }
        if (typeof selectedReport.bytesSent === "number" && typeof selectedReport.timestamp === "number") {
          this._videoStatsSamples.set(sender, {
            bytesSent: selectedReport.bytesSent,
            timestamp: selectedReport.timestamp,
          });
        }

        this._updateCodecDebugState({
          activeCodec: isVideoCodec ? activeMimeType : null,
          liveStats: this._formatCodecLiveStats(selectedReport, bitrateBps),
        });
      } catch (e) {
        const message = e?.message || String(e);
        const unusable = /no longer usable|not usable|invalid state|closed/i.test(message);
        if (unusable) {
          this._clearCodecStatsWatch(sender);
          return;
        }
        console.warn("[Voice] Could not read live video stats:", message);
      }
    };

    pollStats();
    const watcher = setInterval(pollStats, 1500);
    this._videoStatsWatchers.set(sender, watcher);
  }

  async _restartVideoStreamsForCodecModeChange() {
    const restartScreen = this.isScreenSharing;
    const restartWebcam = this.isWebcamActive;

    if (restartScreen) {
      await this.stopScreenShare();
    }
    if (restartWebcam) {
      await this.stopWebcam();
    }
    if (restartScreen) {
      await this.shareScreen();
    }
    if (restartWebcam) {
      await this.startWebcam();
    }
  }

  async setVideoCodecMode(mode) {
    const nextMode = mode === "auto" ? "auto" : "preferhwaccel";
    const modeChanged = this.videoCodecMode !== nextMode;
    this.videoCodecMode = nextMode;
    localStorage.setItem("haven_video_codec_mode", this.videoCodecMode);
    this._clearAllCodecStatsWatches();
    this._updateCodecDebugState({
      mode: this.videoCodecMode,
      activeCodec: null,
      liveStats: null,
    });

    if (!modeChanged || (!this.isScreenSharing && !this.isWebcamActive)) {
      return;
    }

    if (this._videoCodecModeSwitchInFlight) {
      return this._videoCodecModeSwitchInFlight;
    }

    this._videoCodecModeSwitchInFlight = this._restartVideoStreamsForCodecModeChange();
    try {
      await this._videoCodecModeSwitchInFlight;
    } finally {
      this._videoCodecModeSwitchInFlight = null;
    }
  }

  /**
   * Apply resolution / framerate / bitrate changes to an active screen share
   * without stopping and restarting the stream.
   */
  async _applyLiveQualityChange() {
    if (!this.screenStream) return;
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (!videoTrack) return;

    const res = this.screenResolution;
    const fps = this.screenFrameRate;

    // Apply new constraints to the live capture track
    const constraints = {};
    if (res && res !== 0) {
      const widths = { 720: 1280, 1080: 1920, 1440: 2560 };
      constraints.width = { ideal: widths[res] || 1920 };
      constraints.height = { ideal: res };
    }
    constraints.frameRate = { ideal: fps };

    try {
      await videoTrack.applyConstraints(constraints);
    } catch (e) {
      console.warn("applyConstraints failed (browser may not support live constraint changes):", e);
    }

    // Update bitrate cap on all peer senders
    const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
    for (const [, peer] of this.peers) {
      this._applyScreenBitrate(peer.connection, maxBitrate);
    }
  }

  /**
   * Cap the video bitrate on screen-share senders for a given peer connection.
   * Uses RTCRtpSender.setParameters() which is widely supported.
   */
  _applyScreenBitrate(connection, maxBitrate) {
    try {
      const senders = connection.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === "video" && this.screenStream && this.screenStream.getVideoTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = maxBitrate;
          sender.setParameters(params).catch(() => {});
        }
      }
    } catch (e) {
      /* setParameters not supported — adaptive bitrate remains */
    }
  }

  _isPrimaryVideoCodec(codec) {
    const mime = (codec?.mimeType || "").toLowerCase();
    if (!mime.startsWith("video/")) return false;
    // Exclude repair/redundancy codecs from "primary codec" decisions.
    return !["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"].includes(mime);
  }

  _getCodecLabel(codec) {
    if (!codec) return "unknown";
    const mime = codec.mimeType || "unknown";
    const fmtp = codec.sdpFmtpLine ? ` (${codec.sdpFmtpLine})` : "";
    return `${mime}${fmtp}`;
  }

  _shouldForceCodecPreferences() {
    const ua = navigator.userAgent || "";
    return !/firefox\//i.test(ua);
  }

  /**
   * Enable hardware acceleration for video by prioritizing hardware-accelerated codecs.
   * H.264 is commonly hardware-accelerated on most devices. This should be called
   * after adding video tracks to peer connections.
   */
  _preferHardwareAcceleration(connection) {
    try {
      const shouldForceCodecPreferences = this._shouldForceCodecPreferences();
      const senders = connection.getSenders();
      const transceivers = connection.getTransceivers();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === "video") {
          const transceiver = transceivers.find((t) => t.sender === sender);
          if (!transceiver) continue;

          // Use receiver capabilities first as recommended for setCodecPreferences.
          // Fall back to sender capabilities for older browser implementations.
          const capabilities =
            (typeof RTCRtpReceiver !== "undefined" &&
              typeof RTCRtpReceiver.getCapabilities === "function" &&
              RTCRtpReceiver.getCapabilities("video")) ||
            (typeof RTCRtpSender !== "undefined" && typeof RTCRtpSender.getCapabilities === "function" && RTCRtpSender.getCapabilities("video"));
          const capCodecs = capabilities && capabilities.codecs;
          if (!Array.isArray(capCodecs) || capCodecs.length === 0) continue;

          // Log available codecs
          console.log("[Voice] Available video codecs:", capCodecs.map((c) => c.mimeType).join(", "));

          // Prefer broadest cross-browser interoperability first:
          // H.264 (widely hardware-accelerated), then VP8 (mandatory in WebRTC),
          // then VP9/AV1 where available.
          const codecPriority = {
            "video/h264": 0,
            "video/vp8": 1,
            "video/vp9": 2,
            "video/av1": 3,
          };

          const h264Score = (codec) => {
            const fmtp = (codec.sdpFmtpLine || "").toLowerCase();
            // Prefer non-interleaved mode and constrained baseline profile when present.
            const packetizationBonus = fmtp.includes("packetization-mode=1") ? -10 : 0;
            const constrainedBaselineBonus = fmtp.includes("profile-level-id=42e0") || fmtp.includes("profile-level-id=42c0") ? -5 : 0;
            return packetizationBonus + constrainedBaselineBonus;
          };

          const sortedCodecs = [...capCodecs].sort((a, b) => {
            const aMime = (a.mimeType || "").toLowerCase();
            const bMime = (b.mimeType || "").toLowerCase();
            const aPri = Object.prototype.hasOwnProperty.call(codecPriority, aMime) ? codecPriority[aMime] : 100;
            const bPri = Object.prototype.hasOwnProperty.call(codecPriority, bMime) ? codecPriority[bMime] : 100;
            if (aPri !== bPri) return aPri - bPri;
            if (aMime === "video/h264" && bMime === "video/h264") {
              return h264Score(a) - h264Score(b);
            }
            return 0;
          });

          const defaultPrimaryCodec = capCodecs.find((c) => this._isPrimaryVideoCodec(c));
          const preferredPrimaryCodec = sortedCodecs.find((c) => this._isPrimaryVideoCodec(c));
          const requestedCodecMode = this.videoCodecMode || "preferhwaccel";
          const codecMode = shouldForceCodecPreferences ? requestedCodecMode : "auto";
          this._updateCodecDebugState({
            mode: codecMode,
            defaultCodec: this._getCodecLabel(defaultPrimaryCodec),
            preferredCodec: this._getCodecLabel(preferredPrimaryCodec),
            liveStats: null,
          });

          if (sortedCodecs.length > 0) {
            // setCodecPreferences is the supported way to prioritize codecs.
            // sender.setParameters({ codecs }) expects RTCRtpCodecParameters and
            // fails in Chromium when payloadType is missing.
            const primaryCodec = sortedCodecs[0]?.mimeType || "unknown";
            console.log(`[Voice] Setting preferred codec: ${primaryCodec}`);
            console.log(
              "[Voice] Codec decision baseline:",
              `mode = ${codecMode}`,
              "default-order first primary =",
              this._getCodecLabel(defaultPrimaryCodec),
              "| preferred-order first primary =",
              this._getCodecLabel(preferredPrimaryCodec),
            );
            if (transceiver && typeof transceiver.setCodecPreferences === "function") {
              try {
                if (!shouldForceCodecPreferences) {
                  transceiver.setCodecPreferences([]);
                  console.log("[Voice] Firefox detected; using browser default codec negotiation order");
                } else if (codecMode === "auto") {
                  transceiver.setCodecPreferences([]);
                  console.log("[Voice] Codec preference mode is auto; using browser default negotiation order");
                } else {
                  transceiver.setCodecPreferences(sortedCodecs);
                }
              } catch (err) {
                console.warn("[Voice] setCodecPreferences failed; browser will auto-select codec:", err?.message || err);
              }
            } else {
              console.log("[Voice] Codec preference API unavailable; browser will auto-select codec");
            }

            this._startCodecStatsWatch(sender);

            // Check actual codec being used after a short delay
            setTimeout(async () => {
              try {
                if (!sender || !sender.track || sender.track.readyState === "ended") {
                  return;
                }
                const stats = await sender.getStats();
                const selectedReport = this._pickVideoOutboundReport(stats, sender);

                if (!selectedReport) return;

                const codec = selectedReport.codecId ? stats.get(selectedReport.codecId) : null;
                const activeMimeType = codec?.mimeType || "unknown";
                const fps = selectedReport.framesPerSecond ?? selectedReport.frameRate ?? "n/a";
                console.log(
                  "[Voice] Active video codec:",
                  activeMimeType,
                  `| Mode: ${codecMode}`,
                  `| Default(no intervention): ${this._getCodecLabel(defaultPrimaryCodec)}`,
                  `| Preferred: ${this._getCodecLabel(preferredPrimaryCodec)}`,
                  `| Frames: ${selectedReport.framesSent || 0} | Rate: ${fps}fps`,
                );
                if (String(activeMimeType).toLowerCase().startsWith("video/")) {
                  this._updateCodecDebugState({ activeCodec: activeMimeType });
                }
              } catch (e) {
                console.warn("[Voice] Could not read video stats:", e.message);
              }
            }, 1500);
          }
        }
      }
    } catch (e) {
      console.warn("[Voice] Hardware acceleration setup failed:", e.message);
    }
  }

  /**
   * Cap the audio bitrate on voice senders for a given peer connection.
   * audioBitrate is in kbps; convert to bps for setParameters.
   * 0 = no cap (remove maxBitrate constraint).
   */
  _applyAudioBitrate(connection) {
    if (!this.audioBitrate) return; // 0 = auto, nothing to cap
    try {
      const senders = connection.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === "audio" && this.localStream && this.localStream.getAudioTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = this.audioBitrate * 1000;
          sender.setParameters(params).catch(() => {});
        }
      }
    } catch (e) {
      /* setParameters not supported */
    }
  }

  async _renegotiate(userId, connection) {
    try {
      return await this._emitLocalOffer(userId, connection, { iceRestart: false });
    } catch (err) {
      console.error("Renegotiation failed:", err);
      return false;
    }
  }

  _enqueueIncomingOffer(userId, handler) {
    const prev = this._incomingOfferQueues.get(userId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(handler)
      .catch(() => {});
    this._incomingOfferQueues.set(userId, next);
    next.finally(() => {
      if (this._incomingOfferQueues.get(userId) === next) {
        this._incomingOfferQueues.delete(userId);
      }
    });
  }

  async _emitLocalOffer(userId, connection, { iceRestart = false } = {}) {
    const peer = this.peers.get(userId);
    if (!peer) return false;

    if (peer._pendingLocalOfferId || connection.signalingState !== "stable") {
      return false;
    }

    const negotiationId = this._nextNegotiationId(userId);
    peer._pendingLocalOfferId = negotiationId;

    try {
      const offer = iceRestart ? await connection.createOffer({ iceRestart: true }) : await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.socket.emit("voice-offer", {
        code: this.currentChannel,
        targetUserId: userId,
        offer: offer,
        negotiationId,
      });
      return true;
    } catch (err) {
      if (peer._pendingLocalOfferId === negotiationId) {
        peer._pendingLocalOfferId = null;
      }
      throw err;
    }
  }

  async _acceptIncomingOffer(userId, username, offer, negotiationId, allowPeerReset = true) {
    let peer = this.peers.get(userId);

    // Deduplicate: ignore any offer we already processed or are processing right now.
    // Both flags are set synchronously (before any await) so concurrent or sequential
    // duplicate deliveries of the same negotiationId are always blocked.
    // _lastHandledIncomingOfferId is set eagerly so a failure mid-processing still
    // prevents re-processing (sharer will retry with a fresh negotiationId if needed).
    if (negotiationId && peer) {
      if (peer._lastHandledIncomingOfferId === negotiationId) {
        console.log("[Voice] _acceptIncomingOffer: dedup blocked (already handled)", { userId, negotiationId, allowPeerReset });
        return;
      }
      if (peer._incomingOfferInFlightId === negotiationId) {
        console.log("[Voice] _acceptIncomingOffer: dedup blocked (in flight)", { userId, negotiationId, allowPeerReset });
        return;
      }
      peer._incomingOfferInFlightId = negotiationId;
      peer._lastHandledIncomingOfferId = negotiationId;
    }

    if (!peer) {
      await this._createPeer(userId, username, false);
      peer = this.peers.get(userId);
      if (!peer) throw new Error("Failed to create peer for incoming offer");
      // Set both dedup guards on the freshly-created peer.
      if (negotiationId) {
        peer._incomingOfferInFlightId = negotiationId;
        peer._lastHandledIncomingOfferId = negotiationId;
      }
    }

    const conn = peer.connection;
    const offerVideoCount = (offer.sdp || "").split("\n").filter((l) => l.startsWith("m=video")).length;
    console.log("[Voice] _acceptIncomingOffer", {
      userId,
      negotiationId,
      allowPeerReset,
      signalingState: conn.signalingState,
      offerVideoSections: offerVideoCount,
    });

    // Only rollback when we actually have a local offer pending.
    if (conn.signalingState === "have-local-offer") {
      await conn.setLocalDescription({ type: "rollback" });
      peer._pendingLocalOfferId = null;
    } else if (conn.signalingState !== "stable") {
      // Wait briefly for transitional states to settle, then continue.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    try {
      await conn.setRemoteDescription(new RTCSessionDescription(offer));
    } catch (err) {
      const msg = String(err && (err.message || err));
      const isHeaderExtConflict = msg.includes("Failed to update RTP header extensions") || msg.includes("RTP extension ID reassignment");
      const isUnexpectedRemoteIceChange = msg.includes("Remote description indicates ICE restart but offer did not request ICE restart");

      console.error("[Voice] _acceptIncomingOffer: setRemoteDescription failed", {
        userId,
        negotiationId,
        allowPeerReset,
        signalingState: conn.signalingState,
        isHeaderExtConflict,
        isUnexpectedRemoteIceChange,
        error: msg,
      });

      if (allowPeerReset && isHeaderExtConflict) {
        // Recover from extmap conflicts by rebuilding only this peer connection.
        // For video offers, request a fresh receiver-driven negotiation instead of
        // reapplying the stale failed offer. That matches the observed behavior
        // where a later fresh negotiation succeeds while the original offer does not.
        const shouldRequestFreshVideoOffer = offerVideoCount > 0;
        this._removePeer(userId);
        await this._createPeer(userId, username, false);
        if (shouldRequestFreshVideoOffer) {
          console.warn("[Voice] _acceptIncomingOffer: rebuilding peer and requesting fresh video negotiation", {
            userId,
            negotiationId,
          });
          await this._requestRemoteScreenRenegotiation(userId);
          return;
        }

        const newPeer = this.peers.get(userId);
        await this._acceptIncomingOffer(userId, username, offer, negotiationId, false);
        return;
      }

      if (allowPeerReset && isUnexpectedRemoteIceChange) {
        const oldQueued = peer._pendingRemoteCandidates ? [...peer._pendingRemoteCandidates] : [];
        this._removePeer(userId);
        await this._createPeer(userId, username, false);
        const newPeer = this.peers.get(userId);
        if (newPeer && oldQueued.length > 0) {
          newPeer._pendingRemoteCandidates = oldQueued;
        }
        await this._acceptIncomingOffer(userId, username, offer, negotiationId, false);
        return;
      }

      throw err;
    } finally {
      if (negotiationId && peer._incomingOfferInFlightId === negotiationId) {
        peer._incomingOfferInFlightId = null;
      }
    }

    peer._remoteUfrag = this._extractSdpUfrag(conn.remoteDescription?.sdp || "");
    await this._flushQueuedRemoteCandidates(userId);

    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);

    this.socket.emit("voice-answer", {
      code: this.currentChannel,
      targetUserId: userId,
      answer: answer,
      negotiationId,
    });
  }

  _nextNegotiationId(userId) {
    this._negotiationSeq += 1;
    return `${userId}:${Date.now()}:${this._negotiationSeq}`;
  }

  _extractSdpUfrag(sdp) {
    if (!sdp) return null;
    const match = /a=ice-ufrag:([^\r\n]+)/.exec(sdp);
    return match ? match[1].trim() : null;
  }

  _extractCandidateUfrag(candidateLine) {
    if (!candidateLine) return null;
    const match = /\bufrag\s+([^\s]+)/.exec(candidateLine);
    return match ? match[1].trim() : null;
  }

  async _flushQueuedRemoteCandidates(userId) {
    const peer = this.peers.get(userId);
    if (!peer || !peer._pendingRemoteCandidates || peer._pendingRemoteCandidates.length === 0) return;
    const conn = peer.connection;
    if (!conn.remoteDescription) return;

    const queued = peer._pendingRemoteCandidates;
    peer._pendingRemoteCandidates = [];

    for (const c of queued) {
      const candidateUfrag = c.usernameFragment || this._extractCandidateUfrag(c.candidate || "");
      if (candidateUfrag && peer._remoteUfrag && candidateUfrag !== peer._remoteUfrag) {
        continue;
      }
      try {
        await conn.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        const msg = String(err && (err.message || err));
        if (msg.includes("Unknown ufrag")) continue;
      }
    }
  }

  async _requestRemoteScreenRenegotiation(userId, attempt = 0) {
    const retryKey = `request-screen:${userId}`;
    const peer = this.peers.get(userId);
    const conn = peer?.connection;

    if (!this.inVoice || !this.screenSharers.has(userId)) {
      this._clearLateRenegotiationRetry(retryKey);
      return;
    }

    if (!conn || conn.signalingState !== "stable") {
      if (attempt >= 12) {
        this._clearLateRenegotiationRetry(retryKey);
        return;
      }
      this._scheduleLateRenegotiationRetry("request-screen", userId, attempt + 1);
      return;
    }

    this._clearLateRenegotiationRetry(retryKey);

    const hasVideoTransceiver = conn.getTransceivers().some((transceiver) => {
      return transceiver.sender?.track?.kind === "video" || transceiver.receiver?.track?.kind === "video";
    });

    if (!hasVideoTransceiver) {
      try {
        conn.addTransceiver("video", { direction: "recvonly" });
        console.log("[Voice] request-screen: added recvonly video transceiver", { userId });
      } catch (err) {
        console.warn("[Voice] request-screen: could not add recvonly transceiver", {
          userId,
          error: String(err && (err.message || err)),
        });
      }
    }

    await this._renegotiate(userId, conn);
  }

  async _renegotiateStreamForLateJoiner(type, userId, attempt = 0) {
    const retryKey = `${type}:${userId}`;
    const peer = this.peers.get(userId);
    const conn = peer?.connection;

    const hasRequiredLocalStream = type === "screen" ? this.screenStream && this.isScreenSharing : this.webcamStream && this.isWebcamActive;
    if (!hasRequiredLocalStream || !this.inVoice) {
      this._clearLateRenegotiationRetry(retryKey);
      return;
    }

    console.log(`[Voice] _renegotiateStreamForLateJoiner attempt=${attempt}`, {
      type,
      userId,
      signalingState: conn?.signalingState,
      hasPeer: !!peer,
    });

    // New joiners may not have a peer yet (or signaling may still be mid-offer/answer).
    // Retry a few times instead of dropping the renegotiation request.
    if (!conn || conn.signalingState !== "stable") {
      if (attempt >= 12) {
        console.warn("[Voice] _renegotiateStreamForLateJoiner: gave up after 12 attempts", { type, userId, signalingState: conn?.signalingState });
        this._clearLateRenegotiationRetry(retryKey);
        return;
      }
      this._scheduleLateRenegotiationRetry(type, userId, attempt + 1);
      return;
    }

    this._clearLateRenegotiationRetry(retryKey);

    if (type === "screen") {
      const senders = conn.getSenders();
      const screenTrackSet = new Set(this.screenStream.getTracks().filter((t) => t.readyState === "live"));
      for (const track of screenTrackSet) {
        track.enabled = true;
        if (track.kind === "video" && typeof track.contentHint === "string") {
          track.contentHint = "detail";
        }
        const alreadySent = senders.some((s) => s.track === track);
        if (!alreadySent) conn.addTrack(track, this.screenStream);
      }
      this._preferHardwareAcceleration(conn);
      const res = this.screenResolution;
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      this._applyScreenBitrate(conn, maxBitrate);
    } else {
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      if (!webcamTrack) return;
      const senders = conn.getSenders();
      const alreadySent = senders.some((s) => s.track === webcamTrack);
      if (!alreadySent) conn.addTrack(webcamTrack, this.webcamStream);
      this._preferHardwareAcceleration(conn);
    }

    const sent = await this._renegotiate(userId, conn);
    if (!sent && attempt < 12) {
      this._scheduleLateRenegotiationRetry(type, userId, attempt + 1);
    }
  }

  _scheduleLateRenegotiationRetry(type, userId, attempt) {
    const retryKey = `${type}:${userId}`;
    this._clearLateRenegotiationRetry(retryKey);
    const timer = setTimeout(() => {
      this._lateRenegotiationTimers.delete(retryKey);
      if (type === "request-screen") {
        this._requestRemoteScreenRenegotiation(userId, attempt).catch(() => {});
      } else {
        this._renegotiateStreamForLateJoiner(type, userId, attempt).catch(() => {});
      }
    }, 500);
    this._lateRenegotiationTimers.set(retryKey, timer);
  }

  _clearLateRenegotiationRetry(retryKey) {
    const timer = this._lateRenegotiationTimers.get(retryKey);
    if (timer) {
      clearTimeout(timer);
      this._lateRenegotiationTimers.delete(retryKey);
    }
  }

  // ── Private: Peer connection management ─────────────────

  async _createPeer(userId, username, createOffer) {
    const existingPeer = this.peers.get(userId);
    if (existingPeer) {
      existingPeer.username = username || existingPeer.username;
      if (createOffer && !existingPeer._initialOfferSent) {
        try {
          const sent = await this._emitLocalOffer(userId, existingPeer.connection, { iceRestart: false });
          if (sent) existingPeer._initialOfferSent = true;
        } catch (err) {
          console.error("Error creating voice offer:", err);
        }
      }
      return;
    }

    const connection = new RTCPeerConnection(this.rtcConfig);

    // Add our local audio tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        connection.addTrack(track, this.localStream);
      });
    }

    // Apply audio bitrate cap if configured
    if (this.audioBitrate > 0) {
      this._applyAudioBitrate(connection);
    }

    // If we're screen sharing, add those tracks too
    if (this.screenStream && this.isScreenSharing) {
      this.screenStream
        .getTracks()
        .filter((t) => t.readyState === "live")
        .forEach((track) => {
          connection.addTrack(track, this.screenStream);
        });
      // Cap bitrate for this new peer
      const res = this.screenResolution;
      const maxBitrate = this._screenBitrates[res] || this._screenBitrates[0];
      this._applyScreenBitrate(connection, maxBitrate);
    }

    // If our webcam is active, add the webcam video track
    if (this.webcamStream && this.isWebcamActive) {
      const camTrack = this.webcamStream.getVideoTracks()[0];
      if (camTrack) {
        connection.addTrack(camTrack, this.webcamStream);
      }
    }

    // Handle incoming remote tracks — route audio and video separately
    const remoteAudioStream = new MediaStream();
    const knownScreenStreamIds = new Set();
    let voiceStreamId = null;
    const deferredAudio = []; // audio tracks that arrived before their video

    connection.ontrack = (event) => {
      const track = event.track;
      const sourceStream = event.streams?.[0];
      if (track.kind === "video") {
        // Distinguish webcam from screen share:
        // - displaySurface is only set on getDisplayMedia tracks
        // - also check our signaling state (webcamUsers vs screenSharers)
        const settings = track.getSettings ? track.getSettings() : {};
        const isScreenTrack = !!settings.displaySurface || this.screenSharers.has(userId);
        const isWebcamTrack = !settings.displaySurface && this.webcamUsers.has(userId);
        console.log("[Voice] ontrack video", {
          userId,
          readyState: track.readyState,
          muted: track.muted,
          isScreenTrack,
          isWebcamTrack,
          inScreenSharers: this.screenSharers.has(userId),
          inWebcamUsers: this.webcamUsers.has(userId),
          hasSourceStream: !!sourceStream,
        });

        if (isWebcamTrack && !isScreenTrack) {
          // Route to webcam callback
          const camStream = sourceStream || new MediaStream([track]);
          if (this.onWebcamStream) this.onWebcamStream(userId, camStream);
          track.onunmute = () => {
            setTimeout(() => {
              const freshStream = new MediaStream([track]);
              if (this.onWebcamStream) this.onWebcamStream(userId, freshStream);
            }, 150);
          };
          track.onended = () => {
            if (this.onWebcamStream) this.onWebcamStream(userId, null);
          };
        } else {
          // Screen share video
          if (sourceStream) knownScreenStreamIds.add(sourceStream.id);
          const videoStream = sourceStream || new MediaStream([track]);
          console.log("[Voice] routing to onScreenStream", {
            userId,
            hasCallback: !!this.onScreenStream,
            streamActive: videoStream.active,
            trackCount: videoStream.getTracks().length,
          });
          if (this.onScreenStream) this.onScreenStream(userId, videoStream);
          track.onunmute = () => {
            console.log("[Voice] screen track onunmute", { userId, readyState: track.readyState });
            setTimeout(() => {
              const freshStream = new MediaStream([track]);
              if (this.onScreenStream) this.onScreenStream(userId, freshStream);
            }, 150);
          };
          track.onmute = () => {
            console.log("[Voice] screen track muted again", { userId, readyState: track.readyState });
          };
          track.onended = () => {
            if (this.onScreenStream) this.onScreenStream(userId, null);
          };
          // Check if any deferred audio belongs to this screen stream
          for (let i = deferredAudio.length - 1; i >= 0; i--) {
            const d = deferredAudio[i];
            if (d.sourceStream && knownScreenStreamIds.has(d.sourceStream.id)) {
              deferredAudio.splice(i, 1);
              this._playScreenAudio(userId, d.sourceStream);
            }
          }
        }
      } else {
        // Is this audio from a screen share stream?
        const isScreenAudio =
          sourceStream &&
          (knownScreenStreamIds.has(sourceStream.id) ||
            sourceStream.getVideoTracks().length > 0 ||
            (voiceStreamId && sourceStream.id !== voiceStreamId));
        if (isScreenAudio) {
          this._playScreenAudio(userId, sourceStream);
        } else if (!voiceStreamId && sourceStream) {
          // First audio — assume voice, but defer re-check in case it's actually screen audio
          voiceStreamId = sourceStream.id;
          remoteAudioStream.addTrack(track);
          this._playAudio(userId, remoteAudioStream);
        } else {
          remoteAudioStream.addTrack(track);
          this._playAudio(userId, remoteAudioStream);
        }
      }
    };

    // Send ICE candidates to the remote peer via server
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("voice-ice-candidate", {
          code: this.currentChannel,
          targetUserId: userId,
          candidate: event.candidate,
        });
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "failed") {
        // Try ICE restart before giving up
        this._restartIce(userId, connection);
      } else if (state === "disconnected") {
        // 'disconnected' is often transient during renegotiation (e.g. after
        // screen-share stops). Give the connection time to recover before
        // tearing it down — Chrome frequently goes disconnected→connected.
        if (!this._disconnectTimers) this._disconnectTimers = {};
        if (this._disconnectTimers[userId]) clearTimeout(this._disconnectTimers[userId]);
        this._disconnectTimers[userId] = setTimeout(() => {
          if (connection.connectionState === "disconnected" || connection.connectionState === "failed") {
            this._restartIce(userId, connection);
          }
          delete this._disconnectTimers[userId];
        }, 8000);
      } else if (state === "connected") {
        // Clear any pending disconnect timer — connection recovered
        if (this._disconnectTimers?.[userId]) {
          clearTimeout(this._disconnectTimers[userId]);
          delete this._disconnectTimers[userId];
        }
      }
    };

    this.peers.set(userId, {
      connection,
      stream: remoteAudioStream,
      username,
      _pendingLocalOfferId: null,
      _pendingRemoteCandidates: [],
      _remoteUfrag: null,
      _initialOfferSent: false,
      _lastHandledIncomingOfferId: null,
      _incomingOfferInFlightId: null,
    });

    const createdPeer = this.peers.get(userId);
    const orphanCandidates = this._orphanRemoteCandidates.get(userId);
    if (createdPeer && orphanCandidates && orphanCandidates.length > 0) {
      createdPeer._pendingRemoteCandidates.push(...orphanCandidates);
      this._orphanRemoteCandidates.delete(userId);
    }

    // If we're the initiator, create and send an offer
    if (createOffer) {
      try {
        const sent = await this._emitLocalOffer(userId, connection, { iceRestart: false });
        const currentPeer = this.peers.get(userId);
        if (currentPeer && sent) currentPeer._initialOfferSent = true;
      } catch (err) {
        console.error("Error creating voice offer:", err);
      }
    }
  }

  _removePeer(userId) {
    const peer = this.peers.get(userId);
    if (peer) {
      peer.connection.close();
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.remove();
      const screenAudioEl = document.getElementById(`voice-audio-screen-${userId}`);
      if (screenAudioEl) screenAudioEl.remove();
      this.screenGainNodes.delete(userId);
      this.gainNodes.delete(userId);
      this.peers.delete(userId);
    }
  }

  async _restartIce(userId, connection) {
    try {
      await this._emitLocalOffer(userId, connection, { iceRestart: true });
    } catch (err) {
      console.error("ICE restart failed for", userId, "— removing peer:", err);
      this._removePeer(userId);
    }
  }

  // ── Volume Control ──────────────────────────────────────

  setVolume(userId, volume) {
    const gainNode = this.gainNodes.get(userId);
    if (gainNode) {
      // Web Audio GainNode supports values > 1.0 for boost
      gainNode.gain.value = Math.max(0, Math.min(2, volume));
    } else {
      // Fallback: HTMLAudioElement volume (capped at 1.0, no boost)
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.volume = Math.max(0, Math.min(1, volume));
    }
  }

  // ── Per-user Deafen (stop sending our audio to a specific peer) ──

  deafenUser(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.deafenedUsers.add(userId);

    // Replace our audio track with a silent one for this peer
    const senders = peer.connection.getSenders();
    const audioSender = senders.find(
      (s) => s.track && s.track.kind === "audio" && (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)),
    );
    if (audioSender) {
      // Create a silent audio track
      const silentTrack = this._createSilentAudioTrack();
      // Store original track for restore
      peer._originalAudioTrack = audioSender.track;
      audioSender.replaceTrack(silentTrack).catch(() => {});
    }
  }

  undeafenUser(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.deafenedUsers.delete(userId);

    // Restore the original audio track
    if (peer._originalAudioTrack) {
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(
        (s) => s.track && s.track.kind === "audio" && (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)),
      );
      if (audioSender) {
        audioSender.replaceTrack(peer._originalAudioTrack).catch(() => {});
      }
      peer._originalAudioTrack = null;
    }
  }

  isUserDeafened(userId) {
    return this.deafenedUsers.has(userId);
  }

  _createSilentAudioTrack() {
    // Reuse cached silent track to avoid creating new AudioContext/oscillator on every deafen
    if (this._cachedSilentTrack && this._cachedSilentTrack.readyState === "live") {
      return this._cachedSilentTrack;
    }
    const ctx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (!this.audioCtx) this.audioCtx = ctx; // save for reuse
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // completely silent
    oscillator.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    oscillator.start();
    this._cachedSilentTrack = dest.stream.getAudioTracks()[0];
    return this._cachedSilentTrack;
  }

  _getSavedVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem("haven_voice_volumes") || "{}");
      return (vols[userId] ?? 100) / 100;
    } catch {
      return 1;
    }
  }

  // ── Live Device Switching ────────────────────────────────

  /**
   * Switch the active microphone (input device) while in a voice call.
   * Re-acquires getUserMedia with the new deviceId, rebuilds the noise-gate
   * chain, and replaces the audio track on every peer connection.
   * @param {string} deviceId - MediaDeviceInfo.deviceId (empty = system default)
   */
  async switchInputDevice(deviceId) {
    if (!this.inVoice) return;

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    let newRawStream;
    try {
      newRawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    } catch (err) {
      console.error("[Voice] Failed to switch input device:", err);
      return;
    }

    // Stop old raw tracks
    if (this.rawStream) {
      this.rawStream.getTracks().forEach((t) => t.stop());
    }
    this.rawStream = newRawStream;

    // Rebuild noise gate chain
    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();

    const source = this.audioCtx.createMediaStreamSource(this.rawStream);
    this._rnnoiseSource = source;
    const gateAnalyser = this.audioCtx.createAnalyser();
    gateAnalyser.fftSize = 2048;
    gateAnalyser.smoothingTimeConstant = 0.3;
    source.connect(gateAnalyser);

    const gateGain = this.audioCtx.createGain();
    source.connect(gateGain);

    const dest = this.audioCtx.createMediaStreamDestination();
    gateGain.connect(dest);

    this._noiseGateAnalyser = gateAnalyser;
    this._noiseGateGain = gateGain;

    const oldLocalStream = this.localStream;
    this.localStream = dest.stream;
    this._startNoiseGate();
    this._startLocalTalkDetection();

    // Re-enable RNNoise if it was active
    if (this.noiseMode === "suppress" && this._rnnoiseReady) {
      this.setNoiseSensitivity(0);
      this._enableRNNoise();
    } else if (this.noiseMode === "gate") {
      const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
      this.setNoiseSensitivity(saved);
    } else if (this.noiseMode === "off") {
      this.setNoiseSensitivity(0);
    }

    // Replace the audio track on every peer connection
    const newTrack = this.localStream.getAudioTracks()[0];
    for (const [, peer] of this.peers) {
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(
        (s) => s.track && s.track.kind === "audio" && (!this.screenStream || !this.screenStream.getAudioTracks().includes(s.track)),
      );
      if (audioSender) {
        await audioSender.replaceTrack(newTrack).catch((e) => console.warn("[Voice] replaceTrack failed for peer:", e));
      }
    }

    // Re-apply mute state
    if (this.isMuted) {
      this.rawStream.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
      this.localStream.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
    }

    // Clean up old local stream
    if (oldLocalStream) {
      oldLocalStream.getTracks().forEach((t) => t.stop());
    }

    // Persist preference
    localStorage.setItem("haven_input_device", deviceId || "");
    console.log(`[Voice] Input device switched: ${deviceId || "default"}`);
  }

  /**
   * Switch the output device (speaker/headphones) for all voice audio.
   * Routes through both HTMLMediaElement.setSinkId() AND AudioContext.setSinkId()
   * since voice audio is piped through Web Audio API gain nodes.
   * @param {string} deviceId - MediaDeviceInfo.deviceId (empty = system default)
   */
  async switchOutputDevice(deviceId) {
    localStorage.setItem("haven_output_device", deviceId || "");

    // 1. Switch the AudioContext output (this is where voice audio actually plays)
    if (this.audioCtx && typeof this.audioCtx.setSinkId === "function") {
      try {
        await this.audioCtx.setSinkId(deviceId || "");
        console.log(`[Voice] AudioContext sink switched: ${deviceId || "default"}`);
      } catch (e) {
        console.warn("[Voice] AudioContext.setSinkId failed:", e);
      }
    }

    // 2. Also switch any HTMLMediaElements (fallback audio, screen share, etc.)
    const elements = document.querySelectorAll("audio, video");
    for (const el of elements) {
      if (typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(deviceId || "");
        } catch (e) {
          console.warn("[Voice] setSinkId failed on element:", e);
        }
      }
    }
    console.log(`[Voice] Output device switched: ${deviceId || "default"}`);
  }

  // ── Screen Share Audio ────────────────────────────────

  _playScreenAudio(userId, stream) {
    const key = `screen-${userId}`;
    let audioEl = document.getElementById(`voice-audio-${key}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `voice-audio-${key}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.getElementById("audio-container").appendChild(audioEl);

      // Apply saved output device
      const savedOutput = localStorage.getItem("haven_output_device");
      if (savedOutput && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // If a gain node already exists but the stream changed, tear it down
    // so we rebuild the AudioContext chain for the new source.
    const existingGain = this.screenGainNodes.get(userId);
    if (existingGain) {
      try {
        existingGain.disconnect();
      } catch {}
      this.screenGainNodes.delete(userId);
    }

    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(this._getSavedStreamVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.screenGainNodes.set(userId, gainNode);
      audioEl.volume = 0;
    } catch {
      const savedVolume = Math.min(1, this._getSavedStreamVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
    }
    if (this.onScreenAudio) this.onScreenAudio(userId);
  }

  setStreamVolume(userId, volume) {
    // Map keys may be number or string depending on caller — try both
    const gainNode = this.screenGainNodes.get(userId) || this.screenGainNodes.get(String(userId)) || this.screenGainNodes.get(Number(userId));
    const clampedGain = Math.max(0, Math.min(2, volume));
    const clampedVol = Math.max(0, Math.min(1, volume));
    if (gainNode) {
      gainNode.gain.value = clampedGain;
    }
    // Always sync the underlying <audio> element too (belt-and-suspenders)
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (audioEl) audioEl.volume = clampedVol;
  }

  _getSavedStreamVolume(userId) {
    try {
      const vols = JSON.parse(localStorage.getItem("haven_stream_volumes") || "{}");
      return (vols[userId] ?? 100) / 100;
    } catch {
      return 1;
    }
  }

  // ── Noise Gate ───────────────────────────────────────────

  setNoiseMode(mode) {
    // mode: 'off' | 'gate' | 'suppress'
    this.noiseMode = mode;
    localStorage.setItem("haven_noise_mode", mode);

    if (mode === "suppress") {
      // Disable noise gate, enable RNNoise
      if (this.noiseSensitivity !== 0) {
        this.setNoiseSensitivity(0);
      }
      if (!this._rnnoiseReady) {
        this._initRNNoise().then(() => {
          if (this._rnnoiseReady) this._enableRNNoise();
          else console.warn("[Voice] AI suppression unavailable");
        });
      } else {
        this._enableRNNoise();
      }
    } else if (mode === "gate") {
      // Disable RNNoise, enable noise gate with saved sensitivity
      this._disableRNNoise();
      const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
      this.setNoiseSensitivity(saved);
    } else {
      // Off — disable both
      this._disableRNNoise();
      this.setNoiseSensitivity(0);
    }
  }

  async _initRNNoise() {
    if (this._rnnoiseReady || !this.audioCtx) return;
    try {
      await this.audioCtx.audioWorklet.addModule("/js/rnnoise-processor.js");
      const wasmResponse = await fetch("/js/rnnoise.wasm");
      const wasmBytes = await wasmResponse.arrayBuffer();
      const wasmModule = await WebAssembly.compile(wasmBytes);
      this._rnnoiseWasmModule = wasmModule;
      this._rnnoiseReady = true;
    } catch (err) {
      console.warn("[Voice] RNNoise init failed:", err);
      this._rnnoiseReady = false;
    }
  }

  _enableRNNoise() {
    if (!this._rnnoiseReady || !this._rnnoiseSource || this._rnnoiseNode) return;
    try {
      const node = new AudioWorkletNode(this.audioCtx, "rnnoise-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
      node.port.postMessage({
        type: "wasm-module",
        module: this._rnnoiseWasmModule,
      });
      // Re-wire: source → rnnoise → gateGain (gate is open since sensitivity=0)
      this._rnnoiseSource.disconnect(this._noiseGateGain);
      this._rnnoiseSource.connect(node);
      node.connect(this._noiseGateGain);
      this._rnnoiseNode = node;
    } catch (err) {
      console.warn("[Voice] Failed to enable RNNoise:", err);
    }
  }

  _disableRNNoise() {
    if (!this._rnnoiseNode) return;
    try {
      this._rnnoiseNode.port.postMessage({ type: "destroy" });
      this._rnnoiseNode.disconnect();
      this._rnnoiseNode = null;
      // Re-wire: source → gateGain directly
      if (this._rnnoiseSource && this._noiseGateGain) {
        this._rnnoiseSource.connect(this._noiseGateGain);
      }
    } catch (err) {
      console.warn("[Voice] Failed to disable RNNoise:", err);
    }
  }

  setNoiseSensitivity(value) {
    // value: 0 (off / gate open) → 100 (aggressive gating)
    this.noiseSensitivity = Math.max(0, Math.min(100, value));
    // Immediately open gate if set to 0
    if (this.noiseSensitivity === 0 && this._noiseGateGain) {
      this._noiseGateGain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.01);
    }
    return this.noiseSensitivity;
  }

  _startNoiseGate() {
    if (this._noiseGateInterval) return;
    const analyser = this._noiseGateAnalyser;
    const gain = this._noiseGateGain;
    if (!analyser || !gain) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const ATTACK = 0.015; // Gate opens fast (seconds, ~15ms)
    const RELEASE = 0.12; // Gate closes gently (seconds, ~120ms)
    const HOLD_MS = 250; // Keep gate open 250ms after level drops below threshold
    const OPEN_CONFIRM = 1; // Require signal above threshold for this many extra polls
    // before opening (filters transient clicks/taps, ~20ms at 20ms poll)
    let gateOpen = false;
    let holdTimeout = null;
    let aboveCount = 0; // consecutive polls above threshold

    this._noiseGateInterval = setInterval(() => {
      if (this.noiseSensitivity === 0) {
        gain.gain.value = 1;
        this.currentMicLevel = 0;
        gateOpen = false;
        aboveCount = 0;
        if (holdTimeout) {
          clearTimeout(holdTimeout);
          holdTimeout = null;
        }
        return;
      }
      // Map sensitivity 1-100 → threshold 2-40
      const threshold = 2 + (this.noiseSensitivity / 100) * 38;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;

      // Expose current level for UI meter (0-100 scale, capped)
      this.currentMicLevel = Math.min(100, (avg / 50) * 100);

      if (avg > threshold) {
        // Signal is above threshold — confirm it sustains before opening
        aboveCount++;
        if (holdTimeout) {
          clearTimeout(holdTimeout);
          holdTimeout = null;
        }
        if (!gateOpen && aboveCount > OPEN_CONFIRM) {
          gain.gain.setTargetAtTime(1, this.audioCtx.currentTime, ATTACK);
          gateOpen = true;
        }
      } else {
        aboveCount = 0;
        if (gateOpen && !holdTimeout) {
          // Signal dropped below threshold — start hold timer before closing
          holdTimeout = setTimeout(() => {
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime, RELEASE);
            gateOpen = false;
            holdTimeout = null;
          }, HOLD_MS);
        }
      }
    }, 20);
  }

  _stopNoiseGate() {
    if (this._noiseGateInterval) {
      clearInterval(this._noiseGateInterval);
      this._noiseGateInterval = null;
    }
    this._noiseGateAnalyser = null;
    this._noiseGateGain = null;
    this._rnnoiseSource = null;
    this.currentMicLevel = 0;
  }

  // ── Talking Detection ───────────────────────────────────

  _startAnalyser(userId, analyserNode, dataArray) {
    // Reuse an already-connected AnalyserNode; just start polling
    if (this.analysers.has(userId)) return; // already running

    const THRESHOLD = 20;
    let wasTalking = false;
    let holdTimer = null;
    const HOLD_MS = 300; // keep indicator lit for 300ms after speech stops

    const interval = setInterval(() => {
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const isTalking = avg > THRESHOLD;

      if (isTalking) {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        if (!wasTalking) {
          wasTalking = true;
          this.talkingState.set(userId, true);
          if (this.onTalkingChange) this.onTalkingChange(userId, true);
        }
      } else if (wasTalking && !holdTimer) {
        // Start hold timer — keep "talking" for HOLD_MS after silence
        holdTimer = setTimeout(() => {
          wasTalking = false;
          holdTimer = null;
          this.talkingState.set(userId, false);
          if (this.onTalkingChange) this.onTalkingChange(userId, false);
        }, HOLD_MS);
      }
    }, 60);

    this.analysers.set(userId, { analyser: analyserNode, dataArray, interval });
  }

  _stopAnalyser(userId) {
    const a = this.analysers.get(userId);
    if (a) {
      clearInterval(a.interval);
      this.analysers.delete(userId);
      this.talkingState.delete(userId);
      if (this.onTalkingChange) this.onTalkingChange(userId, false);
    }
  }

  _startLocalTalkDetection() {
    if (!this.rawStream || this._localTalkInterval) return;
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === "suspended") this.audioCtx.resume();

      const source = this.audioCtx.createMediaStreamSource(this.rawStream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const THRESHOLD = 15; // Slightly higher than noise gate to avoid flickering
      let wasTalking = false;
      let holdTimer = null;
      const HOLD_MS = 300;

      this._localTalkAnalyser = { analyser, source };
      this._localTalkInterval = setInterval(() => {
        if (this.isMuted) {
          if (wasTalking) {
            wasTalking = false;
            if (holdTimer) {
              clearTimeout(holdTimer);
              holdTimer = null;
            }
            if (this.socket && this.inVoice) this.socket.emit("voice-speaking", { speaking: false });
          }
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isTalking = avg > THRESHOLD;

        if (isTalking) {
          if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
          }
          if (!wasTalking) {
            wasTalking = true;
            if (this.socket && this.inVoice) this.socket.emit("voice-speaking", { speaking: true });
          }
          // Notify server of voice activity for AFK tracking (throttled to once per 15s)
          if (this.socket && this.inVoice && (!this._lastVoiceSpeakPing || Date.now() - this._lastVoiceSpeakPing > 15000)) {
            this._lastVoiceSpeakPing = Date.now();
            this.socket.emit("voice-activity");
          }
        } else if (wasTalking && !holdTimer) {
          holdTimer = setTimeout(() => {
            wasTalking = false;
            holdTimer = null;
            if (this.socket && this.inVoice) this.socket.emit("voice-speaking", { speaking: false });
          }, HOLD_MS);
        }
      }, 60);
    } catch {
      /* analyser not available */
    }
  }

  _stopLocalTalkDetection() {
    if (this._localTalkInterval) {
      clearInterval(this._localTalkInterval);
      this._localTalkInterval = null;
      this._localTalkAnalyser = null;
      if (this.socket && this.inVoice) this.socket.emit("voice-speaking", { speaking: false });
      if (this.onTalkingChange) this.onTalkingChange("self", false);
    }
  }

  _playAudio(userId, stream) {
    let audioEl = document.getElementById(`voice-audio-${userId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `voice-audio-${userId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.getElementById("audio-container").appendChild(audioEl);

      // Apply saved output device
      const savedOutput = localStorage.getItem("haven_output_device");
      if (savedOutput && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // Only set up the Web Audio graph once per user.
    // ontrack fires per-track, so _playAudio can be called several times
    // for the same user when tracks are added (mic + screen audio).
    if (this.gainNodes.has(userId)) {
      audioEl.volume = 0;
      return;
    }

    // Route through Web Audio API for volume boost AND talking analysis
    // CRITICAL: use ONE MediaStreamSource for both analyser & gain to avoid
    // browsers muting the stream when multiple sources compete.
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === "suspended") this.audioCtx.resume();

      const source = this.audioCtx.createMediaStreamSource(stream);

      // Analyser branch (tee off from source)
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      this._startAnalyser(userId, analyser, dataArray);

      // Gain branch (source → gain → destination)
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(this._getSavedVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.gainNodes.set(userId, gainNode);

      // Mute element playback — audio routes through GainNode instead
      audioEl.volume = 0;
    } catch {
      // Fallback: use element volume directly (no boost beyond 100%)
      const savedVolume = Math.min(1, this._getSavedVolume(userId));
      if (this.isDeafened) {
        audioEl.dataset.prevVolume = String(savedVolume);
        audioEl.volume = 0;
      } else {
        audioEl.volume = savedVolume;
      }
    }
  }
}
