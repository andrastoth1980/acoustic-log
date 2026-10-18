/**
 * AcousticLog — Audiological Real-Time DSP Engine (dsp-engine.js)
 * Pure Web Audio API spectral & time-domain analysis + procedural scene synthesizer.
 * Zero DOM dependencies.
 */
class DSPEngine {
  /**
   * 10 standard audiological fitting channels (Hz) with lower and upper band edges.
   */
  static BANDS = [
    { center: 125, lo: 88, hi: 177 },
    { center: 250, lo: 177, hi: 354 },
    { center: 500, lo: 354, hi: 707 },
    { center: 1000, lo: 707, hi: 1225 },
    { center: 1500, lo: 1225, hi: 1768 },
    { center: 2000, lo: 1768, hi: 2500 },
    { center: 3000, lo: 2500, hi: 3536 },
    { center: 4000, lo: 3536, hi: 5000 },
    { center: 6000, lo: 5000, hi: 7071 },
    { center: 8000, lo: 7071, hi: 11000 }
  ];

  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.fftSize = 4096;
    this.smoothingTimeConstant = 0.2;

    this.freqData = null;
    this.timeData = null;
    this.spectrumBuffer = new Float32Array(this.fftSize / 2);

    this.micStream = null;
    this.micSource = null;

    this.synthNodes = [];
    this.synthTimer = null;
    this.synthGain = null;
    this.speakerGain = null;

    this.activeSource = null; // 'mic' | 'synth:restaurant' | 'synth:traffic' | 'synth:feedback' | null
    this.calibrationOffset = 0;

    this.bands = new Float32Array(DSPEngine.BANDS.length);
    this.peaks = new Float32Array(DSPEngine.BANDS.length);
    this.lastFrameTime = 0;

    // 250 ms rolling time-domain history for Crest Factor [{ time, meanSq, peakAbs }]
    this.rollingWindowMs = 250;
    this.rollingHistory = [];

    this._fbState = {
      detected: false,
      candHz: 0,
      candProm: 0,
      durationMs: 0,
      silenceMs: 0
    };

