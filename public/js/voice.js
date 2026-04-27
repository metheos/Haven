// ═══════════════════════════════════════════════════════════
// Haven — LiveKit Voice Chat Manager
// ═══════════════════════════════════════════════════════════

class VoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.livekit = window.LivekitClient || null;
    this.room = null;
    this.localStream = null;
    this.rawStream = null;
    this.screenStream = null;
    this.webcamStream = null;
    this.isScreenSharing = false;
    this.isWebcamActive = false;
    this.peers = new Map();
    this.currentChannel = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.inVoice = false;
    this.noiseSensitivity = 10;
    this.currentMicLevel = 0;
    this.audioCtx = null;
    this.gainNodes = new Map();
    this.sourceNodes = new Map();
    this.screenSourceNodes = new Map();
    this.localUserId = null;
    this.onScreenStream = null;
    this.onWebcamStream = null;
    this.onVoiceJoin = null;
    this.onVoiceLeave = null;
    this.onTalkingChange = null;
    this.screenSharers = new Set();
    this.webcamUsers = new Set();
    this.screenGainNodes = new Map();
    this.onScreenAudio = null;
    this.onScreenNoAudio = null;
    this.onScreenShareStarted = null;
    this.onWebcamStatusChange = null;
    this.deafenedUsers = new Set();
    this.talkingState = new Map();
    this.audioBitrate = 0;
    this.screenHasAudio = false;
    this._localTalkInterval = null;
    this._noiseGateInterval = null;
    this._noiseGateGain = null;
    this._noiseGateAnalyser = null;
    this._vcDest = null;
    this._rnnoiseNode = null;
    this._rnnoiseReady = false;
    this._rnnoiseSource = null;
    this._rnnoiseWasmModule = null;
    this._cachedSilentTrack = null;
    this._lastVoiceSpeakPing = 0;
    this._roomDisconnectExpected = false;
    this._localTrackState = {
      microphone: null,
      webcam: null,
      screenVideo: null,
      screenAudio: null,
    };

    const savedMode = localStorage.getItem("haven_noise_mode");
    this.noiseMode = savedMode || "gate";

    const savedRes = localStorage.getItem("haven_screen_res");
    this.screenResolution = savedRes !== null ? parseInt(savedRes, 10) : 1080;
    this.screenFrameRate = parseInt(localStorage.getItem("haven_screen_fps") || "30", 10) || 30;

    this._setupSocketListeners();
  }

  _setupSocketListeners() {
    this.socket.on("voice-existing-users", (data) => {
      this.audioBitrate = data.voiceBitrate || 0;
      for (const user of data.users || []) {
        this.peers.set(user.id, { username: user.username });
      }
    });

    this.socket.on("voice-user-joined", (data) => {
      if (!data?.user) return;
      this.peers.set(data.user.id, { username: data.user.username });
      if (this.onVoiceJoin) this.onVoiceJoin(data.user.id, data.user.username);
    });

    this.socket.on("voice-speaking", (data) => {
      if (!data || data.userId == null) return;
      const uid = data.userId === this.localUserId ? "self" : data.userId;
      this.talkingState.set(uid, !!data.speaking);
      if (this.onTalkingChange) this.onTalkingChange(uid, !!data.speaking);
    });

    this.socket.on("voice-user-left", (data) => {
      if (!data?.user) return;
      if (this.onVoiceLeave) this.onVoiceLeave(data.user.id, data.user.username);
      this._cleanupRemoteParticipant(data.user.id, false);
      this.peers.delete(data.user.id);
    });

    this.socket.on("voice-bitrate-updated", (data) => {
      if (data && data.code === this.currentChannel) {
        this.audioBitrate = data.bitrate || 0;
      }
    });

    this.socket.on("voice-afk-move", (data) => {
      if (!data?.channelCode) return;
      this.leave();
      if (this.onAfkMove) this.onAfkMove(data.channelCode);
    });

    this.socket.on("voice-kicked", (data) => {
      if (!data?.channelCode) return;
      if (this.currentChannel !== data.channelCode) return;
      this.leave();
      if (this.onVoiceKicked) this.onVoiceKicked(data.channelCode, data.reason);
    });

    this.socket.on("screen-share-started", (data) => {
      if (!data?.userId) return;
      this.screenSharers.add(data.userId);
      this.peers.set(data.userId, { username: data.username || this.peers.get(data.userId)?.username || "Unknown" });
      if (this.onScreenShareStarted) this.onScreenShareStarted(data.userId, data.username);
      if (!data.hasAudio && this.onScreenNoAudio) this.onScreenNoAudio(data.userId);
    });

    this.socket.on("screen-share-stopped", (data) => {
      if (!data?.userId) return;
      this.screenSharers.delete(data.userId);
      this._clearScreenMedia(data.userId);
    });

    this.socket.on("webcam-started", (data) => {
      if (!data?.userId) return;
      this.webcamUsers.add(data.userId);
      this.peers.set(data.userId, { username: data.username || this.peers.get(data.userId)?.username || "Unknown" });
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    this.socket.on("webcam-stopped", (data) => {
      if (!data?.userId) return;
      this.webcamUsers.delete(data.userId);
      this._clearWebcamMedia(data.userId);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });

    this.socket.on("active-screen-sharers", (data) => {
      if (!data?.sharers) return;
      data.sharers.forEach((sharer) => {
        this.screenSharers.add(sharer.id);
        this.peers.set(sharer.id, { username: sharer.username });
      });
    });

    this.socket.on("active-webcam-users", (data) => {
      if (!data?.users) return;
      data.users.forEach((user) => {
        this.webcamUsers.add(user.id);
        this.peers.set(user.id, { username: user.username });
      });
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
    });
  }

  async join(channelCode) {
    try {
      if (!this.livekit) {
        console.error("LiveKit client SDK is not loaded");
        return false;
      }

      const preservedMuteState = this.isMuted;
      const preservedDeafenState = this.isDeafened;

      if (this.inVoice) this.leave();

      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();

      const savedInputId = localStorage.getItem("haven_input_device") || "";
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (savedInputId) audioConstraints.deviceId = { exact: savedInputId };

      try {
        this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (deviceErr) {
        if (!savedInputId) throw deviceErr;
        localStorage.removeItem("haven_input_device");
        delete audioConstraints.deviceId;
        this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      }

      if (window.havenDesktop?.audio?.optOutOfDucking) {
        setTimeout(() => window.havenDesktop.audio.optOutOfDucking().catch(() => {}), 500);
      }

      this._buildProcessedMicrophoneStream();

      await this._initRNNoise();
      if (this.noiseMode === "suppress" && this._rnnoiseReady) {
        this.setNoiseSensitivity(0);
        this._enableRNNoise();
      } else if (this.noiseMode === "off") {
        this.setNoiseSensitivity(0);
      } else {
        const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
        this.setNoiseSensitivity(saved);
      }

      const tokenData = await this._fetchLiveKitToken(channelCode);
      this.room = this._createRoom();
      this._roomDisconnectExpected = false;
      await this.room.connect(tokenData.url, tokenData.token);

      // Bootstrap: process tracks from participants already in the room.
      // TrackSubscribed fires during connect but can be missed in timing races
      // when the room already has many participants.
      for (const [, participant] of this.room.remoteParticipants) {
        this._rememberParticipant(participant);
        for (const [, publication] of participant.trackPublications) {
          if (publication.isSubscribed && publication.track) {
            this._handleTrackSubscribed(publication.track, publication, participant);
          }
        }
      }

      this.currentChannel = channelCode;
      this.inVoice = true;
      this.isMuted = preservedMuteState;
      this.isDeafened = preservedDeafenState;

      await this._publishMicrophoneTrack();
      this._applyMuteStateToLocalTracks();
      this._applyGlobalDeafenState();

      if (!this.room.canPlaybackAudio) {
        this.room.startAudio().catch(() => {});
      }

      this.socket.emit("voice-join", { code: channelCode });
      this._startLocalTalkDetection();

      try {
        localStorage.setItem("haven_voice_channel", channelCode);
      } catch {}

      return true;
    } catch (err) {
      console.error("Voice join failed:", err);
      this._cleanupLocalMediaOnly();
      return false;
    }
  }

  leave() {
    if (this.isScreenSharing) this.stopScreenShare().catch(() => {});
    if (this.isWebcamActive) this.stopWebcam().catch(() => {});

    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();

    const leavingChannel = this.currentChannel;
    if (leavingChannel) {
      let acked = false;
      this.socket.emit("voice-leave", { code: leavingChannel }, () => {
        acked = true;
      });
      setTimeout(() => {
        if (!acked && this.socket.connected) {
          this.socket.emit("voice-leave", { code: leavingChannel });
        }
      }, 2000);
    }

    this._disconnectRoom();
    this._cleanupLocalMediaOnly();

    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.audioBitrate = 0;
    this.screenSharers.clear();
    this.webcamUsers.clear();
    this.peers.clear();
    this.talkingState.clear();
    this._vcDest = null;

    try {
      localStorage.removeItem("haven_voice_channel");
    } catch {}
  }

  _softLeave() {
    if (!this.inVoice) return;
    this._disconnectRoom();
    this._cleanupLocalMediaOnly();
    this.currentChannel = null;
    this.inVoice = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.audioBitrate = 0;
    this.screenSharers.clear();
    this.webcamUsers.clear();
    this.peers.clear();
    this.talkingState.clear();
    this._vcDest = null;
  }

  playSoundToVC(url, localVolume = 0.5) {
    if (!this.inVoice || !this.audioCtx || !this._vcDest) return false;
    fetch(url)
      .then((response) => response.arrayBuffer())
      .then((buffer) => this.audioCtx.decodeAudioData(buffer))
      .then((audioBuffer) => {
        const bufferSource = this.audioCtx.createBufferSource();
        bufferSource.buffer = audioBuffer;

        const vcGain = this.audioCtx.createGain();
        vcGain.gain.value = 0.7;
        bufferSource.connect(vcGain);
        vcGain.connect(this._vcDest);

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
    this._applyGlobalDeafenState();
    return this.isDeafened;
  }

  _applyGlobalDeafenState() {
    for (const [userId, gainNode] of this.gainNodes) {
      gainNode.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedVolume(userId));
    }
    for (const [userId, gainNode] of this.screenGainNodes) {
      gainNode.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedStreamVolume(userId));
    }
    document.querySelectorAll("#audio-container audio").forEach((el) => {
      if (this.isDeafened) {
        el.dataset.prevVolume = el.dataset.prevVolume || String(el.volume);
        el.volume = 0;
        return;
      }
      if (el.id.startsWith("voice-audio-screen-")) {
        const userId = el.id.replace("voice-audio-screen-", "");
        el.volume = this._getAppliedIncomingVolume(userId, parseFloat(el.dataset.prevVolume || 1));
        return;
      }
      if (el.id.startsWith("voice-audio-")) {
        const userId = el.id.replace("voice-audio-", "");
        el.volume = this._getAppliedIncomingVolume(userId, parseFloat(el.dataset.prevVolume || 1));
      }
    });
  }

  _getAppliedIncomingVolume(userId, volume) {
    return this.isDeafened || this.deafenedUsers.has(userId) || this.deafenedUsers.has(String(userId)) ? 0 : volume;
  }

  async shareScreen() {
    if (!this.inVoice || this.isScreenSharing || !this.room) return false;
    try {
      const videoConstraints = { cursor: "always" };
      const res = this.screenResolution;
      const fps = this.screenFrameRate;

      if (res && res !== 0) {
        const widths = { 720: 1280, 1080: 1920, 1440: 2560 };
        videoConstraints.width = { ideal: widths[res] || 1920 };
        videoConstraints.height = { ideal: res };
      }
      videoConstraints.frameRate = { ideal: fps };

      const displayMediaOptions = {
        video: videoConstraints,
        audio: true,
      };

      const isElectron = !!(window.havenDesktop || navigator.userAgent.includes("Electron"));
      if (!isElectron) {
        displayMediaOptions.surfaceSwitching = "exclude";
        displayMediaOptions.selfBrowserSurface = "include";
        displayMediaOptions.monitorTypeSurfaces = "include";
      }

      this.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      this.isScreenSharing = true;
      this.screenSharers.add(this.localUserId);

      const videoTrack = this.screenStream.getVideoTracks()[0] || null;
      const audioTrack = this.screenStream.getAudioTracks()[0] || null;
      this.screenHasAudio = !!audioTrack;

      if (videoTrack) {
        videoTrack.onended = () => {
          this.stopScreenShare().catch(() => {});
        };
        await this.room.localParticipant.publishTrack(videoTrack, {
          source: this.livekit.Track.Source.ScreenShare,
          name: "screen",
        });
        this._localTrackState.screenVideo = videoTrack;
      }

      if (audioTrack) {
        audioTrack.onended = () => {
          this.screenHasAudio = false;
        };
        const screenAudioSource = this._getScreenAudioSource();
        await this.room.localParticipant.publishTrack(audioTrack, {
          source: screenAudioSource,
          name: "screen-audio",
        });
        this._localTrackState.screenAudio = audioTrack;
      }

      this.socket.emit("screen-share-started", { code: this.currentChannel, hasAudio: !!audioTrack });
      return true;
    } catch (err) {
      console.error("Screen share failed:", err);
      this.isScreenSharing = false;
      this.screenStream = null;
      this.screenHasAudio = false;
      return false;
    }
  }

  async stopScreenShare() {
    if (!this.isScreenSharing) return;

    const screenVideo = this._localTrackState.screenVideo;
    const screenAudio = this._localTrackState.screenAudio;
    if (this.room?.localParticipant) {
      if (screenVideo) {
        try {
          await this.room.localParticipant.unpublishTrack(screenVideo);
        } catch {}
      }
      if (screenAudio) {
        try {
          await this.room.localParticipant.unpublishTrack(screenAudio);
        } catch {}
      }
    }

    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
    }

    this.screenStream = null;
    this.isScreenSharing = false;
    this.screenHasAudio = false;
    this.screenSharers.delete(this.localUserId);
    this._localTrackState.screenVideo = null;
    this._localTrackState.screenAudio = null;

    if (this.currentChannel) this.socket.emit("screen-share-stopped", { code: this.currentChannel });
    if (this.onScreenStream) this.onScreenStream(this.localUserId, null);
  }

  async startWebcam() {
    if (!this.inVoice || this.isWebcamActive || !this.room) return false;
    try {
      const savedCamId = localStorage.getItem("haven_cam_device") || "";
      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      };
      if (savedCamId) videoConstraints.deviceId = { exact: savedCamId };

      this.webcamStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      const camTrack = this.webcamStream.getVideoTracks()[0] || null;
      if (!camTrack) return false;

      camTrack.onended = () => {
        this.stopWebcam().catch(() => {});
      };
      await this.room.localParticipant.publishTrack(camTrack, {
        source: this.livekit.Track.Source.Camera,
        name: "camera",
      });

      this._localTrackState.webcam = camTrack;
      this.isWebcamActive = true;
      this.webcamUsers.add(this.localUserId);
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
    if (!this.isWebcamActive) return;

    const webcamTrack = this._localTrackState.webcam;
    if (this.room?.localParticipant && webcamTrack) {
      try {
        await this.room.localParticipant.unpublishTrack(webcamTrack);
      } catch {}
    }

    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((track) => track.stop());
    }

    this.webcamStream = null;
    this.isWebcamActive = false;
    this.webcamUsers.delete(this.localUserId);
    this._localTrackState.webcam = null;

    if (this.currentChannel) this.socket.emit("webcam-stopped", { code: this.currentChannel });
    if (this.onWebcamStream) this.onWebcamStream(this.localUserId, null);
  }

  async switchCamera(deviceId) {
    if (!this.isWebcamActive || !this.room?.localParticipant) return;

    const videoConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    } catch (err) {
      console.error("[Voice] Failed to switch camera:", err);
      return;
    }

    const oldTrack = this._localTrackState.webcam;
    if (oldTrack) {
      try {
        await this.room.localParticipant.unpublishTrack(oldTrack);
      } catch {}
    }
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((track) => track.stop());
    }

    this.webcamStream = newStream;
    const newTrack = newStream.getVideoTracks()[0] || null;
    if (!newTrack) return;

    newTrack.onended = () => {
      this.stopWebcam().catch(() => {});
    };
    await this.room.localParticipant.publishTrack(newTrack, {
      source: this.livekit.Track.Source.Camera,
      name: "camera",
    });
    this._localTrackState.webcam = newTrack;

    localStorage.setItem("haven_cam_device", deviceId || "");
    if (this.onWebcamStream) this.onWebcamStream(this.localUserId, this.webcamStream);
  }

  setScreenResolution(height) {
    this.screenResolution = height;
    localStorage.setItem("haven_screen_res", height);
    if (this.isScreenSharing) this._restartScreenShareForSettings();
  }

  setScreenFrameRate(fps) {
    this.screenFrameRate = fps;
    localStorage.setItem("haven_screen_fps", fps);
    if (this.isScreenSharing) this._restartScreenShareForSettings();
  }

  async _restartScreenShareForSettings() {
    if (!this.isScreenSharing) return;
    try {
      await this.stopScreenShare();
      await this.shareScreen();
    } catch (err) {
      console.warn("Failed to restart screen share after quality change:", err);
    }
  }

  setVolume(userId, volume) {
    const gainNode = this.gainNodes.get(userId) || this.gainNodes.get(String(userId)) || this.gainNodes.get(Number(userId));
    if (gainNode) {
      gainNode.gain.value = this._getAppliedIncomingVolume(userId, Math.max(0, Math.min(2, volume)));
    } else {
      const audioEl = document.getElementById(`voice-audio-${userId}`);
      if (audioEl) audioEl.volume = this._getAppliedIncomingVolume(userId, Math.max(0, Math.min(1, volume)));
    }
  }

  deafenUser(userId) {
    this.deafenedUsers.add(userId);
    this.deafenedUsers.add(String(userId));
    const gainNode = this.gainNodes.get(userId) || this.gainNodes.get(String(userId));
    if (gainNode) gainNode.gain.value = 0;
    const screenGain = this.screenGainNodes.get(userId) || this.screenGainNodes.get(String(userId));
    if (screenGain) screenGain.gain.value = 0;
    const audioEl = document.getElementById(`voice-audio-${userId}`);
    if (audioEl) audioEl.volume = 0;
    const screenEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (screenEl) screenEl.volume = 0;
  }

  undeafenUser(userId) {
    this.deafenedUsers.delete(userId);
    this.deafenedUsers.delete(String(userId));
    const gainNode = this.gainNodes.get(userId) || this.gainNodes.get(String(userId));
    if (gainNode) gainNode.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedVolume(userId));
    const screenGain = this.screenGainNodes.get(userId) || this.screenGainNodes.get(String(userId));
    if (screenGain) screenGain.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedStreamVolume(userId));
    const audioEl = document.getElementById(`voice-audio-${userId}`);
    if (audioEl) audioEl.volume = this._getAppliedIncomingVolume(userId, Math.min(1, this._getSavedVolume(userId)));
    const screenEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (screenEl) screenEl.volume = this._getAppliedIncomingVolume(userId, Math.min(1, this._getSavedStreamVolume(userId)));
  }

  isUserDeafened(userId) {
    return this.deafenedUsers.has(userId) || this.deafenedUsers.has(String(userId));
  }

  _getSavedVolume(userId) {
    try {
      const volumes = JSON.parse(localStorage.getItem("haven_voice_volumes") || "{}");
      return (volumes[userId] ?? 100) / 100;
    } catch {
      return 1;
    }
  }

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
      newRawStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      console.error("[Voice] Failed to switch input device:", err);
      return;
    }

    if (this.rawStream) {
      this.rawStream.getTracks().forEach((track) => track.stop());
    }
    this.rawStream = newRawStream;

    this._disableRNNoise();
    this._stopNoiseGate();
    this._stopLocalTalkDetection();
    this._buildProcessedMicrophoneStream();

    if (this.noiseMode === "suppress" && this._rnnoiseReady) {
      this.setNoiseSensitivity(0);
      this._enableRNNoise();
    } else if (this.noiseMode === "gate") {
      const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
      this.setNoiseSensitivity(saved);
    } else {
      this.setNoiseSensitivity(0);
    }

    await this._publishMicrophoneTrack();
    this._applyMuteStateToLocalTracks();
    this._startLocalTalkDetection();

    localStorage.setItem("haven_input_device", deviceId || "");
  }

  async switchOutputDevice(deviceId) {
    localStorage.setItem("haven_output_device", deviceId || "");

    if (this.audioCtx && typeof this.audioCtx.setSinkId === "function") {
      try {
        await this.audioCtx.setSinkId(deviceId || "");
      } catch (err) {
        console.warn("[Voice] AudioContext.setSinkId failed:", err);
      }
    }

    const elements = document.querySelectorAll("audio, video");
    for (const el of elements) {
      if (typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(deviceId || "");
        } catch {}
      }
    }
  }

  _playScreenAudio(userId, stream) {
    let audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `voice-audio-screen-${userId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.getElementById("audio-container").appendChild(audioEl);

      const savedOutput = localStorage.getItem("haven_output_device");
      if (savedOutput && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // Disconnect and discard previous source + gain nodes for this user.
    const existingScreenSource = this.screenSourceNodes.get(userId);
    if (existingScreenSource) {
      try { existingScreenSource.disconnect(); } catch {}
      this.screenSourceNodes.delete(userId);
    }
    const existingGain = this.screenGainNodes.get(userId);
    if (existingGain) {
      try { existingGain.disconnect(); } catch {}
      this.screenGainNodes.delete(userId);
    }

    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const resumeCtx = this.audioCtx.state === "suspended" ? this.audioCtx.resume() : Promise.resolve();
      resumeCtx.catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedStreamVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.screenSourceNodes.set(userId, source);
      this.screenGainNodes.set(userId, gainNode);
      audioEl.volume = 0;
    } catch {
      const savedVolume = Math.min(1, this._getSavedStreamVolume(userId));
      audioEl.dataset.prevVolume = String(savedVolume);
      audioEl.volume = this._getAppliedIncomingVolume(userId, savedVolume);
    }

    if (this.onScreenAudio) this.onScreenAudio(userId);
  }

  setStreamVolume(userId, volume) {
    const gainNode = this.screenGainNodes.get(userId) || this.screenGainNodes.get(String(userId)) || this.screenGainNodes.get(Number(userId));
    const clampedGain = Math.max(0, Math.min(2, volume));
    const clampedVol = Math.max(0, Math.min(1, volume));
    if (gainNode) gainNode.gain.value = this._getAppliedIncomingVolume(userId, clampedGain);
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (audioEl) audioEl.volume = this._getAppliedIncomingVolume(userId, clampedVol);
  }

  _getSavedStreamVolume(userId) {
    try {
      const volumes = JSON.parse(localStorage.getItem("haven_stream_volumes") || "{}");
      return (volumes[userId] ?? 100) / 100;
    } catch {
      return 1;
    }
  }

  setNoiseMode(mode) {
    this.noiseMode = mode;
    localStorage.setItem("haven_noise_mode", mode);

    if (mode === "suppress") {
      if (this.noiseSensitivity !== 0) this.setNoiseSensitivity(0);
      if (!this._rnnoiseReady) {
        this._initRNNoise().then(() => {
          if (this._rnnoiseReady) this._enableRNNoise();
        });
      } else {
        this._enableRNNoise();
      }
    } else if (mode === "gate") {
      this._disableRNNoise();
      const saved = parseInt(localStorage.getItem("haven_ns_value") || "10", 10);
      this.setNoiseSensitivity(saved);
    } else {
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
      this._rnnoiseWasmModule = await WebAssembly.compile(wasmBytes);
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
      node.port.postMessage({ type: "wasm-module", module: this._rnnoiseWasmModule });
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
      if (this._rnnoiseSource && this._noiseGateGain) {
        this._rnnoiseSource.connect(this._noiseGateGain);
      }
    } catch (err) {
      console.warn("[Voice] Failed to disable RNNoise:", err);
    }
  }

  setNoiseSensitivity(value) {
    this.noiseSensitivity = Math.max(0, Math.min(100, value));
    if (this.noiseSensitivity === 0 && this._noiseGateGain && this.audioCtx) {
      this._noiseGateGain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.01);
    }
    return this.noiseSensitivity;
  }

  _startNoiseGate() {
    if (this._noiseGateInterval) return;
    const analyser = this._noiseGateAnalyser;
    const gain = this._noiseGateGain;
    if (!analyser || !gain || !this.audioCtx) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const ATTACK = 0.015;
    const RELEASE = 0.12;
    const HOLD_MS = 250;
    const OPEN_CONFIRM = 1;
    let gateOpen = false;
    let holdTimeout = null;
    let aboveCount = 0;

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

      const threshold = 2 + (this.noiseSensitivity / 100) * 38;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      this.currentMicLevel = Math.min(100, (avg / 50) * 100);

      if (avg > threshold) {
        aboveCount += 1;
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
      const THRESHOLD = 15;
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
    } catch {}
  }

  _stopLocalTalkDetection() {
    if (this._localTalkInterval) {
      clearInterval(this._localTalkInterval);
      this._localTalkInterval = null;
      this._localTalkAnalyser = null;
      if (this.socket && this.inVoice) this.socket.emit("voice-speaking", { speaking: false });
      this.talkingState.set("self", false);
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

      const savedOutput = localStorage.getItem("haven_output_device");
      if (savedOutput && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch(() => {});
      }
    }
    audioEl.srcObject = stream;

    // Disconnect and discard previous source + gain nodes for this user.
    const existingSource = this.sourceNodes.get(userId);
    if (existingSource) {
      try { existingSource.disconnect(); } catch {}
      this.sourceNodes.delete(userId);
    }
    const existingGain = this.gainNodes.get(userId);
    if (existingGain) {
      try { existingGain.disconnect(); } catch {}
      this.gainNodes.delete(userId);
    }

    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const resumeCtx = this.audioCtx.state === "suspended" ? this.audioCtx.resume() : Promise.resolve();
      resumeCtx.catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(stream);
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = this._getAppliedIncomingVolume(userId, this._getSavedVolume(userId));
      source.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);
      this.sourceNodes.set(userId, source);
      this.gainNodes.set(userId, gainNode);
      audioEl.volume = 0;
    } catch {
      const savedVolume = Math.min(1, this._getSavedVolume(userId));
      audioEl.dataset.prevVolume = String(savedVolume);
      audioEl.volume = this._getAppliedIncomingVolume(userId, savedVolume);
    }
  }

  async _fetchLiveKitToken(channelCode) {
    const token = localStorage.getItem("haven_token");
    if (!token) throw new Error("Missing auth token");

    const response = await fetch("/api/livekit/token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelCode }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Failed to fetch LiveKit token");
    }
    return data;
  }

  _createRoom() {
    const room = new this.livekit.Room({
      adaptiveStream: true,
      dynacast: true,
    });

    room.on(this.livekit.RoomEvent.ParticipantConnected, (participant) => {
      this._rememberParticipant(participant);
    });

    room.on(this.livekit.RoomEvent.ParticipantDisconnected, (participant) => {
      const userId = this._getParticipantUserId(participant);
      this._cleanupRemoteParticipant(userId, true);
    });

    room.on(this.livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      this._handleTrackSubscribed(track, publication, participant);
    });

    room.on(this.livekit.RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      this._handleTrackUnsubscribed(publication, participant);
    });

    room.on(this.livekit.RoomEvent.Disconnected, () => {
      if (!this._roomDisconnectExpected && this.inVoice) {
        this._softLeave();
      }
    });

    room.on(this.livekit.RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) {
        room.startAudio().catch(() => {});
      }
    });

    return room;
  }

  async _publishMicrophoneTrack() {
    if (!this.room?.localParticipant || !this.localStream) return;
    const nextTrack = this.localStream.getAudioTracks()[0] || null;
    if (!nextTrack) return;

    const previousTrack = this._localTrackState.microphone;
    if (previousTrack && previousTrack !== nextTrack) {
      try {
        await this.room.localParticipant.unpublishTrack(previousTrack);
      } catch {}
    }

    await this.room.localParticipant.publishTrack(nextTrack, {
      source: this.livekit.Track.Source.Microphone,
      name: "voice",
    });
    this._localTrackState.microphone = nextTrack;
  }

  _buildProcessedMicrophoneStream() {
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
    this.localStream = dest.stream;
    this._startNoiseGate();
  }

  _rememberParticipant(participant) {
    const userId = this._getParticipantUserId(participant);
    this.peers.set(userId, { username: this._getParticipantName(participant) });
  }

  _getParticipantUserId(participant) {
    const identity = String(participant?.identity || "");
    const asNumber = Number(identity);
    return Number.isFinite(asNumber) && String(asNumber) === identity ? asNumber : identity;
  }

  _getParticipantName(participant) {
    if (!participant) return "Unknown";
    try {
      const meta = participant.metadata ? JSON.parse(participant.metadata) : null;
      if (meta?.displayName) return meta.displayName;
      if (meta?.username) return meta.username;
    } catch {}
    return participant.name || participant.identity || "Unknown";
  }

  _handleTrackSubscribed(track, publication, participant) {
    const userId = this._getParticipantUserId(participant);
    this.peers.set(userId, { username: this._getParticipantName(participant) });

    const mediaTrack = track?.mediaStreamTrack;
    if (!mediaTrack) return;
    const source = publication?.source;
    const stream = new MediaStream([mediaTrack]);

    if (source === this.livekit.Track.Source.Camera) {
      this.webcamUsers.add(userId);
      if (this.onWebcamStream) this.onWebcamStream(userId, stream);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
      return;
    }

    if (source === this.livekit.Track.Source.ScreenShare) {
      if (mediaTrack.kind === "audio") {
        this.screenSharers.add(userId);
        this._playScreenAudio(userId, stream);
        return;
      }
      this.screenSharers.add(userId);
      if (this.onScreenStream) this.onScreenStream(userId, stream);
      return;
    }

    const screenAudioSource = this._getScreenAudioSource();
    if (source === screenAudioSource) {
      this.screenSharers.add(userId);
      this._playScreenAudio(userId, stream);
      return;
    }

    this._playAudio(userId, stream);
  }

  _handleTrackUnsubscribed(publication, participant) {
    const userId = this._getParticipantUserId(participant);
    const source = publication?.source;
    const screenAudioSource = this._getScreenAudioSource();
    const isAudioPublication = publication?.kind === this.livekit.Track.Kind.Audio || publication?.kind === "audio";

    if (source === this.livekit.Track.Source.Camera) {
      this._clearWebcamMedia(userId);
      this.webcamUsers.delete(userId);
      if (this.onWebcamStatusChange) this.onWebcamStatusChange();
      return;
    }

    if (source === this.livekit.Track.Source.ScreenShare) {
      if (isAudioPublication) {
        this._clearScreenAudio(userId);
        return;
      }
      this._clearScreenMedia(userId, { clearAudio: false });
      return;
    }

    if (source === screenAudioSource) {
      this._clearScreenAudio(userId);
      return;
    }

    this._clearVoiceAudio(userId);
  }

  _cleanupRemoteParticipant(userId, removePeer) {
    this._clearVoiceAudio(userId);
    this._clearScreenMedia(userId);
    this._clearWebcamMedia(userId);
    this.screenSharers.delete(userId);
    this.webcamUsers.delete(userId);
    this.talkingState.delete(userId);
    if (this.onTalkingChange) this.onTalkingChange(userId, false);
    if (removePeer) this.peers.delete(userId);
  }

  _getScreenAudioSource() {
    return this.livekit.Track.Source.ScreenShareAudio || this.livekit.Track.Source.ScreenShare;
  }

  _clearVoiceAudio(userId) {
    const audioEl = document.getElementById(`voice-audio-${userId}`);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
    }
    const sourceNode = this.sourceNodes.get(userId) || this.sourceNodes.get(String(userId));
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
    }
    this.sourceNodes.delete(userId);
    this.sourceNodes.delete(String(userId));
    const gainNode = this.gainNodes.get(userId) || this.gainNodes.get(String(userId));
    if (gainNode) {
      try {
        gainNode.disconnect();
      } catch {}
    }
    this.gainNodes.delete(userId);
    this.gainNodes.delete(String(userId));
  }

  _clearScreenAudio(userId) {
    const audioEl = document.getElementById(`voice-audio-screen-${userId}`);
    if (audioEl) {
      audioEl.srcObject = null;
      audioEl.remove();
    }
    const screenSource = this.screenSourceNodes.get(userId) || this.screenSourceNodes.get(String(userId));
    if (screenSource) {
      try { screenSource.disconnect(); } catch {}
    }
    this.screenSourceNodes.delete(userId);
    this.screenSourceNodes.delete(String(userId));
    const gainNode = this.screenGainNodes.get(userId) || this.screenGainNodes.get(String(userId));
    if (gainNode) {
      try {
        gainNode.disconnect();
      } catch {}
    }
    this.screenGainNodes.delete(userId);
    this.screenGainNodes.delete(String(userId));
  }

  _clearScreenMedia(userId) {
    this._clearScreenAudio(userId);
    if (this.onScreenStream) this.onScreenStream(userId, null);
  }

  _clearWebcamMedia(userId) {
    if (this.onWebcamStream) this.onWebcamStream(userId, null);
  }

  _disconnectRoom() {
    this._roomDisconnectExpected = true;
    if (this.room) {
      try {
        this.room.disconnect();
      } catch {}
      this.room = null;
    }
    this._localTrackState = {
      microphone: null,
      webcam: null,
      screenVideo: null,
      screenAudio: null,
    };
  }

  _cleanupLocalMediaOnly() {
    if (this.rawStream) {
      this.rawStream.getTracks().forEach((track) => track.stop());
      this.rawStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
      this.screenStream = null;
    }
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach((track) => track.stop());
      this.webcamStream = null;
    }

    this.isScreenSharing = false;
    this.isWebcamActive = false;
    this.screenHasAudio = false;

    document.querySelectorAll("#audio-container audio").forEach((audio) => {
      audio.srcObject = null;
      audio.remove();
    });

    for (const sourceNode of this.sourceNodes.values()) {
      try { sourceNode.disconnect(); } catch {}
    }
    for (const sourceNode of this.screenSourceNodes.values()) {
      try { sourceNode.disconnect(); } catch {}
    }
    for (const gainNode of this.gainNodes.values()) {
      try {
        gainNode.disconnect();
      } catch {}
    }
    for (const gainNode of this.screenGainNodes.values()) {
      try {
        gainNode.disconnect();
      } catch {}
    }
    this.sourceNodes.clear();
    this.screenSourceNodes.clear();
    this.gainNodes.clear();
    this.screenGainNodes.clear();

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this._cachedSilentTrack = null;
  }
}