    this._loadCalibration();
  }

  _resetFeedbackState() {
    this._fbState = {
      detected: false,
      candHz: 0,
      candProm: 0,
      durationMs: 0,
      silenceMs: 0
    };
  }

  _loadCalibration() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('acousticlog_cal');
        if (saved !== null) {
          const parsed = parseFloat(saved);
          if (Number.isFinite(parsed)) {
            this.calibrationOffset = Math.max(-20, Math.min(40, parsed));
          }
        }
      }
    } catch (e) {
      // Ignore storage access errors
    }
  }

  _ensureContext() {
    const AudioCtx =
      typeof window !== 'undefined'
        ? window.AudioContext || window.webkitAudioContext
        : null;

    if (!AudioCtx) {
      const err = new Error('Web Audio API is not supported in this browser.');
      err.code = 'unsupported';
      throw err;
    }

    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioCtx();
    }

    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
      this.analyser.minDecibels = -110;
      this.analyser.maxDecibels = 0;

      this.freqData = new Float32Array(this.analyser.frequencyBinCount);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.spectrumBuffer = new Float32Array(this.analyser.frequencyBinCount);
    }

    return this.ctx;
  }

  /**
   * Starts raw, unprocessed microphone stream and routes it to the AnalyserNode.
   * Throws Error with .code in ('unsupported' | 'insecure' | 'denied' | 'notfound').
   */
  async startMic() {
    if (typeof window !== 'undefined') {
      const isLocal =
        window.location &&
        (window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1' ||
          window.location.hostname === '[::1]');
      if (!window.isSecureContext && !isLocal) {
        const err = new Error('Microphone requires HTTPS or localhost.');
        err.code = 'insecure';
        throw err;
      }
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      const isHttps =
        typeof window !== 'undefined' && window.isSecureContext;
      const err = new Error('MediaDevices getUserMedia is unavailable.');
      err.code = isHttps ? 'unsupported' : 'insecure';
      throw err;
    }

    this.stop();
    const ctx = this._ensureContext();

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
    } catch (rawErr) {
      const name = (rawErr && rawErr.name) || '';
      const err = new Error((rawErr && rawErr.message) || 'Microphone error');
      if (
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        name === 'SecurityError'
      ) {
        err.code = 'denied';
      } else if (
        name === 'NotFoundError' ||
        name === 'DevicesNotFoundError' ||
        name === 'OverconstrainedError' ||
        name === 'NotReadableError'
      ) {
        err.code = 'notfound';
      } else {
        err.code = 'notfound';
      }
      throw err;
    }

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.analyser);

    this.rollingHistory = [];
    this.resetPeaks();
    this._resetFeedbackState();
    this.lastFrameTime = performance.now();
    this.activeSource = 'mic';
    return true;
  }

  /**
   * Starts built-in procedural noise synthesizer ('restaurant' | 'traffic' | 'feedback').
   * Routes synthesized signal into AnalyserNode and at modest gain to speakers.
   */
  startSynth(preset = 'restaurant') {
    const mode =
      preset === 'traffic'
        ? 'traffic'
        : preset === 'feedback'
          ? 'feedback'
          : 'restaurant';
    this.stop();

    const ctx = this._ensureContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const sr = ctx.sampleRate;

    // Master synth bus feeding AnalyserNode at realistic acoustic amplitude
    const synthBus = ctx.createGain();
    synthBus.gain.value = 1.0;
    synthBus.connect(this.analyser);

    // Modest speaker monitoring gain so the user hears the scene comfortably
    const speakerGain = ctx.createGain();
    speakerGain.gain.value = 0.14;
    synthBus.connect(speakerGain);
    speakerGain.connect(ctx.destination);

    this.synthGain = synthBus;
    this.speakerGain = speakerGain;
    this.synthNodes.push(synthBus, speakerGain);

    // Generate 4-second white and pink noise buffers
    const bufLen = sr * 4;
    const whiteBuffer = ctx.createBuffer(1, bufLen, sr);
    const pinkBuffer = ctx.createBuffer(1, bufLen, sr);
    const whiteData = whiteBuffer.getChannelData(0);
    const pinkData = pinkBuffer.getChannelData(0);

    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < bufLen; i++) {
      const w = Math.random() * 2 - 1;
      whiteData[i] = w;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pinkData[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.045;
      b6 = w * 0.115926;
    }

    if (mode === 'restaurant') {
      // 1. Quiet background babble bed (600–2800 Hz)
      const babbleSource = ctx.createBufferSource();
      babbleSource.buffer = pinkBuffer;
      babbleSource.loop = true;

      const babbleBp = ctx.createBiquadFilter();
      babbleBp.type = 'bandpass';
      babbleBp.frequency.value = 1400;
      babbleBp.Q.value = 0.9;

      const babbleHighShelf = ctx.createBiquadFilter();
      babbleHighShelf.type = 'highshelf';
      babbleHighShelf.frequency.value = 2600;
      babbleHighShelf.gain.value = 6.0;

      const babbleGain = ctx.createGain();
      babbleGain.gain.value = 0.045;

      // Subtle speech-like syllabic modulation (~3.5 Hz)
      const babbleLfo = ctx.createOscillator();
      babbleLfo.type = 'sine';
      babbleLfo.frequency.value = 3.5;
      const babbleLfoGain = ctx.createGain();
      babbleLfoGain.gain.value = 0.015;

      babbleLfo.connect(babbleLfoGain);
      babbleLfoGain.connect(babbleGain.gain);

      babbleSource.connect(babbleBp);
      babbleBp.connect(babbleHighShelf);
      babbleHighShelf.connect(babbleGain);
      babbleGain.connect(synthBus);

      babbleSource.start();
      babbleLfo.start();
      this.synthNodes.push(
        babbleSource,
        babbleBp,
        babbleHighShelf,
        babbleGain,
        babbleLfo,
        babbleLfoGain
      );

      // 2. Continuous high-frequency sibilance/clatter bed at 3–4.5 kHz
      const hfSource = ctx.createBufferSource();
      hfSource.buffer = whiteBuffer;
      hfSource.loop = true;

      const hfFilter = ctx.createBiquadFilter();
      hfFilter.type = 'bandpass';
      hfFilter.frequency.value = 3400;
      hfFilter.Q.value = 2.5;

      const hfGain = ctx.createGain();
      hfGain.gain.value = 0.04;

      hfSource.connect(hfFilter);
      hfFilter.connect(hfGain);
      hfGain.connect(synthBus);
      hfSource.start();
      this.synthNodes.push(hfSource, hfFilter, hfGain);

      // 3. Sharp random-interval bursts (5–40 ms) bandpassed 3–4 kHz (dishes/cutlery clatter)
      const triggerBurst = () => {
        if (this.activeSource !== 'synth:restaurant' || !this.ctx) return;

        const now = this.ctx.currentTime;
        const durationSec = (5 + Math.random() * 35) / 1000; // 5–40 ms
        const centerFreq = 2950 + Math.random() * 1150; // 2950–4100 Hz
        const peakAmp = 0.65 + Math.random() * 0.45;

        // Filtered noise transient burst
        const burstSrc = this.ctx.createBufferSource();
        burstSrc.buffer = whiteBuffer;
        burstSrc.loop = true;

        const bp1 = this.ctx.createBiquadFilter();
        bp1.type = 'bandpass';
        bp1.frequency.value = centerFreq;
        bp1.Q.value = 3.5;

        const bp2 = this.ctx.createBiquadFilter();
        bp2.type = 'peaking';
        bp2.frequency.value = centerFreq * 1.15;
        bp2.Q.value = 4.0;
        bp2.gain.value = 10;

        // Metallic cutlery resonance ping
        const pingOsc = this.ctx.createOscillator();
        pingOsc.type = 'triangle';
        pingOsc.frequency.value = centerFreq;

        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(peakAmp, now + 0.0015);
        env.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

        const pingGain = this.ctx.createGain();
        pingGain.gain.value = 0.35;

        burstSrc.connect(bp1);
        bp1.connect(bp2);
        bp2.connect(env);

        pingOsc.connect(pingGain);
        pingGain.connect(env);

        env.connect(synthBus);

        const randomOffset = Math.random() * 3.5;
        burstSrc.start(now, randomOffset, durationSec + 0.02);
        pingOsc.start(now);
        pingOsc.stop(now + durationSec + 0.01);

        const nextDelayMs = 55 + Math.random() * 130;
        this.synthTimer = setTimeout(triggerBurst, nextDelayMs);
      };

      this.activeSource = 'synth:restaurant';
      triggerBurst();
    } else if (mode === 'traffic') {
      // TRAFFIC RUMBLE: Strong 125–500 Hz lowpass/peaking noise + slow AM + weaker speech-band content
      const rumbleSource = ctx.createBufferSource();
      rumbleSource.buffer = pinkBuffer;
      rumbleSource.loop = true;

      // Sub/low boost at 160 Hz
      const lowPeak1 = ctx.createBiquadFilter();
      lowPeak1.type = 'peaking';
      lowPeak1.frequency.value = 165;
      lowPeak1.Q.value = 1.1;
      lowPeak1.gain.value = 15;

      // Second low-mid engine resonance at 290 Hz
      const lowPeak2 = ctx.createBiquadFilter();
      lowPeak2.type = 'peaking';
      lowPeak2.frequency.value = 290;
      lowPeak2.Q.value = 1.2;
      lowPeak2.gain.value = 11;

      // Steep roll-off above 500 Hz so low-frequency energy dominates
      const lowPass = ctx.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.frequency.value = 460;
      lowPass.Q.value = 0.85;

      const rumbleGain = ctx.createGain();
      rumbleGain.gain.value = 0.24;

      // Slow amplitude modulation simulating passing heavy vehicles
      const trafficLfo = ctx.createOscillator();
      trafficLfo.type = 'sine';
      trafficLfo.frequency.value = 0.35;

      const trafficLfoDepth = ctx.createGain();
      trafficLfoDepth.gain.value = 0.065;

      trafficLfo.connect(trafficLfoDepth);
      trafficLfoDepth.connect(rumbleGain.gain);

      rumbleSource.connect(lowPeak1);
      lowPeak1.connect(lowPeak2);
      lowPeak2.connect(lowPass);
      lowPass.connect(rumbleGain);
      rumbleGain.connect(synthBus);

      // Low-frequency diesel fundamental hum (~135 Hz)
      const engineHum = ctx.createOscillator();
      engineHum.type = 'sawtooth';
      engineHum.frequency.value = 135;

      const humLp = ctx.createBiquadFilter();
      humLp.type = 'lowpass';
      humLp.frequency.value = 260;

      const humGain = ctx.createGain();
      humGain.gain.value = 0.045;

      engineHum.connect(humLp);
      humLp.connect(humGain);
      humGain.connect(synthBus);

      // Weaker speech-band tire/wind background (1000–4000 Hz)
      const speechBed = ctx.createBufferSource();
      speechBed.buffer = pinkBuffer;
      speechBed.loop = true;

      const speechBp = ctx.createBiquadFilter();
      speechBp.type = 'bandpass';
      speechBp.frequency.value = 1800;
      speechBp.Q.value = 0.7;

      const speechGain = ctx.createGain();
      speechGain.gain.value = 0.028;

      speechBed.connect(speechBp);
      speechBp.connect(speechGain);
      speechGain.connect(synthBus);

      rumbleSource.start();
      trafficLfo.start();
      engineHum.start();
      speechBed.start();

      this.synthNodes.push(
        rumbleSource,
        lowPeak1,
        lowPeak2,
        lowPass,
        rumbleGain,
        trafficLfo,
        trafficLfoDepth,
        engineHum,
        humLp,
        humGain,
        speechBed,
        speechBp,
        speechGain
      );

      this.activeSource = 'synth:traffic';
    } else if (mode === 'feedback') {
      // FEEDBACK WHISTLE: Steady room tone (pink noise bed) + intermittent ~3150 Hz sine whistle.
      // Balanced so the whistle has >30 dB narrowband spectral prominence at 3150 Hz while
      // keeping the 250 ms time-domain Crest Factor around 8–11 dB (below the 14 dB impulse threshold).
      const roomSource = ctx.createBufferSource();
      roomSource.buffer = pinkBuffer;
      roomSource.loop = true;

      const roomBp = ctx.createBiquadFilter();
      roomBp.type = 'bandpass';
      roomBp.frequency.value = 900;
      roomBp.Q.value = 0.75;

      const roomLp = ctx.createBiquadFilter();
      roomLp.type = 'lowpass';
      roomLp.frequency.value = 1750;

      const roomGain = ctx.createGain();
      roomGain.gain.value = 0.34;

      roomSource.connect(roomBp);
      roomBp.connect(roomLp);
      roomLp.connect(roomGain);
      roomGain.connect(synthBus);
      roomSource.start();

      const whistleOsc = ctx.createOscillator();
      whistleOsc.type = 'sine';
      whistleOsc.frequency.value = 3150;

      const wobbleLfo = ctx.createOscillator();
      wobbleLfo.type = 'sine';
      wobbleLfo.frequency.value = 4.5;

      const wobbleGain = ctx.createGain();
      wobbleGain.gain.value = 6; // ±6 Hz wobble around 3150 Hz

      wobbleLfo.connect(wobbleGain);
      wobbleGain.connect(whistleOsc.frequency);

      const whistleGain = ctx.createGain();
      whistleGain.gain.value = 0.024;

      whistleOsc.connect(whistleGain);
      whistleGain.connect(synthBus);

      whistleOsc.start();
      wobbleLfo.start();

      this.synthNodes.push(
        roomSource,
        roomBp,
        roomLp,
        roomGain,
        whistleOsc,
        wobbleLfo,
        wobbleGain,
        whistleGain
      );

      let whistleHigh = true;
      const scheduleWhistle = () => {
        if (this.activeSource !== 'synth:feedback' || !this.ctx) return;
        const now = this.ctx.currentTime;
        const segDurSec = 0.8 + Math.random() * 0.6;
        const targetGain = whistleHigh
          ? 0.023 + Math.random() * 0.004
          : 0.017 + Math.random() * 0.002;
        whistleGain.gain.cancelScheduledValues(now);
        whistleGain.gain.setValueAtTime(
          Math.max(0.015, whistleGain.gain.value),
          now
        );
        whistleGain.gain.linearRampToValueAtTime(targetGain, now + segDurSec);
        whistleHigh = !whistleHigh;
        this.synthTimer = setTimeout(scheduleWhistle, segDurSec * 1000);
      };

      this.activeSource = 'synth:feedback';
      scheduleWhistle();
    }

    this.rollingHistory = [];
    this.resetPeaks();
    this._resetFeedbackState();
    this.lastFrameTime = performance.now();
    return true;
  }

  /**
   * Stops the built-in synthesizer if running.
   */
  stopSynth() {
    if (this.synthTimer) {
      clearTimeout(this.synthTimer);
      this.synthTimer = null;
    }

    for (let i = 0; i < this.synthNodes.length; i++) {
      const node = this.synthNodes[i];
      if (!node) continue;
      try {
        if (typeof node.stop === 'function') {
          node.stop();
        }
      } catch (e) {
        // Ignore already-stopped source nodes
      }
      try {
        node.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
    }
    this.synthNodes = [];
    this.synthGain = null;
    this.speakerGain = null;

    if (this.activeSource && this.activeSource.startsWith('synth:')) {
      this.activeSource = null;
    }
  }

  /**
   * Stops both microphone tracks and synthesizer nodes while keeping AudioContext alive.
   */
  stop() {
    this.stopSynth();

    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.micSource = null;
    }

    if (this.micStream) {
      try {
        const tracks = this.micStream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
      } catch (e) {
        // Ignore
      }
      this.micStream = null;
    }

    this.activeSource = null;
    this.rollingHistory = [];
    this._resetFeedbackState();
  }

  /**
   * Sets calibration offset in dB (-20 to +40 dB) and persists to localStorage.
   */
  setCalibration(db) {
    const num = Number(db);
    if (!Number.isFinite(num)) return this.calibrationOffset;
    this.calibrationOffset = Math.max(-20, Math.min(40, Math.round(num)));
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('acousticlog_cal', String(this.calibrationOffset));
      }
    } catch (e) {
      // Ignore storage errors
    }
    return this.calibrationOffset;
  }

  /**
   * Returns current calibration offset in dB.
   */
  getCalibration() {
    return this.calibrationOffset;
  }

  /**
   * Resets 10-band Peak-Hold markers to 0 dB SPL.
   */
  resetPeaks() {
    this.peaks.fill(0);
  }

  /**
   * Returns true if microphone or synth is currently active.
   */
  isActive() {
    return Boolean(this.activeSource);
  }

  /**
   * Returns current source identifier ('mic' | 'synth:restaurant' | 'synth:traffic' | 'synth:feedback' | null).
   */
  getSource() {
    return this.activeSource;
  }

  /**
   * Computes a single real-time spectral and time-domain analysis frame.
   * Returns a safe, finite silent frame when inactive.
   */
  getFrameData() {
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    const binHz = sr / this.fftSize;

    if (!this.isActive() || !this.analyser || !this.ctx) {
      this.bands.fill(0);
      this.spectrumBuffer.fill(-100);
      return {
        bands: new Float32Array(this.bands),
        peaks: new Float32Array(this.peaks),
        spl: 0,
        dbSPL: 0,
        peakDb: 0,
        crest: 0,
        cf: 0,
        centroid: 0,
        usmr: 0,
        stress: 0,
        feedback: {
          detected: false,
          hz: 0,
          prominence: 0,
          durationMs: 0
        },
        spectrum: this.spectrumBuffer,
        binHz,
        sampleRate: sr,
        active: false
      };
    }

    const now = performance.now();
    const rawDtSec =
      this.lastFrameTime > 0 ? Math.max(0, (now - this.lastFrameTime) / 1000) : 1 / 60;
    const dtSec = Math.min(0.25, rawDtSec);
    this.lastFrameTime = now;

    // 1. Time-domain analysis (RMS, dB SPL, and 250 ms rolling Crest Factor)
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sumSq = 0;
    let framePeakAbs = 0;
    const nTime = this.timeData.length;

    for (let i = 0; i < nTime; i++) {
      const sample = this.timeData[i];
      if (!Number.isFinite(sample)) continue;
      const abs = Math.abs(sample);
      if (abs > framePeakAbs) framePeakAbs = abs;
      sumSq += sample * sample;
    }

    const frameMeanSq = nTime > 0 ? sumSq / nTime : 0;

    // Maintain 250 ms rolling window of time-domain energy & peak
    const lastHist =
      this.rollingHistory.length > 0
        ? this.rollingHistory[this.rollingHistory.length - 1]
        : null;
    if (lastHist && now - lastHist.time < 4) {
      lastHist.meanSq = frameMeanSq;
      if (framePeakAbs > lastHist.peakAbs) {
        lastHist.peakAbs = framePeakAbs;
      }
    } else {
      this.rollingHistory.push({
        time: now,
        meanSq: frameMeanSq,
        peakAbs: framePeakAbs
      });
    }

    const cutoff = now - this.rollingWindowMs;
    while (
      this.rollingHistory.length > 1 &&
      this.rollingHistory[0].time < cutoff
    ) {
      this.rollingHistory.shift();
    }

    let windowMeanSqSum = 0;
    let windowPeakAbs = 0;
    for (let i = 0; i < this.rollingHistory.length; i++) {
      const item = this.rollingHistory[i];
      windowMeanSqSum += item.meanSq;
      if (item.peakAbs > windowPeakAbs) {
        windowPeakAbs = item.peakAbs;
      }
    }

    const windowRms = Math.sqrt(
      windowMeanSqSum / Math.max(1, this.rollingHistory.length)
    );
    const instRms = Math.sqrt(frameMeanSq);

    const floorLin = 1e-6; // -120 dBFS guard against -Infinity
    const rmsForSpl = Math.max(floorLin, windowRms > 0 ? windowRms : instRms);
    const peakForCf = Math.max(rmsForSpl, windowPeakAbs);

    const rmsDbFS = 20 * Math.log10(rmsForSpl);
    const peakDbFS = 20 * Math.log10(peakForCf);

    const spl = Math.max(0, Math.min(130, rmsDbFS + 94 + this.calibrationOffset));
    const peakDb = Math.max(
      spl,
      Math.min(140, peakDbFS + 94 + this.calibrationOffset)
    );
    const crest = Math.max(0, Math.min(40, peakDbFS - rmsDbFS));

    // 2. Frequency-domain analysis (4096-pt FFT, power-domain band aggregation)
    this.analyser.getFloatFrequencyData(this.freqData);
    const numBins = this.freqData.length;

    // Blackman window energy compensation factor (~2.38) so summed bin power matches time-domain RMS^2
    const windowPowerComp = 2.38;

    for (let i = 0; i < numBins; i++) {
      const rawDb = this.freqData[i];
      const safeDb = Number.isFinite(rawDb) ? Math.max(-120, rawDb) : -120;
      this.spectrumBuffer[i] = safeDb + 94 + this.calibrationOffset;
    }

    const bandPowers = new Float64Array(DSPEngine.BANDS.length);
    const decayDb = 10 * dtSec; // ~10 dB/s Peak-Hold decay

    for (let b = 0; b < DSPEngine.BANDS.length; b++) {
      const bandDef = DSPEngine.BANDS[b];
      const binLo = Math.max(1, Math.floor(bandDef.lo / binHz));
      const binHi = Math.min(numBins - 1, Math.ceil(bandDef.hi / binHz));

      let powerSum = 0;
      for (let i = binLo; i <= binHi; i++) {
        const dbVal = this.freqData[i];
        if (Number.isFinite(dbVal) && dbVal > -120) {
          powerSum += Math.pow(10, dbVal / 10);
        }
      }

      powerSum *= windowPowerComp;
      bandPowers[b] = powerSum;

      let bandSpl = 0;
      if (powerSum > 1e-12) {
        bandSpl = 10 * Math.log10(powerSum) + 94 + this.calibrationOffset;
      }
      bandSpl = Math.max(0, Math.min(130, bandSpl));
      this.bands[b] = bandSpl;

      const decayedPeak = Math.max(0, this.peaks[b] - decayDb);
      this.peaks[b] = Math.max(bandSpl, decayedPeak);
    }

    // 3. Spectral Centroid: Σ (f * a) / Σ a across audiological range (88–11000 Hz)
    const minCentroidBin = Math.max(1, Math.floor(88 / binHz));
    const maxCentroidBin = Math.min(numBins - 1, Math.ceil(11000 / binHz));
    let weightedFreqSum = 0;
    let ampSum = 0;

    for (let i = minCentroidBin; i <= maxCentroidBin; i++) {
      const dbVal = this.freqData[i];
      if (Number.isFinite(dbVal) && dbVal > -115) {
        const amp = Math.pow(10, dbVal / 20);
        const freq = i * binHz;
        weightedFreqSum += freq * amp;
        ampSum += amp;
      }
    }

    const centroid =
      ampSum > 1e-9
        ? Math.max(0, Math.min(11000, weightedFreqSum / ampSum))
        : 0;

    // 4. USMR (Upward Spread of Masking Ratio): E(125–500 Hz) dB − E(1000–4000 Hz) dB
    // Bands 0..2 = 125, 250, 500 Hz; Bands 3..7 = 1000, 1500, 2000, 3000, 4000 Hz
    const lowPower =
      bandPowers[0] + bandPowers[1] + bandPowers[2];
    const speechPower =
      bandPowers[3] +
      bandPowers[4] +
      bandPowers[5] +
      bandPowers[6] +
      bandPowers[7];

    let usmr = 0;
    if (lowPower > 1e-12 && speechPower > 1e-12) {
      const lowDb = 10 * Math.log10(lowPower);
      const speechDb = 10 * Math.log10(speechPower);
      usmr = Math.max(-40, Math.min(40, lowDb - speechDb));
    }

    // 5. Composite Acoustic Stress Index (0–100%)
    // Documented clinical weighting:
    // - 35% SPL Loudness load (50 dB = 0%, 90 dB = 100%)
    // - 25% Transient Crest Factor load (6 dB = 0%, 18 dB = 100%)
    // - 20% Spectral Centroid sharpness load (1000 Hz = 0%, 3500 Hz = 100%)
    // - 20% Upward Spread of Masking USMR load (-2 dB = 0%, +12 dB = 100%)
    const splNorm = Math.max(0, Math.min(1, (spl - 50) / 40));
    const crestNorm = Math.max(0, Math.min(1, (crest - 6) / 12));
    const centroidNorm = Math.max(0, Math.min(1, (centroid - 1000) / 2500));
    const usmrNorm = Math.max(0, Math.min(1, (usmr + 2) / 14));

    const rawStress =
      (0.35 * splNorm +
        0.25 * crestNorm +
        0.20 * centroidNorm +
        0.20 * usmrNorm) *
      100;
    const stress =
      spl < 35 ? 0 : Math.max(0, Math.min(100, Math.round(rawStress)));

    // 6. Acoustic Feedback (Whistling) Detector (1500–6000 Hz)
    const minFbBin = Math.max(2, Math.floor(1500 / binHz));
    const maxFbBin = Math.min(numBins - 3, Math.ceil(6000 / binHz));
    let peakBin = minFbBin;
    let peakBinDb = -120;

    for (let i = minFbBin; i <= maxFbBin; i++) {
      const raw = this.freqData[i];
      const val = Number.isFinite(raw) ? Math.max(-120, raw) : -120;
      if (val > peakBinDb) {
        peakBinDb = val;
        peakBin = i;
      }
    }

    // Parabolic interpolation around peakBin
    const alphaRaw = this.freqData[peakBin - 1];
    const gammaRaw = this.freqData[peakBin + 1];
    const alpha = Number.isFinite(alphaRaw) ? Math.max(-120, alphaRaw) : -120;
    const beta = peakBinDb;
    const gamma = Number.isFinite(gammaRaw) ? Math.max(-120, gammaRaw) : -120;
    const denom = alpha - 2 * beta + gamma;
    let interpOffset = 0;
    if (Math.abs(denom) > 1e-6) {
      interpOffset = Math.max(-0.5, Math.min(0.5, (0.5 * (alpha - gamma)) / denom));
    }
    const refinedHz = (peakBin + interpOffset) * binHz;
    const refinedPeakDb = Math.max(beta, beta - 0.25 * (alpha - gamma) * interpOffset);

    // Prominence against median of bins within ±400 Hz, excluding ±2 bins around peak
    const radiusBins = Math.max(3, Math.round(400 / binHz));
    const nLo = Math.max(1, peakBin - radiusBins);
    const nHi = Math.min(numBins - 1, peakBin + radiusBins);
    const neighborDbs = [];
    for (let i = nLo; i <= nHi; i++) {
      if (Math.abs(i - peakBin) <= 2) continue;
      const raw = this.freqData[i];
      neighborDbs.push(Number.isFinite(raw) ? Math.max(-120, raw) : -120);
    }

    let medianDb = -120;
    if (neighborDbs.length > 0) {
      neighborDbs.sort((a, b) => a - b);
      const mid = neighborDbs.length >> 1;
      medianDb =
        neighborDbs.length % 2 === 1
          ? neighborDbs[mid]
          : 0.5 * (neighborDbs[mid - 1] + neighborDbs[mid]);
    }

    const prominence = Math.max(0, refinedPeakDb - medianDb);
    const peakSpl =
      refinedPeakDb + 10 * Math.log10(windowPowerComp) + 94 + this.calibrationOffset;
    const isCandidate = prominence >= 20 && peakSpl >= 40;
    const dtMs = dtSec * 1000;

    if (isCandidate) {
      this._fbState.silenceMs = 0;
      if (
        this._fbState.candHz > 0 &&
        Math.abs(refinedHz - this._fbState.candHz) <= 30
      ) {
        this._fbState.durationMs += dtMs;
      } else {
        this._fbState.durationMs = dtMs;
        this._fbState.detected = false;
      }
      this._fbState.candHz = refinedHz;
      this._fbState.candProm = prominence;
      if (this._fbState.durationMs >= 300) {
        this._fbState.detected = true;
      }
    } else if (this._fbState.detected) {
      this._fbState.silenceMs += dtMs;
      if (this._fbState.silenceMs >= 150) {
        this._resetFeedbackState();
      }
    } else {
      this._resetFeedbackState();
    }

    const feedback = {
      detected: Boolean(this._fbState.detected),
      hz:
        this._fbState.detected && Number.isFinite(this._fbState.candHz)
          ? Math.round(this._fbState.candHz)
          : 0,
      prominence:
        this._fbState.detected && Number.isFinite(this._fbState.candProm)
          ? Math.round(this._fbState.candProm * 10) / 10
          : 0,
      durationMs: Number.isFinite(this._fbState.durationMs)
        ? Math.round(this._fbState.durationMs)
        : 0
    };

    return {
      bands: new Float32Array(this.bands),
      peaks: new Float32Array(this.peaks),
      spl,
      dbSPL: spl,
      peakDb,
      crest,
      cf: crest,
      centroid,
      usmr,
      stress,
      feedback,
      spectrum: this.spectrumBuffer,
      binHz,
      sampleRate: sr,
      active: true
    };
  }
}

if (typeof window !== 'undefined') {
  window.DSPEngine = DSPEngine;
}
