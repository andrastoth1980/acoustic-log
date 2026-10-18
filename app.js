if (typeof window === 'undefined') {
  const CACHE_NAME = 'acousticlog-pwa-v2';
  const CORE_ASSETS = [
    './',
    './index.html',
    './style.css',
    './i18n.js',
    './dsp-engine.js',
    './app.js',
    './manifest.json'
  ];
  const CDN_ASSETS = ['https://cdn.tailwindcss.com'];

  self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        for (const url of CORE_ASSETS) {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res && res.ok) {
              await cache.put(url, res);
            }
          } catch (_) {
            try {
              await cache.add(url);
            } catch (__) {}
          }
        }
        for (const cdnUrl of CDN_ASSETS) {
          try {
            const req = new Request(cdnUrl, { mode: 'no-cors' });
            const res = await fetch(req);
            await cache.put(cdnUrl, res);
          } catch (_) {}
        }
      })
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
          )
        )
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let isSameOrigin = false;
    try {
      const url = new URL(req.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      isSameOrigin = url.origin === self.location.origin;
    } catch (_) {
      return;
    }

    if (isSameOrigin) {
      // Network-first with cache fallback for same-origin app files so GitHub Pages updates
      // are picked up immediately when online, while working 100% offline from cache.
      event.respondWith(
        fetch(req)
          .then((netRes) => {
            if (netRes && netRes.status === 200) {
              const copy = netRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
            }
            return netRes;
          })
          .catch(() =>
            caches.match(req).then((cached) => cached || caches.match('./index.html'))
          )
      );
    } else {
      // Cache-first with background refresh for external CDN assets
      event.respondWith(
        caches.match(req).then((cached) => {
          const networkFetch = fetch(req)
            .then((netRes) => {
              if (netRes && (netRes.status === 200 || netRes.type === 'opaque')) {
                const copy = netRes.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
              }
              return netRes;
            })
            .catch(() => cached);
          return cached || networkFetch;
        })
      );
    }
  });
} else {
  const STORAGE_KEY_LOGS = 'acousticlog_v1_logs';
  const STORAGE_KEY_LAST_CTX = 'acousticlog_last_ctx';
  const STORAGE_KEY_DEVICE = 'acousticlog_device';
  const STORAGE_KEY_FITTINGS = 'acousticlog_fittings';
  const SYMPTOM_IDS = ['sharp', 'masking', 'impulses', 'reverb', 'occlusion', 'whistle'];
  const ENV_IDS = ['restaurant', 'street', 'office', 'home_tv', 'store'];
  const PROGRAM_IDS = ['auto', 'quiet', 'noise', 'music', 'phone', 'other', 'unknown'];
  const VOLUME_STEPS = [-3, -2, -1, 0, 1, 2, 3];
  const DEVICE_BRANDS = {
    unknown: null,
    phonak: 'Phonak',
    oticon: 'Oticon',
    signia: 'Signia',
    widex: 'Widex',
    resound: 'ReSound',
    starkey: 'Starkey',
    unitron: 'Unitron',
    bernafon: 'Bernafon',
    rexton: 'Rexton',
    hansaton: 'Hansaton',
    other: null
  };
  const RULE_IDS = [
    'RULE_MPO_HIGH',
    'RULE_TRANSIENT',
    'RULE_MASKING',
    'RULE_OCCLUSION',
    'RULE_REVERB',
    'RULE_LOUD',
    'RULE_FEEDBACK'
  ];
  const MAX_IMPORT_MB = 5;
  const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024;

  // Conversational Speech Banana upper and lower dB SPL limits per 10 audiological bands
  const BANANA_UPPER = [52, 65, 72, 70, 68, 65, 62, 58, 54, 48];
  const BANANA_LOWER = [34, 40, 44, 42, 40, 38, 35, 32, 28, 25];

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBandFreq(hz) {
    return hz >= 1000 ? `${hz / 1000}k` : String(hz);
  }

  function formatMmSs(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function formatDuration(seconds) {
    const val = Number(seconds);
    if (!Number.isFinite(val) || val <= 0) return '';
    if (val >= 60) {
      return formatMmSs(val);
    }
    return `${window.I18N.formatNumber(Math.round(val * 10) / 10, 1)} ${window.I18N.t('common.seconds')}`;
  }

  function formatVolumeStep(volumeStep) {
    if (typeof volumeStep !== 'number' || !Number.isFinite(volumeStep)) {
      return window.I18N.t('volume.unknown');
    }
    const step = Math.round(volumeStep);
    if (step === 0) {
      return window.I18N.t('volume.default');
    }
    return step > 0 ? `+${step}` : String(step);
  }

  function formatContextLine(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const progId = PROGRAM_IDS.includes(ctx.programId) ? ctx.programId : 'unknown';
    const progLabel = window.I18N.t(`program.${progId}`);
    const volLabel = formatVolumeStep(ctx.volumeStep);
    return window.I18N.t('history.context', {
      program: progLabel,
      volume: volLabel
    });
  }

  function formatDeviceLabel(device) {
    const dev = device && typeof device === 'object' ? device : {};
    const brandKey =
      typeof dev.brand === 'string' && dev.brand in DEVICE_BRANDS ? dev.brand : 'unknown';
    const model = typeof dev.model === 'string' ? dev.model.trim() : '';

    let brandStr = '';
    if (brandKey === 'unknown') {
      brandStr = '';
    } else if (brandKey === 'other') {
      brandStr = window.I18N.t('brand.other');
    } else {
      brandStr = DEVICE_BRANDS[brandKey] || '';
    }

    if (brandStr && model) {
      return `${brandStr} ${model}`;
    }
    if (brandStr) {
      return brandStr;
    }
    if (model) {
      return model;
    }
    return window.I18N.t('brand.unknown');
  }

  function formatRuleText(r) {
    if (!r || !r.id) return '';
    if (r.id === 'RULE_FEEDBACK') {
      const hz = Math.round(Number(r.hz) || 0);
      return hz > 0
        ? window.I18N.t('rule.RULE_FEEDBACK.text', { hz })
        : window.I18N.t('rule.RULE_FEEDBACK.text_nohz');
    }
    const displayParams = { ...r };
    if (typeof displayParams.db === 'number' && Number.isFinite(displayParams.db)) {
      displayParams.db = Math.abs(displayParams.db);
    }
    return window.I18N.t(`rule.${r.id}.text`, displayParams);
  }

  function formatDateYMD(timestamp) {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isValidDateYMD(str) {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return false;
    }
    const parts = str.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
    if (!Number.isInteger(month) || month < 1 || month > 12) return false;
    if (!Number.isInteger(day) || day < 1 || day > 31) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day
    );
  }

  function fittingDateToMs(dateStr) {
    if (!isValidDateYMD(dateStr)) return 0;
    const parts = dateStr.split('-');
    return new Date(
      Number(parts[0]),
      Number(parts[1]) - 1,
      Number(parts[2]),
      0,
      0,
      0,
      0
    ).getTime();
  }

  function validateFittingVisit(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.id !== 'string' || v.id.trim().length === 0) return null;
    if (!isValidDateYMD(v.date)) return null;
    let note = '';
    if (v.note !== undefined && v.note !== null) {
      if (typeof v.note !== 'string' || v.note.length > 300) return null;
      note = v.note;
    }
    return {
      id: v.id.trim(),
      date: v.date,
      note
    };
  }

  function formatFittingNote(note) {
    if (!note || typeof note !== 'string') return '';
    return note.startsWith('sample.') ? window.I18N.t(note) : note;
  }

  /**
   * Deterministic Clinical Rule Engine.
   * Pure function of record metrics & symptomIds. Returns language-agnostic ruleTriggers.
   */
  function evaluateRules(record) {
    const metrics = (record && record.metrics) || {};
    const symptoms = Array.isArray(record && record.symptomIds) ? record.symptomIds : [];
    const bands = Array.isArray(metrics.bands) ? metrics.bands : [];
    const centroid = Number(metrics.centroid) || 0;
    const cf = Number(metrics.cf ?? metrics.crest) || 0;
    const usmr = Number(metrics.usmr) || 0;
    const spl = Number(metrics.dbSPL ?? metrics.spl) || 0;

    const triggers = [];

    // 1. RULE_MPO_HIGH: centroid > 2500 Hz or symptom 'sharp'
    if (centroid > 2500 || symptoms.includes('sharp')) {
      const hfCenters = [2000, 3000, 4000, 6000, 8000];
      let loudestBand = 3000;
      let maxHfDb = -Infinity;
      for (let i = 5; i < 10; i++) {
        const val = Number(bands[i]) || 0;
        if (val > maxHfDb) {
          maxHfDb = val;
          loudestBand = DSPEngine.BANDS[i] ? DSPEngine.BANDS[i].center : hfCenters[i - 5];
        }
      }
      const centroidExcess = Math.max(0, (centroid - 2200) / 400);
      const levelExcess = Math.max(0, (maxHfDb - 65) / 4);
      const rawReduction = Math.round(2 + Math.min(6, Math.max(centroidExcess, levelExcess)));
      const clampedMag = Math.max(2, Math.min(8, rawReduction));
      triggers.push({
        id: 'RULE_MPO_HIGH',
        band: loudestBand,
        db: -clampedMag
      });
    }

    // 2. RULE_TRANSIENT: crest > 14 dB or symptom 'impulses'
    if (cf > 14 || symptoms.includes('impulses')) {
      triggers.push({
        id: 'RULE_TRANSIENT',
        cf: Math.round(Math.max(cf, 14.2) * 10) / 10
      });
    }

    // 3. RULE_MASKING: usmr > 6 dB or symptom 'masking'
    if (usmr > 6 || symptoms.includes('masking')) {
      triggers.push({
        id: 'RULE_MASKING',
        usmr: Math.round(Math.max(usmr, 6.2) * 10) / 10
      });
    }

    // 4. RULE_OCCLUSION: symptom 'occlusion' (esp. 250-500 Hz buildup)
    if (symptoms.includes('occlusion')) {
      triggers.push({
        id: 'RULE_OCCLUSION'
      });
    }

    // 5. RULE_REVERB: symptom 'reverb'
    if (symptoms.includes('reverb')) {
      triggers.push({
        id: 'RULE_REVERB'
      });
    }

    // 6. RULE_LOUD: broadband SPL > 80 dB SPL
    if (spl > 80) {
      triggers.push({
        id: 'RULE_LOUD',
        spl: Math.round(spl * 10) / 10
      });
    }

    // 7. RULE_FEEDBACK: feedbackPct >= 10 or symptom 'whistle'
    const feedbackPct = Number(metrics.feedbackPct) || 0;
    const feedbackHz = Math.round(Number(metrics.feedbackHz) || 0);
    if (feedbackPct >= 10 || symptoms.includes('whistle')) {
      triggers.push({
        id: 'RULE_FEEDBACK',
        hz: feedbackHz > 0 ? feedbackHz : 0
      });
    }

    return triggers;
  }

  /**
   * Generates translated clinical insight bullets for a record.
   */
  function getRecordInsights(record) {
    const m = (record && record.metrics) || {};
    const centroid = Math.round(Number(m.centroid) || 0);
    const cf = Math.round((Number(m.cf ?? m.crest) || 0) * 10) / 10;
    const usmr = Math.round((Number(m.usmr) || 0) * 10) / 10;
    const spl = Math.round((Number(m.dbSPL ?? m.spl) || 0) * 10) / 10;
    const feedbackPct = Math.round(Number(m.feedbackPct) || 0);
    const feedbackHz = Math.round(Number(m.feedbackHz) || 0);

    const list = [];
    if (feedbackPct >= 10) {
      list.push(
        window.I18N.t('insight.feedback', {
          hz: feedbackHz > 0 ? feedbackHz : record.dominantBand || 3000,
          pct: feedbackPct
        })
      );
    }
    if (centroid > 2500) {
      list.push(window.I18N.t('insight.sharp_centroid', { hz: centroid }));
    }
    if (cf > 14) {
      list.push(window.I18N.t('insight.impulses', { cf }));
    }
    if (usmr > 6) {
      list.push(window.I18N.t('insight.masking', { usmr }));
    }
    if (spl > 80) {
      list.push(window.I18N.t('insight.loud', { spl }));
    }
    if (list.length === 0) {
      list.push(window.I18N.t('insight.balanced', { spl, cf }));
    }
    return list;
  }

  /**
   * Validates and normalizes a single imported log record.
   * Returns a clean record object or null if invalid.
   */
  function validateLogRecord(rec) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;

    if (typeof rec.id !== 'string' || rec.id.trim().length === 0) return null;
    if (typeof rec.timestamp !== 'number' || !Number.isFinite(rec.timestamp)) return null;
    if (typeof rec.envId !== 'string' || !ENV_IDS.includes(rec.envId)) return null;

    if (
      !Array.isArray(rec.symptomIds) ||
      !rec.symptomIds.every((s) => typeof s === 'string' && SYMPTOM_IDS.includes(s))
    ) {
      return null;
    }

    const m = rec.metrics;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    if (
      !Array.isArray(m.bands) ||
      m.bands.length !== 10 ||
      !m.bands.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return null;
    }

    let peaks;
    if (m.peaks !== undefined) {
      if (
        !Array.isArray(m.peaks) ||
        m.peaks.length !== 10 ||
        !m.peaks.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        return null;
      }
      peaks = m.peaks.map((v) => Number(v));
    } else {
      peaks = m.bands.map((v) => Number(v));
    }

    for (const numKey of [
      'dbSPL',
      'spl',
      'cf',
      'crest',
      'centroid',
      'usmr',
      'stress',
      'feedbackPct',
      'feedbackHz',
      'feedbackProm'
    ]) {
      if (m[numKey] !== undefined && (typeof m[numKey] !== 'number' || !Number.isFinite(m[numKey]))) {
        return null;
      }
    }

    const dbSPL = m.dbSPL !== undefined ? m.dbSPL : m.spl;
    const cf = m.cf !== undefined ? m.cf : m.crest;
    const centroid = m.centroid;
    const usmr = m.usmr;
    const stress = m.stress !== undefined ? m.stress : 0;

    if (
      typeof dbSPL !== 'number' ||
      !Number.isFinite(dbSPL) ||
      typeof cf !== 'number' ||
      !Number.isFinite(cf) ||
      typeof centroid !== 'number' ||
      !Number.isFinite(centroid) ||
      typeof usmr !== 'number' ||
      !Number.isFinite(usmr) ||
      typeof stress !== 'number' ||
      !Number.isFinite(stress)
    ) {
      return null;
    }

    let note = '';
    if (rec.note !== undefined) {
      if (typeof rec.note !== 'string') return null;
      note = rec.note.slice(0, 1000);
    }

    let durationSec;
    if (rec.durationSec !== undefined) {
      if (
        typeof rec.durationSec !== 'number' ||
        !Number.isFinite(rec.durationSec) ||
        rec.durationSec < 0
      ) {
        return null;
      }
      durationSec = rec.durationSec;
    }

    let frameCount;
    if (rec.frameCount !== undefined) {
      if (
        typeof rec.frameCount !== 'number' ||
        !Number.isFinite(rec.frameCount) ||
        rec.frameCount < 0
      ) {
        return null;
      }
      frameCount = Math.round(rec.frameCount);
    }

    const bands = m.bands.map((v) => Number(v));

    let dominantBand;
    if (rec.dominantBand !== undefined && rec.dominantBand !== null) {
      if (
        typeof rec.dominantBand !== 'number' ||
        !Number.isFinite(rec.dominantBand) ||
        rec.dominantBand <= 0
      ) {
        return null;
      }
      dominantBand = rec.dominantBand;
    } else {
      let domIdx = 0;
      let maxB = -Infinity;
      for (let b = 0; b < bands.length; b++) {
        if (bands[b] > maxB) {
          maxB = bands[b];
          domIdx = b;
        }
      }
      dominantBand =
        typeof DSPEngine !== 'undefined' && DSPEngine.BANDS && DSPEngine.BANDS[domIdx]
          ? DSPEngine.BANDS[domIdx].center
          : 1000;
    }

    let ruleTriggers;
    if (rec.ruleTriggers !== undefined && rec.ruleTriggers !== null) {
      if (!Array.isArray(rec.ruleTriggers)) return null;
      ruleTriggers = [];
      for (let i = 0; i < rec.ruleTriggers.length; i++) {
        const trig = rec.ruleTriggers[i];
        if (!trig || typeof trig !== 'object' || Array.isArray(trig)) return null;
        if (typeof trig.id !== 'string' || !RULE_IDS.includes(trig.id)) return null;
        const cleanTrig = { id: trig.id };
        for (const k of ['band', 'db', 'cf', 'usmr', 'spl', 'hz']) {
          if (trig[k] !== undefined) {
            if (typeof trig[k] !== 'number' || !Number.isFinite(trig[k])) return null;
            cleanTrig[k] = trig[k];
          }
        }
        ruleTriggers.push(cleanTrig);
      }
    }

    let cleanContext;
    if (rec.context !== undefined && rec.context !== null) {
      if (typeof rec.context !== 'object' || Array.isArray(rec.context)) return null;
      const progId = rec.context.programId;
      if (typeof progId !== 'string' || !PROGRAM_IDS.includes(progId)) return null;
      const vol = rec.context.volumeStep;
      let cleanVol = null;
      if (vol !== null && vol !== undefined) {
        if (typeof vol !== 'number' || !Number.isFinite(vol) || !VOLUME_STEPS.includes(vol)) {
          return null;
        }
        cleanVol = vol;
      }
      cleanContext = {
        programId: progId,
        volumeStep: cleanVol
      };
    }

    const cleanMetrics = {
      bands,
      peaks,
      dbSPL,
      cf,
      centroid,
      usmr,
      stress
    };

    if (m.feedbackPct !== undefined) {
      cleanMetrics.feedbackPct = Math.max(0, Math.min(100, Math.round(m.feedbackPct)));
    }
    if (m.feedbackHz !== undefined) {
      cleanMetrics.feedbackHz = Math.max(0, Math.round(m.feedbackHz));
    }
    if (m.feedbackProm !== undefined) {
      cleanMetrics.feedbackProm = Math.max(0, Math.round(m.feedbackProm * 10) / 10);
    }

    const cleanRecord = {
      id: rec.id,
      timestamp: rec.timestamp,
      envId: rec.envId,
      symptomIds: Array.from(new Set(rec.symptomIds)),
      note,
      metrics: cleanMetrics,
      dominantBand
    };

    if (cleanContext !== undefined) {
      cleanRecord.context = cleanContext;
    }
    if (durationSec !== undefined) {
      cleanRecord.durationSec = durationSec;
    }
    if (frameCount !== undefined) {
      cleanRecord.frameCount = frameCount;
    }

    cleanRecord.ruleTriggers =
      ruleTriggers !== undefined ? ruleTriggers : evaluateRules(cleanRecord);

    return cleanRecord;
  }

  function createSampleFittings(now = Date.now()) {
    const DAY_MS = 86400 * 1000;
    return [
      {
        id: 'sample-fit-1',
        date: formatDateYMD(now - 10 * DAY_MS),
        note: 'sample.fitting_note'
      }
    ];
  }

  /**
   * Builds 5 realistic clinical sample records (3 before the fitting visit 10 days ago,
   * and 2 after it with clearly improved metrics and lower symptom/rule incidence).
   */
  function createSampleRecords(now = Date.now()) {
    const DAY_MS = 86400 * 1000;
    const samples = [
      {
        id: 'sample-ev-1',
        timestamp: now - 18 * DAY_MS,
        durationSec: 12.4,
        frameCount: 248,
        envId: 'restaurant',
        symptomIds: ['sharp', 'impulses', 'masking'],
        context: { programId: 'noise', volumeStep: 0 },
        note: 'sample.ev1.note',
        metrics: {
          bands: [57.2, 60.5, 63.8, 68.1, 71.4, 76.2, 84.6, 81.3, 74.0, 66.8],
          peaks: [63.0, 66.2, 69.5, 74.0, 78.2, 83.5, 94.8, 91.2, 82.4, 74.1],
          dbSPL: 82.4,
          cf: 17.8,
          centroid: 3190,
          usmr: -3.4,
          stress: 84,
          feedbackPct: 0,
          feedbackHz: 0,
          feedbackProm: 0
        },
        dominantBand: 3000
      },
      {
        id: 'sample-ev-2',
        timestamp: now - 15 * DAY_MS,
        durationSec: 15.0,
        frameCount: 300,
        envId: 'street',
        symptomIds: ['masking', 'sharp'],
        context: { programId: 'auto', volumeStep: 2 },
        note: 'sample.ev2.note',
        metrics: {
          bands: [82.8, 85.4, 80.1, 69.2, 65.8, 62.4, 58.7, 54.9, 49.6, 44.2],
          peaks: [88.9, 91.5, 86.4, 75.1, 71.6, 68.0, 64.2, 60.1, 54.8, 49.0],
          dbSPL: 83.6,
          cf: 10.6,
          centroid: 620,
          usmr: 11.4,
          stress: 76,
          feedbackPct: 0,
          feedbackHz: 0,
          feedbackProm: 0
        },
        dominantBand: 250
      },
      {
        id: 'sample-ev-3',
        timestamp: now - 12 * DAY_MS,
        durationSec: 9.5,
        frameCount: 190,
        envId: 'home_tv',
        symptomIds: ['occlusion', 'reverb'],
        context: { programId: 'quiet', volumeStep: 0 },
        note: 'sample.ev3.note',
        metrics: {
          bands: [56.4, 73.2, 71.5, 62.0, 57.8, 53.6, 49.2, 45.1, 41.0, 37.4],
          peaks: [62.1, 79.4, 77.6, 68.2, 63.5, 59.1, 54.4, 50.2, 45.8, 41.9],
          dbSPL: 68.5,
          cf: 11.2,
          centroid: 780,
          usmr: 7.8,
          stress: 52,
          feedbackPct: 0,
          feedbackHz: 0,
          feedbackProm: 0
        },
        dominantBand: 250
      },
      {
        id: 'sample-ev-4',
        timestamp: now - 6 * DAY_MS,
        durationSec: 11.0,
        frameCount: 220,
        envId: 'restaurant',
        symptomIds: ['sharp'],
        context: { programId: 'noise', volumeStep: 0 },
        note: 'sample.after1',
        metrics: {
          bands: [52.0, 55.4, 58.6, 62.1, 64.5, 66.8, 69.2, 66.0, 60.4, 54.2],
          peaks: [57.2, 60.5, 63.8, 67.4, 69.8, 72.1, 75.0, 71.5, 65.8, 59.0],
          dbSPL: 71.4,
          cf: 11.8,
          centroid: 2120,
          usmr: -2.1,
          stress: 38,
          feedbackPct: 0,
          feedbackHz: 0,
          feedbackProm: 0
        },
        dominantBand: 3000
      },
      {
        id: 'sample-ev-5',
        timestamp: now - 2 * DAY_MS,
        durationSec: 10.2,
        frameCount: 204,
        envId: 'restaurant',
        symptomIds: ['masking'],
        context: { programId: 'noise', volumeStep: 0 },
        note: 'sample.after2',
        metrics: {
          bands: [60.2, 62.8, 63.5, 64.0, 63.2, 61.5, 58.9, 55.4, 50.8, 46.1],
          peaks: [65.0, 67.4, 68.2, 69.1, 68.0, 66.2, 63.5, 59.8, 55.0, 50.2],
          dbSPL: 68.2,
          cf: 9.6,
          centroid: 1480,
          usmr: 2.4,
          stress: 29,
          feedbackPct: 0,
          feedbackHz: 0,
          feedbackProm: 0
        },
        dominantBand: 1000
      }
    ];

    return samples.map((rec) => {
      rec.ruleTriggers = evaluateRules(rec);
      return rec;
    });
  }

  const AcousticApp = {
    engine: null,
    activeTab: 'analyzer',
    viewMode: 'bars', // 'bars' | 'waterfall'
    showBanana: true,
    logs: [],
    fittings: [],
    selectedFittingId: null,
    device: { brand: 'unknown', model: '' },

    // Canvas & Waterfall offscreen state
    canvas: null,
    ctx: null,
    cssWidth: 800,
    cssHeight: 340,
    dpr: 1,
    waterfallCanvas: null,
    waterfallCtx: null,

    // Capture state (manual start/stop with running aggregates)
    isCapturing: false,
    captureTimer: null,
    captureStats: null,
    pendingCapture: null,
    lastFocusedElement: null,
    toastTimer: null,

    init() {
      if (
        'serviceWorker' in navigator &&
        window.isSecureContext &&
        (window.location.protocol === 'https:' ||
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1' ||
          window.location.hostname === '[::1]')
      ) {
        navigator.serviceWorker.register('./app.js').catch(() => {});
      }

      window.I18N.init();
      this.engine = new window.DSPEngine();

      const hadStoredLogs = this._loadLogsFromStorage();
      this._loadFittingsFromStorage(hadStoredLogs);
      this._loadDeviceFromStorage();
      this._initDOMRefs();
      this._syncLangButtons();
      this._syncCalibrationUI();
      this._syncDeviceUI();
      this._bindEvents();
      this._setupCanvas();

      this.updateStatusUI();
      this.renderHistory();
      this.renderReport();

      this._startRenderLoop();
    },

    _loadLogsFromStorage() {
      let loaded = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY_LOGS);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            loaded = parsed;
          }
        }
      } catch (e) {
        loaded = null;
      }

      if (!loaded || loaded.length === 0) {
        this.logs = createSampleRecords();
        this._saveLogsToStorage();
        return false;
      } else {
        this.logs = loaded.map((item) => {
          if (!Array.isArray(item.ruleTriggers) || item.ruleTriggers.length === 0) {
            item.ruleTriggers = evaluateRules(item);
          }
          return item;
        });
        return true;
      }
    },

    _saveLogsToStorage() {
      try {
        localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(this.logs));
      } catch (e) {
        // Ignore quota or private browsing errors
      }
    },

    _loadFittingsFromStorage(hadStoredLogs) {
      let loaded = null;
      let rawPresent = false;
      try {
        const raw = localStorage.getItem(STORAGE_KEY_FITTINGS);
        if (raw !== null) {
          rawPresent = true;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            loaded = parsed.map((v) => validateFittingVisit(v)).filter(Boolean);
          }
        }
      } catch (e) {
        loaded = null;
      }

      if (rawPresent && Array.isArray(loaded)) {
        this.fittings = loaded.sort((a, b) => b.date.localeCompare(a.date));
      } else if (!hadStoredLogs) {
        this.fittings = createSampleFittings();
        this._saveFittingsToStorage();
      } else {
        this.fittings = [];
      }
    },

    _saveFittingsToStorage() {
      try {
        localStorage.setItem(STORAGE_KEY_FITTINGS, JSON.stringify(this.fittings));
      } catch (e) {
        // Ignore storage errors
      }
    },

    _loadDeviceFromStorage() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_DEVICE);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const brand =
              typeof parsed.brand === 'string' && parsed.brand in DEVICE_BRANDS
                ? parsed.brand
                : 'unknown';
            const model =
              typeof parsed.model === 'string' ? parsed.model.trim().slice(0, 120) : '';
            this.device = { brand, model };
          }
        }
      } catch (e) {
        this.device = { brand: 'unknown', model: '' };
      }
    },

    _saveDeviceToStorage() {
      try {
        localStorage.setItem(STORAGE_KEY_DEVICE, JSON.stringify(this.device));
      } catch (e) {
        // Ignore storage errors
      }
    },

    _syncDeviceUI() {
      const brandEl = document.getElementById('device-brand');
      const modelEl = document.getElementById('device-model');
      if (brandEl) {
        brandEl.value =
          this.device && this.device.brand in DEVICE_BRANDS ? this.device.brand : 'unknown';
      }
      if (modelEl) {
        modelEl.value = (this.device && this.device.model) || '';
      }
    },

    _loadLastContext() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_LAST_CTX);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const programId = PROGRAM_IDS.includes(parsed.programId)
              ? parsed.programId
              : 'unknown';
            const volumeStep =
              typeof parsed.volumeStep === 'number' &&
              Number.isFinite(parsed.volumeStep) &&
              VOLUME_STEPS.includes(parsed.volumeStep)
                ? parsed.volumeStep
                : null;
            return { programId, volumeStep };
          }
        }
      } catch (e) {
        // Ignore storage errors
      }
      return { programId: 'unknown', volumeStep: null };
    },

    _saveLastContext(ctx) {
      try {
        localStorage.setItem(STORAGE_KEY_LAST_CTX, JSON.stringify(ctx));
      } catch (e) {
        // Ignore storage errors
      }
    },

    _initDOMRefs() {
      this.canvas = document.getElementById('spectrum-canvas');
      if (this.canvas) {
        this.ctx = this.canvas.getContext('2d');
      }

      this.waterfallCanvas = document.createElement('canvas');
      this.waterfallCanvas.width = 600;
      this.waterfallCanvas.height = 260;
      this.waterfallCtx = this.waterfallCanvas.getContext('2d');
      if (this.waterfallCtx) {
        this.waterfallCtx.fillStyle = '#070a12';
        this.waterfallCtx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
      }
    },

    _syncLangButtons() {
      const current = window.I18N.current;
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        const code = btn.getAttribute('data-lang');
        if (code === current) {
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
        } else {
          btn.classList.remove('active');
          btn.setAttribute('aria-pressed', 'false');
        }
      });
    },

    _syncCalibrationUI() {
      const cal = this.engine.getCalibration();
      const slider = document.getElementById('cal-slider');
      const valEl = document.getElementById('cal-value');
      if (slider) slider.value = String(cal);
      if (valEl) valEl.textContent = cal > 0 ? `+${cal}` : String(cal);
    },

    _bindEvents() {
      // Language buttons
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const lang = btn.getAttribute('data-lang');
          if (lang) window.I18N.setLang(lang);
        });
      });

      // Global i18n change listener
      window.addEventListener('i18n:changed', () => {
        this._syncLangButtons();
        this.updateStatusUI();
        this._updateAnalyzerButtonsUI();
        if (this.isCapturing && this.captureStats) {
          const elapsedSec = (Date.now() - this.captureStats.startTime) / 1000;
          this._updateCaptureProgressUI(elapsedSec, this.captureStats.frameCount);
        }
        this.renderHistory();
        this.renderReport();
        if (this.pendingCapture && !document.getElementById('capture-modal').classList.contains('hidden')) {
          this._renderModalSummary();
        }
      });

      // Navigation tabs
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-tab');
          if (tab) this.switchTab(tab);
        });
      });

      // Microphone toggle
      const btnMic = document.getElementById('btn-mic');
      if (btnMic) {
        btnMic.addEventListener('click', () => this.toggleMic());
      }

      // View mode toggle (Bars <-> Waterfall)
      const btnView = document.getElementById('btn-view-toggle');
      if (btnView) {
        btnView.addEventListener('click', () => {
          this.viewMode = this.viewMode === 'bars' ? 'waterfall' : 'bars';
          this._updateAnalyzerButtonsUI();
        });
      }

      // Speech Banana toggle
      const btnBanana = document.getElementById('btn-banana-toggle');
      if (btnBanana) {
        btnBanana.addEventListener('click', () => {
          this.showBanana = !this.showBanana;
          this._updateAnalyzerButtonsUI();
        });
      }

      // Peak reset
      const btnPeakReset = document.getElementById('btn-peak-reset');
      if (btnPeakReset) {
        btnPeakReset.addEventListener('click', () => {
          this.engine.resetPeaks();
        });
      }

      // Calibration slider
      const calSlider = document.getElementById('cal-slider');
      if (calSlider) {
        calSlider.addEventListener('input', (e) => {
          const applied = this.engine.setCalibration(parseFloat(e.target.value));
          const valEl = document.getElementById('cal-value');
          if (valEl) valEl.textContent = applied > 0 ? `+${applied}` : String(applied);
        });
      }

      // Synth controls
      const btnSynthRest = document.getElementById('btn-synth-restaurant');
      if (btnSynthRest) {
        btnSynthRest.addEventListener('click', () => {
          this.engine.startSynth('restaurant');
          this.updateStatusUI();
        });
      }

      const btnSynthTraf = document.getElementById('btn-synth-traffic');
      if (btnSynthTraf) {
        btnSynthTraf.addEventListener('click', () => {
          this.engine.startSynth('traffic');
          this.updateStatusUI();
        });
      }

      const btnSynthFeedback = document.getElementById('btn-synth-feedback');
      if (btnSynthFeedback) {
        btnSynthFeedback.addEventListener('click', () => {
          this.engine.startSynth('feedback');
          this.updateStatusUI();
        });
      }

      const btnSynthStop = document.getElementById('btn-synth-stop');
      if (btnSynthStop) {
        btnSynthStop.addEventListener('click', () => {
          this.engine.stop();
          if (this.isCapturing) {
            this._handleSourceStoppedDuringCapture();
          }
          this.updateStatusUI();
        });
      }

      // Start/Stop Capture button
      const btnCapture = document.getElementById('btn-capture');
      if (btnCapture) {
        btnCapture.addEventListener('click', () => {
          if (this.isCapturing) {
            this._finishCapture();
          } else {
            this.startCapture();
          }
        });
      }

      // Modal chips & buttons
      document.querySelectorAll('input[name="symptom"]').forEach((input) => {
        input.addEventListener('change', () => {
          this._syncModalChips();
          this._renderModalSummary();
        });
      });

      document.querySelectorAll('input[name="env"]').forEach((input) => {
        input.addEventListener('change', () => {
          this._syncModalChips();
        });
      });

      document.querySelectorAll('input[name="program"]').forEach((input) => {
        input.addEventListener('change', () => {
          this._syncModalChips();
        });
      });

      const btnModalCancel = document.getElementById('btn-modal-cancel');
      if (btnModalCancel) {
        btnModalCancel.addEventListener('click', () => this.closeModal());
      }

      const btnModalSave = document.getElementById('btn-modal-save');
      if (btnModalSave) {
        btnModalSave.addEventListener('click', () => this.saveModalCapture());
      }

      const modalBackdrop = document.getElementById('capture-modal');
      if (modalBackdrop) {
        modalBackdrop.addEventListener('click', (e) => {
          if (e.target === modalBackdrop) this.closeModal();
        });
      }

      document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('capture-modal');
        if (!modal || modal.classList.contains('hidden')) return;
        if (e.key === 'Escape') {
          this.closeModal();
        } else if (e.key === 'Tab') {
          const focusables = modal.querySelectorAll(
            'input, select, textarea, button:not([disabled])'
          );
          if (focusables.length > 0) {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      });

      // History buttons
      const btnExportJson = document.getElementById('btn-export-json');
      if (btnExportJson) {
        btnExportJson.addEventListener('click', () => this.exportLogsJson());
      }

      const btnImportJson = document.getElementById('btn-import-json');
      const importFileInput = document.getElementById('import-file');
      if (btnImportJson && importFileInput) {
        btnImportJson.addEventListener('click', () => {
          importFileInput.click();
        });
      }
      if (importFileInput) {
        importFileInput.addEventListener('change', (e) => {
          const file = e.target.files && e.target.files[0];
          if (file) {
            this.importLogsFromFile(file);
          }
          e.target.value = '';
        });
      }

      const btnLoadSample = document.getElementById('btn-load-sample');
      if (btnLoadSample) {
        btnLoadSample.addEventListener('click', () => {
          const now = Date.now();
          this.logs = createSampleRecords(now);
          this._saveLogsToStorage();
          this.fittings = createSampleFittings(now);
          this._saveFittingsToStorage();
          this.selectedFittingId = null;
          this.renderHistory();
          this.renderReport();
          this.showToast(window.I18N.t('sample.loaded_toast'));
        });
      }

      const btnClearAll = document.getElementById('btn-clear-all');
      if (btnClearAll) {
        btnClearAll.addEventListener('click', () => {
          if (this.logs.length === 0) return;
          if (window.confirm(window.I18N.t('history.clear_confirm'))) {
            this.logs = [];
            this._saveLogsToStorage();
            this.renderHistory();
            this.renderReport();
          }
        });
      }

      // Device profile save button
      const btnDeviceSave = document.getElementById('btn-device-save');
      if (btnDeviceSave) {
        btnDeviceSave.addEventListener('click', () => {
          const brandEl = document.getElementById('device-brand');
          const modelEl = document.getElementById('device-model');
          const rawBrand = brandEl ? brandEl.value : 'unknown';
          const brand = rawBrand in DEVICE_BRANDS ? rawBrand : 'unknown';
          const model = modelEl ? modelEl.value.trim().slice(0, 120) : '';
          this.device = { brand, model };
          this._saveDeviceToStorage();
          this.renderReport();
          this.showToast(window.I18N.t('device.saved'));
        });
      }

      // Fitting visits add & compare selector
      const btnFittingAdd = document.getElementById('btn-fitting-add');
      if (btnFittingAdd) {
        btnFittingAdd.addEventListener('click', () => this.addFittingVisit());
      }

      const compareSelect = document.getElementById('compare-select');
      if (compareSelect) {
        compareSelect.addEventListener('change', (e) => {
          this.selectedFittingId = e.target.value || null;
          this._renderFittingComparison();
        });
      }

      // Report print button
      const btnPrint = document.getElementById('btn-print');
      if (btnPrint) {
        btnPrint.addEventListener('click', () => {
          this.renderReport();
          window.print();
        });
      }

      // Resize handling
      window.addEventListener('resize', () => this._resizeCanvas());
    },

    switchTab(tabId) {
      this.activeTab = tabId;
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        const isTarget = btn.getAttribute('data-tab') === tabId;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      });

      const views = {
        analyzer: document.getElementById('view-analyzer'),
        history: document.getElementById('view-history'),
        report: document.getElementById('view-report')
      };

      Object.keys(views).forEach((key) => {
        if (views[key]) {
          views[key].classList.toggle('hidden', key !== tabId);
        }
      });

      if (tabId === 'analyzer') {
        this._resizeCanvas();
      } else if (tabId === 'history') {
        this.renderHistory();
      } else if (tabId === 'report') {
        this.renderReport();
      }
    },

    async toggleMic() {
      if (this.engine.getSource() === 'mic') {
        this.engine.stop();
        if (this.isCapturing) {
          this._handleSourceStoppedDuringCapture();
        }
        this.updateStatusUI();
        return;
      }

      try {
        await this.engine.startMic();
        this.updateStatusUI();
      } catch (err) {
        this.updateStatusUI();
        const code = err && err.code;
        let msgKey = 'analyzer.err.generic';
        if (code === 'denied') msgKey = 'analyzer.err.denied';
        else if (code === 'unsupported') msgKey = 'analyzer.err.unsupported';
        else if (code === 'insecure') msgKey = 'analyzer.err.https';
        this.showToast(window.I18N.t(msgKey), true);
      }
    },

    _updateAnalyzerButtonsUI() {
      const btnView = document.getElementById('btn-view-toggle');
      if (btnView) {
        const key = this.viewMode === 'bars' ? 'analyzer.view.waterfall' : 'analyzer.view.bars';
        btnView.setAttribute('data-i18n', key);
        btnView.textContent = window.I18N.t(key);
      }

      const btnBanana = document.getElementById('btn-banana-toggle');
      if (btnBanana) {
        if (this.showBanana) {
          btnBanana.className =
            'px-3 py-2 rounded-lg text-xs sm:text-sm font-medium bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 border border-teal-500/40';
        } else {
          btnBanana.className =
            'px-3 py-2 rounded-lg text-xs sm:text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700';
        }
      }
    },

    updateStatusUI() {
      const src = this.engine.getSource();
      const dot = document.getElementById('status-dot');
      const text = document.getElementById('status-text');
      const btnMic = document.getElementById('btn-mic');
      const btnMicSpan = btnMic ? btnMic.querySelector('span[data-i18n]') : null;

      if (src === 'mic') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
        if (text) {
          text.setAttribute('data-i18n', 'analyzer.status.listening');
          text.textContent = window.I18N.t('analyzer.status.listening');
        }
        if (btnMic) {
          btnMic.className =
            'px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold bg-rose-500 hover:bg-rose-400 text-white shadow-lg shadow-rose-500/20 flex items-center gap-2';
        }
        if (btnMicSpan) {
          btnMicSpan.setAttribute('data-i18n', 'analyzer.stop');
          btnMicSpan.textContent = window.I18N.t('analyzer.stop');
        }
      } else if (
        src === 'synth:restaurant' ||
        src === 'synth:traffic' ||
        src === 'synth:feedback'
      ) {
        if (dot) {
          dot.className =
            src === 'synth:feedback'
              ? 'w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse'
              : 'w-2 h-2 rounded-full bg-cyan-400 animate-pulse';
        }
        if (text) {
          if (src === 'synth:feedback') {
            text.removeAttribute('data-i18n');
            text.textContent = `${window.I18N.t('analyzer.status.synth')} — ${window.I18N.t(
              'synth.feedback'
            )}`;
          } else {
            const statusKey =
              src === 'synth:restaurant'
                ? 'analyzer.status.synth_restaurant'
                : 'analyzer.status.synth_traffic';
            text.setAttribute('data-i18n', statusKey);
            text.textContent = window.I18N.t(statusKey);
          }
        }
        if (btnMic) {
          btnMic.className =
            'px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 flex items-center gap-2';
        }
        if (btnMicSpan) {
          btnMicSpan.setAttribute('data-i18n', 'analyzer.start_mic');
          btnMicSpan.textContent = window.I18N.t('analyzer.start_mic');
        }
      } else {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-500';
        if (text) {
          text.setAttribute('data-i18n', 'analyzer.status.idle');
          text.textContent = window.I18N.t('analyzer.status.idle');
        }
        if (btnMic) {
          btnMic.className =
            'px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 flex items-center gap-2';
        }
        if (btnMicSpan) {
          btnMicSpan.setAttribute('data-i18n', 'analyzer.start_mic');
          btnMicSpan.textContent = window.I18N.t('analyzer.start_mic');
        }
      }
    },

    _setupCanvas() {
      this._resizeCanvas();
      if (typeof ResizeObserver !== 'undefined' && this.canvas && this.canvas.parentElement) {
        const ro = new ResizeObserver(() => this._resizeCanvas());
        ro.observe(this.canvas.parentElement);
      }
    },

    _resizeCanvas() {
      if (!this.canvas || !this.ctx) return;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const w = Math.max(300, Math.floor(rect.width));
      const h = Math.max(220, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
      }
      this.cssWidth = w;
      this.cssHeight = h;
      this.dpr = dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    _startRenderLoop() {
      const step = () => {
        const frame = this.engine.getFrameData();
        this._updateMetricCards(frame);
        if (this.activeTab === 'analyzer') {
          if (this.viewMode === 'waterfall') {
            this._drawWaterfall(frame);
          } else {
            this._drawBars(frame);
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },

    _updateMetricCards(frame) {
      const elSpl = document.getElementById('m-spl');
      const elCrest = document.getElementById('m-crest');
      const elCentroid = document.getElementById('m-centroid');
      const elUsmr = document.getElementById('m-usmr');
      const elStress = document.getElementById('m-stress');
      const elStressLevel = document.getElementById('m-stress-level');
      const elStressBar = document.getElementById('m-stress-bar');
      const elFeedback = document.getElementById('m-feedback');

      if (elSpl) elSpl.textContent = window.I18N.formatNumber(frame.spl, 1);
      if (elCrest) elCrest.textContent = window.I18N.formatNumber(frame.crest, 1);
      if (elCentroid) elCentroid.textContent = window.I18N.formatNumber(Math.round(frame.centroid), 0);
      if (elUsmr) {
        const prefix = frame.usmr > 0 ? '+' : '';
        elUsmr.textContent = prefix + window.I18N.formatNumber(frame.usmr, 1);
      }
      if (elStress) elStress.textContent = String(frame.stress);
      if (elStressBar) {
        elStressBar.style.width = `${frame.stress}%`;
        if (elStressBar.parentElement) {
          elStressBar.parentElement.setAttribute('aria-valuenow', String(frame.stress));
        }
      }

      if (elStressLevel) {
        let levelKey = 'metric.level.low';
        let colorCls = 'text-[11px] font-semibold text-emerald-400';
        if (frame.stress >= 75) {
          levelKey = 'metric.level.severe';
          colorCls = 'text-[11px] font-semibold text-rose-400';
        } else if (frame.stress >= 50) {
          levelKey = 'metric.level.high';
          colorCls = 'text-[11px] font-semibold text-amber-400';
        } else if (frame.stress >= 25) {
          levelKey = 'metric.level.moderate';
          colorCls = 'text-[11px] font-semibold text-cyan-300';
        }
        elStressLevel.className = colorCls;
        elStressLevel.setAttribute('data-i18n', levelKey);
        elStressLevel.textContent = window.I18N.t(levelKey);
      }

      if (elFeedback) {
        const fb = frame.feedback;
        if (fb && fb.detected && fb.hz > 0) {
          elFeedback.removeAttribute('data-i18n');
          elFeedback.className = 'text-base sm:text-lg font-bold font-mono text-fuchsia-400';
          elFeedback.textContent = window.I18N.t('metric.feedback.detected', {
            hz: Math.round(fb.hz)
          });
        } else {
          elFeedback.setAttribute('data-i18n', 'metric.feedback.none');
          elFeedback.className = 'text-base sm:text-lg font-bold font-mono text-emerald-400';
          elFeedback.textContent = window.I18N.t('metric.feedback.none');
        }
      }
    },

    _drawBars(frame) {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.cssWidth;
      const H = this.cssHeight;

      ctx.clearRect(0, 0, W, H);

      const padL = 46;
      const padR = 18;
      const padT = 22;
      const padB = 38;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const minDb = 20;
      const maxDb = 110;

      const dbToY = (db) => {
        const clamped = Math.max(minDb, Math.min(maxDb, db));
        return padT + plotH * (1 - (clamped - minDb) / (maxDb - minDb));
      };

      const nBands = DSPEngine.BANDS.length;
      const colW = plotW / nBands;
      const bandToX = (idx) => padL + (idx + 0.5) * colW;

      // Horizontal dB grid lines
      ctx.lineWidth = 1;
      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const gridDbs = [20, 40, 60, 80, 100];
      for (let i = 0; i < gridDbs.length; i++) {
        const db = gridDbs[i];
        const y = dbToY(db);
        ctx.strokeStyle = db === 80 ? 'rgba(244, 63, 94, 0.28)' : 'rgba(51, 65, 85, 0.45)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();

        ctx.fillStyle = db === 80 ? '#fda4af' : '#64748b';
        ctx.fillText(`${db}`, padL - 7, y);
      }

      // Y-axis title
      ctx.save();
      ctx.translate(13, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(window.I18N.t('analyzer.axis.db'), 0, 0);
      ctx.restore();

      // Semi-transparent Speech Banana polygon & phoneme map (drawn behind or over bars)
      if (this.showBanana) {
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < nBands; i++) {
          const x = bandToX(i);
          const y = dbToY(BANANA_UPPER[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = nBands - 1; i >= 0; i--) {
          const x = bandToX(i);
          const y = dbToY(BANANA_LOWER[i]);
          ctx.lineTo(x, y);
        }
        ctx.closePath();

        const bananaGrad = ctx.createLinearGradient(0, dbToY(72), 0, dbToY(28));
        bananaGrad.addColorStop(0, 'rgba(20, 184, 166, 0.22)');
        bananaGrad.addColorStop(1, 'rgba(6, 182, 212, 0.10)');
        ctx.fillStyle = bananaGrad;
        ctx.fill();

        ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Find dominant band index
      let domIdx = -1;
      let maxBandVal = 45;
      for (let i = 0; i < nBands; i++) {
        if (frame.bands[i] > maxBandVal) {
          maxBandVal = frame.bands[i];
          domIdx = i;
        }
      }

      // Draw 10-band bars and Peak-Hold markers
      const barW = Math.max(12, Math.min(48, colW * 0.58));

      for (let i = 0; i < nBands; i++) {
        const cx = bandToX(i);
        const bx = cx - barW / 2;
        const val = frame.bands[i];
        const peak = frame.peaks[i];
        const yVal = dbToY(val);
        const barH = Math.max(2, padT + plotH - yVal);

        // Problem band if it exceeds banana ceiling significantly & >68 dB or is dominant at loud level
        const isOverload =
          val > 68 && (i === domIdx || val > BANANA_UPPER[i] + 8);

        const grad = ctx.createLinearGradient(0, yVal, 0, padT + plotH);
        if (isOverload) {
          grad.addColorStop(0, '#fb7185');
          grad.addColorStop(1, 'rgba(225, 29, 72, 0.45)');
        } else {
          grad.addColorStop(0, '#22d3ee');
          grad.addColorStop(1, 'rgba(8, 145, 178, 0.35)');
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, yVal, barW, barH, [4, 4, 0, 0]);
        } else {
          ctx.rect(bx, yVal, barW, barH);
        }
        ctx.fill();

        // Top border highlight on bar
        ctx.strokeStyle = isOverload ? '#fda4af' : '#67e8f9';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx, yVal);
        ctx.lineTo(bx + barW, yVal);
        ctx.stroke();

        // Peak-hold marker
        if (peak > minDb + 1) {
          const yPeak = dbToY(peak);
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(bx - 2, yPeak);
          ctx.lineTo(bx + barW + 2, yPeak);
          ctx.stroke();
        }

        // Value label above bar when active
        if (frame.active && val > minDb + 2) {
          ctx.fillStyle = isOverload ? '#fecdd3' : '#cbd5e1';
          ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(Math.round(val), cx, Math.max(padT + 10, Math.min(yVal - 4, dbToY(peak) - 4)));
        }

        // X-axis frequency label
        const freqHz = DSPEngine.BANDS[i].center;
        ctx.fillStyle = isOverload ? '#fb7185' : '#94a3b8';
        ctx.font = isOverload
          ? 'bold 11px ui-monospace, SFMono-Regular, monospace'
          : '11px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(formatBandFreq(freqHz), cx, padT + plotH + 8);

        ctx.fillStyle = '#475569';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('Hz', cx, padT + plotH + 21);
      }

      // Phoneme labels inside Speech Banana
      if (this.showBanana) {
        const phonemes = [
          { key: 'banana.nasals', bandIdx: 1.2, db: 56 },
          { key: 'banana.vowels', bandIdx: 2.3, db: 63 },
          { key: 'banana.voiced', bandIdx: 2.8, db: 48 },
          { key: 'banana.sonorants', bandIdx: 4.1, db: 56 },
          { key: 'banana.plosives', bandIdx: 5.5, db: 45 },
          { key: 'banana.fricatives_mid', bandIdx: 6.4, db: 54 },
          { key: 'banana.fricatives_high', bandIdx: 7.8, db: 42 }
        ];

        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < phonemes.length; i++) {
          const p = phonemes[i];
          const px = padL + (p.bandIdx + 0.5) * colW;
          const py = dbToY(p.db);
          const label = window.I18N.t(p.key);
          const metrics = ctx.measureText(label);
          const pillW = metrics.width + 10;
          const pillH = 16;

          ctx.fillStyle = 'rgba(9, 13, 22, 0.72)';
          ctx.fillRect(px - pillW / 2, py - pillH / 2, pillW, pillH);
          ctx.strokeStyle = 'rgba(45, 212, 191, 0.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - pillW / 2, py - pillH / 2, pillW, pillH);

          ctx.fillStyle = '#99f6e4';
          ctx.fillText(label, px, py);
        }

        // Banana title badge + environmental region hints
        ctx.textAlign = 'left';
        ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#2dd4bf';
        ctx.fillText(`🍌 ${window.I18N.t('banana.title')}`, padL + 6, dbToY(75));

        ctx.fillStyle = 'rgba(248, 113, 113, 0.75)';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(`▲ ${window.I18N.t('banana.env_low')}`, bandToX(0) - colW * 0.4, dbToY(86));

        ctx.textAlign = 'right';
        ctx.fillText(`▲ ${window.I18N.t('banana.env_high')}`, bandToX(8) + colW * 0.4, dbToY(86));
      }

      // Idle state overlay hint when audio is inactive
      if (!frame.active) {
        this._drawIdleOverlay(ctx, W, H);
      }
    },

    _drawWaterfall(frame) {
      const ctx = this.ctx;
      if (!ctx || !this.waterfallCanvas || !this.waterfallCtx) return;
      const W = this.cssWidth;
      const H = this.cssHeight;

      const padL = 46;
      const padR = 18;
      const padT = 20;
      const padB = 38;
      const plotW = Math.max(100, Math.floor(W - padL - padR));
      const plotH = Math.max(80, Math.floor(H - padT - padB));

      if (this.waterfallCanvas.width !== plotW || this.waterfallCanvas.height !== plotH) {
        const temp = document.createElement('canvas');
        temp.width = this.waterfallCanvas.width;
        temp.height = this.waterfallCanvas.height;
        temp.getContext('2d').drawImage(this.waterfallCanvas, 0, 0);

        this.waterfallCanvas.width = plotW;
        this.waterfallCanvas.height = plotH;
        this.waterfallCtx.fillStyle = '#070a12';
        this.waterfallCtx.fillRect(0, 0, plotW, plotH);
        this.waterfallCtx.drawImage(temp, 0, 0, plotW, plotH);
      }

      if (frame.active && frame.spectrum && frame.spectrum.length > 0) {
        const wCtx = this.waterfallCtx;
        // Shift existing spectrogram down by 2 px
        wCtx.drawImage(this.waterfallCanvas, 0, 0, plotW, plotH - 2, 0, 2, plotW, plotH - 2);

        const rowImg = wCtx.createImageData(plotW, 2);
        const data = rowImg.data;
        const minF = 88;
        const maxF = 11000;
        const logMin = Math.log10(minF);
        const logMax = Math.log10(maxF);
        const binHz = frame.binHz || 11.71875;
        const nBins = frame.spectrum.length;

        for (let x = 0; x < plotW; x++) {
          const normX = x / Math.max(1, plotW - 1);
          const freq = Math.pow(10, logMin + normX * (logMax - logMin));
          const bin = Math.max(1, Math.min(nBins - 1, Math.round(freq / binHz)));
          const db = frame.spectrum[bin];
          const [r, g, b] = this._dbToWaterfallRGB(db);

          for (let row = 0; row < 2; row++) {
            const idx = (row * plotW + x) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
          }
        }
        wCtx.putImageData(rowImg, 0, 0);
      }

      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(this.waterfallCanvas, padL, padT, plotW, plotH);

      // Border around spectrogram
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, plotW, plotH);

      // Log-frequency X-axis ticks at the 10 audiological band centers
      const minF = 88;
      const maxF = 11000;
      const logMin = Math.log10(minF);
      const logMax = Math.log10(maxF);

      ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (let i = 0; i < DSPEngine.BANDS.length; i++) {
        const f = DSPEngine.BANDS[i].center;
        const normX = (Math.log10(f) - logMin) / (logMax - logMin);
        const x = padL + normX * plotW;

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.fillText(formatBandFreq(f), x, padT + plotH + 8);
        ctx.fillStyle = '#475569';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('Hz', x, padT + plotH + 21);
        ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
      }

      // Y-axis time markers (0s to -5s)
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillStyle = '#64748b';
      const timeTicks = [0, 1, 2, 3, 4];
      for (let i = 0; i < timeTicks.length; i++) {
        const ty = padT + (i / (timeTicks.length - 1)) * plotH;
        ctx.fillText(`-${timeTicks[i]}s`, padL - 6, ty);
      }

      ctx.save();
      ctx.translate(13, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(window.I18N.t('analyzer.axis.time'), 0, 0);
      ctx.restore();

      if (!frame.active) {
        this._drawIdleOverlay(ctx, W, H);
      }
    },

    _dbToWaterfallRGB(db) {
      // Map ~15 dB .. 95 dB SPL to dark -> cyan -> yellow -> red
      const norm = Math.max(0, Math.min(1, (db - 15) / 80));
      if (norm < 0.25) {
        const t = norm / 0.25;
        return [
          Math.round(7 + t * 5),
          Math.round(10 + t * 55),
          Math.round(18 + t * 95)
        ];
      } else if (norm < 0.55) {
        const t = (norm - 0.25) / 0.3;
        return [
          Math.round(12 + t * 22),
          Math.round(65 + t * 146),
          Math.round(113 + t * 125)
        ];
      } else if (norm < 0.8) {
        const t = (norm - 0.55) / 0.25;
        return [
          Math.round(34 + t * 216),
          Math.round(211 - t * 7),
          Math.round(238 - t * 217)
        ];
      } else {
        const t = (norm - 0.8) / 0.2;
        return [
          Math.round(250 - t * 6),
          Math.round(204 - t * 141),
          Math.round(21 + t * 73)
        ];
      }
    },

    _drawIdleOverlay(ctx, W, H) {
      ctx.save();
      const boxW = Math.min(W - 40, 480);
      const boxH = 54;
      const bx = (W - boxW) / 2;
      const by = (H - boxH) / 2;

      ctx.fillStyle = 'rgba(9, 13, 22, 0.86)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, boxW, boxH);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const msg = window.I18N.t('analyzer.idle_overlay');
      ctx.fillText(msg, W / 2, H / 2, boxW - 24);
      ctx.restore();
    },

    /* ======================================================================
       START/STOP CAPTURE & RUNNING AGGREGATION (50ms DRIFT-COMPENSATED)
       ====================================================================== */
    startCapture() {
      if (!this.engine.isActive()) {
        this.showToast(window.I18N.t('capture.needs_source'), true);
        return;
      }

      const nBands = DSPEngine.BANDS.length;
      this.isCapturing = true;
      this.captureStats = {
        startTime: Date.now(),
        startPerf: performance.now(),
        frameCount: 0,
        bandPowerSums: new Float64Array(nBands),
        bandMaxPeaks: new Float64Array(nBands),
        splPowerSum: 0,
        maxCrest: 0,
        crestValues: [],
        allCrestValues: [],
        centroidSum: 0,
        usmrSum: 0,
        stressSum: 0,
        feedbackDetectedCount: 0,
        feedbackHzList: [],
        feedbackMaxProm: 0
      };

      const btnCapture = document.getElementById('btn-capture');
      const progBar = document.getElementById('capture-progress-bar');

      if (btnCapture) btnCapture.classList.add('recording-pulse');
      if (progBar) {
        progBar.style.removeProperty('width');
        progBar.classList.remove('w-0');
        progBar.classList.add('w-full', 'animate-pulse');
      }

      const intervalMs = 50;
      const maxSeconds = 600;

      const sampleTick = () => {
        if (!this.isCapturing || !this.captureStats) return;

        if (!this.engine.isActive()) {
          this._handleSourceStoppedDuringCapture();
          return;
        }

        const stats = this.captureStats;
        const frame = this.engine.getFrameData();
        stats.frameCount++;

        for (let b = 0; b < nBands; b++) {
          const db = frame.bands[b] || 0;
          stats.bandPowerSums[b] += Math.pow(10, db / 10);
          const pk = frame.peaks[b] || db;
          if (pk > stats.bandMaxPeaks[b]) {
            stats.bandMaxPeaks[b] = pk;
          }
        }

        stats.splPowerSum += Math.pow(10, (frame.spl || 0) / 10);
        const frameCrest = Number(frame.crest) || 0;
        if (frameCrest > stats.maxCrest) stats.maxCrest = frameCrest;
        stats.allCrestValues.push(frameCrest);
        stats.centroidSum += frame.centroid || 0;
        stats.usmrSum += frame.usmr || 0;
        stats.stressSum += frame.stress || 0;

        const fb = frame.feedback || { detected: false, hz: 0, prominence: 0 };
        if (fb.detected) {
          stats.feedbackDetectedCount++;
          if (typeof fb.hz === 'number' && Number.isFinite(fb.hz) && fb.hz > 0) {
            stats.feedbackHzList.push(fb.hz);
          }
        } else {
          stats.crestValues.push(frameCrest);
        }
        if (
          typeof fb.prominence === 'number' &&
          Number.isFinite(fb.prominence) &&
          fb.prominence > stats.feedbackMaxProm
        ) {
          stats.feedbackMaxProm = fb.prominence;
        }

        const elapsedSec = (Date.now() - stats.startTime) / 1000;
        this._updateCaptureProgressUI(elapsedSec, stats.frameCount);

        if (elapsedSec >= maxSeconds) {
          this.showToast(window.I18N.t('capture.max_reached', { min: 10 }));
          this._finishCapture();
        } else {
          // Drift-compensated 50 ms schedule anchored to startPerf
          const nextTargetPerf = stats.startPerf + stats.frameCount * intervalMs;
          const delayMs = Math.max(0, nextTargetPerf - performance.now());
          this.captureTimer = setTimeout(sampleTick, delayMs);
        }
      };

      sampleTick();
    },

    _updateCaptureProgressUI(elapsedSec, frameCount) {
      const btnLabel = document.getElementById('btn-capture-label');
      const progText = document.getElementById('capture-progress-text');
      const timeStr = formatMmSs(elapsedSec);

      if (btnLabel) {
        btnLabel.removeAttribute('data-i18n');
        btnLabel.textContent = window.I18N.t('capture.stop', { time: timeStr });
      }
      if (progText) {
        progText.removeAttribute('data-i18n');
        progText.textContent = window.I18N.t('capture.recording', {
          time: timeStr,
          n: frameCount
        });
      }
    },

    _handleSourceStoppedDuringCapture() {
      if (!this.isCapturing || !this.captureStats) return;
      const elapsedSec = (Date.now() - this.captureStats.startTime) / 1000;
      if (elapsedSec >= 2 && this.captureStats.frameCount > 0) {
        this._finishCapture();
      } else {
        this.cancelCapture();
        this.showToast(window.I18N.t('capture.too_short', { s: 2 }), true);
      }
    },

    cancelCapture() {
      this.isCapturing = false;
      if (this.captureTimer) {
        clearTimeout(this.captureTimer);
        this.captureTimer = null;
      }
      this.captureStats = null;
      this._resetCaptureUI();
    },

    _resetCaptureUI() {
      const btnCapture = document.getElementById('btn-capture');
      const btnLabel = document.getElementById('btn-capture-label');
      const progBar = document.getElementById('capture-progress-bar');
      const progText = document.getElementById('capture-progress-text');

      if (btnCapture) btnCapture.classList.remove('recording-pulse');
      if (btnLabel) {
        btnLabel.setAttribute('data-i18n', 'capture.button');
        btnLabel.textContent = window.I18N.t('capture.button');
      }
      if (progBar) {
        progBar.classList.remove('w-full', 'animate-pulse');
        progBar.classList.add('w-0');
        progBar.style.width = '0%';
      }
      if (progText) {
        progText.removeAttribute('data-i18n');
        progText.textContent = '';
      }
    },

    _finishCapture() {
      if (!this.isCapturing || !this.captureStats) return;

      const stats = this.captureStats;
      const elapsedSec = (Date.now() - stats.startTime) / 1000;
      const minSeconds = 2;

      if (elapsedSec < minSeconds || stats.frameCount < 1) {
        this.cancelCapture();
        this.showToast(window.I18N.t('capture.too_short', { s: minSeconds }), true);
        return;
      }

      this.isCapturing = false;
      if (this.captureTimer) {
        clearTimeout(this.captureTimer);
        this.captureTimer = null;
      }
      this.captureStats = null;

      const n = Math.max(1, stats.frameCount);
      const durationSec = Math.round(elapsedSec * 10) / 10;
      const frameCount = stats.frameCount;
      const nBands = DSPEngine.BANDS.length;

      const aggBands = new Array(nBands).fill(0);
      const aggPeaks = new Array(nBands).fill(0);

      for (let b = 0; b < nBands; b++) {
        const meanDb = 10 * Math.log10(Math.max(1e-12, stats.bandPowerSums[b] / n));
        aggBands[b] = Math.round(Math.max(0, Math.min(130, meanDb)) * 10) / 10;
        aggPeaks[b] = Math.round(Math.max(aggBands[b], Math.min(140, stats.bandMaxPeaks[b])) * 10) / 10;
      }

      const dbSPL =
        Math.round(Math.max(0, Math.min(130, 10 * Math.log10(Math.max(1e-12, stats.splPowerSum / n)))) * 10) / 10;
      const crestPool =
        stats.crestValues.length > 0 ? stats.crestValues : stats.allCrestValues;
      let rawCf = stats.maxCrest;
      if (crestPool.length > 0) {
        const sortedCrest = [...crestPool].sort((a, b) => a - b);
        const p95Idx = Math.min(
          sortedCrest.length - 1,
          Math.floor(sortedCrest.length * 0.95)
        );
        rawCf = sortedCrest[p95Idx];
      }
      const cf = Math.round(rawCf * 10) / 10;
      const centroid = Math.round(stats.centroidSum / n);
      const usmr = Math.round((stats.usmrSum / n) * 10) / 10;
      const stress = Math.round(stats.stressSum / n);

      const feedbackPct = Math.max(
        0,
        Math.min(100, Math.round((stats.feedbackDetectedCount / n) * 100))
      );
      let feedbackHz = 0;
      if (stats.feedbackHzList.length > 0) {
        const sortedHz = [...stats.feedbackHzList].sort((a, b) => a - b);
        const mid = sortedHz.length >> 1;
        const med =
          sortedHz.length % 2 === 1
            ? sortedHz[mid]
            : 0.5 * (sortedHz[mid - 1] + sortedHz[mid]);
        feedbackHz = Math.round(med);
      }
      const feedbackProm = Math.round(stats.feedbackMaxProm * 10) / 10;

      let domIdx = 0;
      let maxB = -Infinity;
      for (let b = 0; b < nBands; b++) {
        if (aggBands[b] > maxB) {
          maxB = aggBands[b];
          domIdx = b;
        }
      }
      const dominantBand = DSPEngine.BANDS[domIdx].center;

      this.pendingCapture = {
        durationSec,
        frameCount,
        metrics: {
          bands: aggBands,
          peaks: aggPeaks,
          dbSPL,
          cf,
          centroid,
          usmr,
          stress,
          feedbackPct,
          feedbackHz,
          feedbackProm
        },
        dominantBand
      };

      this._resetCaptureUI();
      const progText = document.getElementById('capture-progress-text');
      if (progText) {
        progText.setAttribute('data-i18n', 'capture.done');
        progText.textContent = window.I18N.t('capture.done');
      }

      this.openModal();
    },

    openModal() {
      if (!this.pendingCapture) return;
      this.lastFocusedElement = document.activeElement;

      const m = this.pendingCapture.metrics;
      const src = this.engine.getSource();

      // Pre-select suggested symptoms based on measured acoustic thresholds
      const suggestedSymptoms = new Set();
      if (m.feedbackPct >= 10) suggestedSymptoms.add('whistle');
      if (m.centroid > 2500) suggestedSymptoms.add('sharp');
      if (m.cf > 14 && !(m.feedbackPct >= 50 && m.cf < 18)) {
        suggestedSymptoms.add('impulses');
      }
      if (m.usmr > 6) suggestedSymptoms.add('masking');
      if (suggestedSymptoms.size === 0) suggestedSymptoms.add('sharp');

      document.querySelectorAll('input[name="symptom"]').forEach((chk) => {
        chk.checked = suggestedSymptoms.has(chk.value);
      });

      const defaultEnv =
        src === 'synth:traffic'
          ? 'street'
          : src === 'synth:feedback'
            ? 'home_tv'
            : 'restaurant';
      document.querySelectorAll('input[name="env"]').forEach((rad) => {
        rad.checked = rad.value === defaultEnv;
      });

      const lastCtx = this._loadLastContext();
      document.querySelectorAll('input[name="program"]').forEach((rad) => {
        rad.checked = rad.value === lastCtx.programId;
      });
      const volSelect = document.getElementById('modal-volume');
      if (volSelect) {
        volSelect.value =
          lastCtx.volumeStep !== null && VOLUME_STEPS.includes(lastCtx.volumeStep)
            ? String(lastCtx.volumeStep)
            : 'unknown';
      }

      const noteEl = document.getElementById('modal-note');
      if (noteEl) noteEl.value = '';

      this._syncModalChips();
      this._renderModalSummary();

      const modal = document.getElementById('capture-modal');
      if (modal) {
        modal.classList.remove('hidden');
        modal.focus();
      }
    },

    closeModal() {
      const modal = document.getElementById('capture-modal');
      if (modal) modal.classList.add('hidden');
      this.pendingCapture = null;
      if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
        this.lastFocusedElement.focus();
      }
    },

    _syncModalChips() {
      document.querySelectorAll('input[name="symptom"]').forEach((chk) => {
        const chip = chk.closest('.select-chip');
        if (chip) chip.classList.toggle('selected-symptom', chk.checked);
      });
      document.querySelectorAll('input[name="env"]').forEach((rad) => {
        const chip = rad.closest('.select-chip');
        if (chip) chip.classList.toggle('selected-env', rad.checked);
      });
      document.querySelectorAll('input[name="program"]').forEach((rad) => {
        const chip = rad.closest('.select-chip');
        if (chip) chip.classList.toggle('selected-env', rad.checked);
      });
    },

    _getSelectedModalSymptoms() {
      const selected = [];
      document.querySelectorAll('input[name="symptom"]:checked').forEach((chk) => {
        if (SYMPTOM_IDS.includes(chk.value)) selected.push(chk.value);
      });
      return selected;
    },

    _getSelectedModalEnv() {
      const rad = document.querySelector('input[name="env"]:checked');
      return rad && ENV_IDS.includes(rad.value) ? rad.value : 'restaurant';
    },

    _getSelectedModalContext() {
      const progRad = document.querySelector('input[name="program"]:checked');
      const programId =
        progRad && PROGRAM_IDS.includes(progRad.value) ? progRad.value : 'unknown';
      const volSelect = document.getElementById('modal-volume');
      const rawVol = volSelect ? volSelect.value : 'unknown';
      let volumeStep = null;
      if (rawVol !== 'unknown') {
        const parsed = parseInt(rawVol, 10);
        if (Number.isFinite(parsed) && VOLUME_STEPS.includes(parsed)) {
          volumeStep = parsed;
        }
      }
      return { programId, volumeStep };
    },

    _renderModalSummary() {
      const container = document.getElementById('modal-summary');
      if (!container || !this.pendingCapture) return;

      const m = this.pendingCapture.metrics;
      const dom = this.pendingCapture.dominantBand;
      const symptomIds = this._getSelectedModalSymptoms();
      const previewRules = evaluateRules({
        metrics: m,
        symptomIds,
        dominantBand: dom
      });

      const rulesHtml =
        previewRules.length > 0
          ? `<div class="mt-3 pt-2.5 border-t border-slate-800 space-y-1.5">
              <div class="text-[11px] font-bold uppercase tracking-wider text-amber-400">${escapeHtml(
                window.I18N.t('modal.rules_preview.heading')
              )}</div>
              ${previewRules
                .map(
                  (r) =>
                    `<div class="text-xs text-slate-200 bg-slate-900/90 border border-slate-800 rounded-lg p-2">
                      <span class="font-semibold text-cyan-300">${escapeHtml(
                        window.I18N.t(`rule.${r.id}.title`)
                      )}:</span>
                      <span class="text-slate-300 ml-1">${escapeHtml(
                        formatRuleText(r)
                      )}</span>
                    </div>`
                )
                .join('')}
            </div>`
          : '';

      container.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2">
            <div class="text-[10px] text-slate-400">${escapeHtml(window.I18N.t('metric.spl.short'))}</div>
            <div class="text-sm font-bold font-mono text-white">${window.I18N.formatNumber(m.dbSPL, 1)} dB</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2">
            <div class="text-[10px] text-slate-400">${escapeHtml(window.I18N.t('metric.crest'))}</div>
            <div class="text-sm font-bold font-mono text-amber-300">${window.I18N.formatNumber(m.cf, 1)} dB</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2">
            <div class="text-[10px] text-slate-400">${escapeHtml(window.I18N.t('metric.centroid'))}</div>
            <div class="text-sm font-bold font-mono text-teal-300">${window.I18N.formatNumber(m.centroid, 0)} Hz</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2">
            <div class="text-[10px] text-slate-400">${escapeHtml(window.I18N.t('metric.usmr.short'))}</div>
            <div class="text-sm font-bold font-mono text-rose-300">${m.usmr > 0 ? '+' : ''}${window.I18N.formatNumber(m.usmr, 1)} dB</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-2 col-span-2 sm:col-span-1">
            <div class="text-[10px] text-slate-400">${escapeHtml(window.I18N.t('metric.dominant_band'))}</div>
            <div class="text-sm font-bold font-mono text-rose-400">${dom} Hz</div>
          </div>
        </div>
        ${rulesHtml}
      `;
    },

    saveModalCapture() {
      if (!this.pendingCapture) return;
      const symptomIds = this._getSelectedModalSymptoms();
      if (symptomIds.length === 0) {
        this.showToast(window.I18N.t('modal.symptoms.required'), true);
        return;
      }

      const envId = this._getSelectedModalEnv();
      const context = this._getSelectedModalContext();
      this._saveLastContext(context);
      const noteEl = document.getElementById('modal-note');
      const rawNote = noteEl ? noteEl.value.trim().slice(0, 500) : '';

      const newRecord = {
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        durationSec: this.pendingCapture.durationSec,
        frameCount: this.pendingCapture.frameCount,
        envId,
        symptomIds,
        context,
        note: rawNote,
        metrics: this.pendingCapture.metrics,
        dominantBand: this.pendingCapture.dominantBand,
        ruleTriggers: []
      };
      newRecord.ruleTriggers = evaluateRules(newRecord);

      this.logs.unshift(newRecord);
      this._saveLogsToStorage();
      this.closeModal();

      this.renderHistory();
      this.renderReport();
      this.switchTab('history');
    },

    /* ======================================================================
       TAB 2: LOG HISTORY BACKUP (EXPORT / IMPORT) & RENDERING
       ====================================================================== */
    exportLogsJson() {
      if (!Array.isArray(this.logs) || this.logs.length === 0) {
        this.showToast(window.I18N.t('history.export.empty'));
        return;
      }

      const payload = {
        app: 'AcousticLog',
        format: 2,
        exportedAt: new Date().toISOString(),
        calibrationDb: this.engine ? this.engine.getCalibration() : 0,
        device: this.device || { brand: 'unknown', model: '' },
        fittings: this.fittings || [],
        logs: this.logs
      };

      const jsonStr = JSON.stringify(payload, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);

      const link = document.createElement('a');
      link.href = url;
      link.download = `acousticlog-backup-${dateStr}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      const exportKey =
        this.logs.length === 1 ? 'history.export.done_one' : 'history.export.done';
      this.showToast(window.I18N.t(exportKey, { n: this.logs.length }));
    },

    _readFileText(file) {
      if (file && typeof file.text === 'function') {
        return file.text();
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsText(file);
      });
    },

    async importLogsFromFile(file) {
      if (!file) return;

      if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES) {
        this.showToast(window.I18N.t('history.import.too_large', { mb: MAX_IMPORT_MB }), true);
        return;
      }

      let text;
      try {
        text = await this._readFileText(file);
      } catch (e) {
        this.showToast(window.I18N.t('history.import.invalid'), true);
        return;
      }

      if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
        this.showToast(
          window.I18N.t(
            typeof text === 'string' && text.length > MAX_IMPORT_BYTES
              ? 'history.import.too_large'
              : 'history.import.invalid',
            { mb: MAX_IMPORT_MB }
          ),
          true
        );
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        this.showToast(window.I18N.t('history.import.invalid'), true);
        return;
      }

      let rawRecords = null;
      let rawFittings = null;
      let rawDevice = null;
      if (Array.isArray(parsed)) {
        rawRecords = parsed;
      } else if (parsed && typeof parsed === 'object') {
        if (parsed.app !== undefined && parsed.app !== 'AcousticLog') {
          this.showToast(window.I18N.t('history.import.invalid'), true);
          return;
        }
        if (parsed.format !== undefined && parsed.format !== 1 && parsed.format !== 2) {
          this.showToast(window.I18N.t('history.import.invalid'), true);
          return;
        }
        if (parsed.fittings !== undefined) {
          if (!Array.isArray(parsed.fittings)) {
            this.showToast(window.I18N.t('history.import.invalid'), true);
            return;
          }
          rawFittings = parsed.fittings;
        }
        if (parsed.device !== undefined && parsed.device !== null) {
          if (typeof parsed.device !== 'object' || Array.isArray(parsed.device)) {
            this.showToast(window.I18N.t('history.import.invalid'), true);
            return;
          }
          rawDevice = parsed.device;
        }
        if (Array.isArray(parsed.logs)) {
          rawRecords = parsed.logs;
        }
      }

      if (!rawRecords) {
        this.showToast(window.I18N.t('history.import.invalid'), true);
        return;
      }

      const existingIds = new Set(this.logs.map((r) => r && r.id));
      let added = 0;
      let skipped = 0;
      let invalid = 0;

      for (let i = 0; i < rawRecords.length; i++) {
        const clean = validateLogRecord(rawRecords[i]);
        if (!clean) {
          invalid++;
          continue;
        }
        if (existingIds.has(clean.id)) {
          skipped++;
          continue;
        }
        existingIds.add(clean.id);
        this.logs.push(clean);
        added++;
      }

      if (added > 0) {
        this.logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        this._saveLogsToStorage();
      }

      if (Array.isArray(rawFittings)) {
        const existingFitIds = new Set(this.fittings.map((f) => f && f.id));
        let fitAdded = 0;
        for (let i = 0; i < rawFittings.length; i++) {
          const cleanFit = validateFittingVisit(rawFittings[i]);
          if (!cleanFit) {
            invalid++;
            continue;
          }
          if (existingFitIds.has(cleanFit.id)) {
            continue;
          }
          existingFitIds.add(cleanFit.id);
          this.fittings.push(cleanFit);
          fitAdded++;
        }
        if (fitAdded > 0) {
          this.fittings.sort((a, b) => b.date.localeCompare(a.date));
          this._saveFittingsToStorage();
        }
      }

      if (rawDevice) {
        const hasLocalDevice =
          this.device &&
          ((this.device.brand && this.device.brand !== 'unknown') ||
            (typeof this.device.model === 'string' && this.device.model.trim().length > 0));
        if (!hasLocalDevice) {
          const impBrand =
            typeof rawDevice.brand === 'string' && rawDevice.brand in DEVICE_BRANDS
              ? rawDevice.brand
              : 'unknown';
          const impModel =
            typeof rawDevice.model === 'string' ? rawDevice.model.trim().slice(0, 120) : '';
          if (impBrand !== 'unknown' || impModel.length > 0) {
            this.device = { brand: impBrand, model: impModel };
            this._saveDeviceToStorage();
            this._syncDeviceUI();
          }
        }
      }

      this.renderHistory();
      this.renderReport();
      this.showToast(window.I18N.t('history.import.done', { added, skipped, invalid }));
    },

    renderHistory() {
      const listEl = document.getElementById('history-list');
      const emptyEl = document.getElementById('history-empty');
      if (!listEl || !emptyEl) return;

      const sorted = [...this.logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const hasFittings = Array.isArray(this.fittings) && this.fittings.length > 0;

      if (sorted.length === 0) {
        emptyEl.classList.remove('hidden');
        if (!hasFittings) {
          listEl.innerHTML = '';
          return;
        }
      } else {
        emptyEl.classList.add('hidden');
      }

      const timelineItems = [
        ...sorted.map((entry) => ({
          type: 'event',
          ts: Number(entry.timestamp) || 0,
          entry
        })),
        ...(this.fittings || []).map((visit) => ({
          type: 'fitting',
          ts: fittingDateToMs(visit.date),
          visit
        }))
      ].sort((a, b) => {
        if (b.ts !== a.ts) return b.ts - a.ts;
        if (a.type === b.type) return 0;
        return a.type === 'event' ? -1 : 1;
      });

      const cardsHtml = timelineItems
        .map((item) => {
          if (item.type === 'fitting') {
            const v = item.visit;
            const fitNote = formatFittingNote(v.note);
            return `
              <div class="fitting-marker flex flex-wrap items-center justify-between gap-2 py-2.5 px-4 rounded-xl bg-teal-500/10 border border-teal-500/40 text-xs" data-fitting-id="${escapeHtml(
                v.id
              )}">
                <div class="flex items-center gap-2.5 font-bold text-teal-300">
                  <span class="w-2 h-2 rounded-full bg-teal-400 shrink-0"></span>
                  <span>${escapeHtml(
                    window.I18N.t('history.fitting_marker', { date: v.date })
                  )}</span>
                </div>
                ${
                  fitNote
                    ? `<span class="text-slate-300 italic">${escapeHtml(fitNote)}</span>`
                    : ''
                }
              </div>
            `;
          }
          const entry = item.entry;
          const m = entry.metrics || {};
          const bands = Array.isArray(m.bands) ? m.bands : new Array(10).fill(0);
          const domHz = entry.dominantBand || 1000;
          const dateStr = window.I18N.formatDate(entry.timestamp);
          const envLabel = window.I18N.t(`env.${entry.envId || 'restaurant'}`);
          const durationHtml =
            typeof entry.durationSec === 'number' && Number.isFinite(entry.durationSec)
              ? `<span class="px-2 py-0.5 rounded text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">${escapeHtml(
                  window.I18N.t('capture.duration', { time: formatDuration(entry.durationSec) })
                )}</span>`
              : '';

          const symptomsHtml = (entry.symptomIds || [])
            .map(
              (sId) =>
                `<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">${escapeHtml(
                  window.I18N.t(`symptom.${sId}`)
                )}</span>`
            )
            .join('');

          const miniBarsHtml = DSPEngine.BANDS.map((bDef, idx) => {
            const val = Number(bands[idx]) || 0;
            const pct = Math.max(8, Math.min(100, Math.round(((val - 25) / 75) * 100)));
            const isDom = bDef.center === domHz;
            return `
              <div class="mini-bar-col ${isDom ? 'dominant-col' : ''}" title="${bDef.center} Hz: ${window.I18N.formatNumber(val, 1)} dB SPL">
                <div class="mini-bar ${isDom ? 'dominant' : ''}" style="height: ${pct}%"></div>
                <span class="mini-bar-label">${formatBandFreq(bDef.center)}</span>
              </div>
            `;
          }).join('');

          const noteText =
            entry.note && entry.note.startsWith('sample.')
              ? window.I18N.t(entry.note)
              : entry.note;

          const noteHtml = noteText
            ? `<div class="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3 text-xs text-slate-300">
                <span class="font-bold text-slate-400 mr-1.5">${escapeHtml(
                  window.I18N.t('history.note_label')
                )}:</span>
                <span class="italic">“${escapeHtml(noteText)}”</span>
              </div>`
            : '';

          const insights = getRecordInsights(entry);
          const insightsHtml = insights
            .map(
              (txt) =>
                `<li class="text-xs text-slate-300 flex items-start gap-2">
                  <span class="text-cyan-400 mt-0.5">•</span>
                  <span>${escapeHtml(txt)}</span>
                </li>`
            )
            .join('');

          const triggers = Array.isArray(entry.ruleTriggers)
            ? entry.ruleTriggers
            : evaluateRules(entry);

          const contextLine = formatContextLine(entry.context);

          const rulesHtml = triggers
            .map(
              (r) =>
                `<div class="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1">
                  <div class="text-xs font-bold text-cyan-300">${escapeHtml(
                    window.I18N.t(`rule.${r.id}.title`)
                  )}</div>
                  <p class="text-xs text-slate-300 leading-relaxed">${escapeHtml(
                    formatRuleText(r)
                  )}</p>
                </div>`
            )
            .join('');

          return `
            <article class="bg-slate-900/90 border border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
              <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
                <div class="space-y-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="px-2.5 py-0.5 rounded-md text-xs font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">${escapeHtml(
                      envLabel
                    )}</span>
                    <span class="text-xs font-mono text-slate-400">${escapeHtml(dateStr)}</span>
                    ${durationHtml}
                  </div>
                  <div class="text-xs text-teal-300 font-medium">${escapeHtml(contextLine)}</div>
                  <div class="flex flex-wrap items-center gap-1.5 pt-1">
                    ${symptomsHtml}
                  </div>
                </div>
                <button type="button" data-delete-id="${escapeHtml(
                  entry.id
                )}" class="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40">
                  ${escapeHtml(window.I18N.t('history.delete'))}
                </button>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                <div class="lg:col-span-5 space-y-1.5">
                  <div class="flex items-center justify-between text-xs">
                    <span class="text-slate-400 font-medium">${escapeHtml(
                      window.I18N.t('history.bands_title')
                    )}</span>
                    <span class="font-mono text-rose-400 font-bold">${escapeHtml(
                      window.I18N.t('history.dominant_band')
                    )}: ${domHz} Hz</span>
                  </div>
                  <div class="mini-spectrum">
                    ${miniBarsHtml}
                  </div>
                </div>

                <div class="lg:col-span-7 grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                  <div class="bg-slate-950 border border-slate-800 rounded-lg p-2.5">
                    <div class="text-[10px] text-slate-400">${escapeHtml(
                      window.I18N.t('metric.spl.short')
                    )}</div>
                    <div class="text-sm font-bold font-mono text-white mt-0.5">${window.I18N.formatNumber(
                      m.dbSPL,
                      1
                    )} dB</div>
                  </div>
                  <div class="bg-slate-950 border border-slate-800 rounded-lg p-2.5">
                    <div class="text-[10px] text-slate-400">${escapeHtml(
                      window.I18N.t('metric.crest')
                    )}</div>
                    <div class="text-sm font-bold font-mono text-amber-300 mt-0.5">${window.I18N.formatNumber(
                      m.cf,
                      1
                    )} dB</div>
                  </div>
                  <div class="bg-slate-950 border border-slate-800 rounded-lg p-2.5">
                    <div class="text-[10px] text-slate-400">${escapeHtml(
                      window.I18N.t('metric.centroid')
                    )}</div>
                    <div class="text-sm font-bold font-mono text-teal-300 mt-0.5">${window.I18N.formatNumber(
                      m.centroid,
                      0
                    )} Hz</div>
                  </div>
                  <div class="bg-slate-950 border border-slate-800 rounded-lg p-2.5">
                    <div class="text-[10px] text-slate-400">${escapeHtml(
                      window.I18N.t('metric.usmr.short')
                    )}</div>
                    <div class="text-sm font-bold font-mono text-rose-300 mt-0.5">${
                      m.usmr > 0 ? '+' : ''
                    }${window.I18N.formatNumber(m.usmr, 1)} dB</div>
                  </div>
                  <div class="bg-slate-950 border border-slate-800 rounded-lg p-2.5 col-span-2 sm:col-span-1">
                    <div class="text-[10px] text-slate-400">${escapeHtml(
                      window.I18N.t('metric.stress.short')
                    )}</div>
                    <div class="text-sm font-bold font-mono text-cyan-300 mt-0.5">${window.I18N.formatNumber(
                      m.stress,
                      0
                    )}%</div>
                  </div>
                </div>
              </div>

              ${noteHtml}

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div class="space-y-1.5">
                  <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400">${escapeHtml(
                    window.I18N.t('history.insights.heading')
                  )}</h4>
                  <ul class="space-y-1">
                    ${insightsHtml}
                  </ul>
                </div>
                <div class="space-y-2">
                  <h4 class="text-xs font-bold uppercase tracking-wider text-cyan-400">${escapeHtml(
                    window.I18N.t('history.rules.heading')
                  )}</h4>
                  <div class="space-y-2">
                    ${rulesHtml}
                  </div>
                </div>
              </div>
            </article>
          `;
        })
        .join('');

      listEl.innerHTML = cardsHtml;

      listEl.querySelectorAll('[data-delete-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-delete-id');
          if (id && window.confirm(window.I18N.t('history.delete_confirm'))) {
            this.logs = this.logs.filter((item) => item.id !== id);
            this._saveLogsToStorage();
            this.renderHistory();
            this.renderReport();
          }
        });
      });
    },

    /* ======================================================================
       TAB 3: AUDIOLOGIST CLINICAL REPORT RENDERING
       ====================================================================== */
    renderReport() {
      const elDate = document.getElementById('report-date');
      const elCount = document.getElementById('report-count');
      const elAvgSpl = document.getElementById('report-avg-spl');
      const elAvgStress = document.getElementById('report-avg-stress');
      const elDevice = document.getElementById('report-device');
      const elHeatmap = document.getElementById('report-heatmap');
      const elRules = document.getElementById('report-rules');
      const elSymptoms = document.getElementById('report-symptoms');
      const elEnvs = document.getElementById('report-envs');
      const elContext = document.getElementById('report-context');

      if (!elHeatmap || !elRules) return;

      this._syncDeviceUI();
      this._renderFittingSection();

      const nEvents = this.logs.length;
      if (elDate) {
        elDate.textContent = window.I18N.t('report.generated_on', {
          date: window.I18N.formatDate(Date.now())
        });
      }
      if (elCount) {
        elCount.textContent = window.I18N.t('report.events_analyzed', { n: nEvents });
      }
      if (elDevice) {
        elDevice.textContent = window.I18N.t('report.device', {
          device: formatDeviceLabel(this.device)
        });
      }

      const viewReport = document.getElementById('view-report');
      let elEventsCard = document.getElementById('report-events-card');
      if (!elEventsCard && viewReport) {
        elEventsCard = document.createElement('div');
        elEventsCard.id = 'report-events-card';
        elEventsCard.className = 'print-card bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-3';
        const lastCard = viewReport.lastElementChild;
        if (lastCard) {
          viewReport.insertBefore(elEventsCard, lastCard);
        } else {
          viewReport.appendChild(elEventsCard);
        }
      }

      if (nEvents === 0) {
        if (elAvgSpl) elAvgSpl.textContent = window.I18N.t('report.avg_spl', { spl: 0 });
        if (elAvgStress) elAvgStress.textContent = window.I18N.t('report.avg_stress', { stress: 0 });
        const noDataHtml = `<div class="col-span-full text-xs text-slate-400 print-text-muted py-4">${escapeHtml(
          window.I18N.t('report.no_data')
        )}</div>`;
        elHeatmap.innerHTML = noDataHtml;
        elRules.innerHTML = noDataHtml;
        if (elSymptoms) elSymptoms.innerHTML = noDataHtml;
        if (elEnvs) elEnvs.innerHTML = noDataHtml;
        if (elContext) elContext.innerHTML = noDataHtml;
        if (elEventsCard) elEventsCard.classList.add('hidden');
        return;
      }

      let splSum = 0;
      let stressSum = 0;
      for (let i = 0; i < nEvents; i++) {
        const m = this.logs[i].metrics || {};
        splSum += Number(m.dbSPL ?? m.spl) || 0;
        stressSum += Number(m.stress) || 0;
      }
      const meanSpl = Math.round((splSum / nEvents) * 10) / 10;
      const meanStress = Math.round(stressSum / nEvents);

      if (elAvgSpl) elAvgSpl.textContent = window.I18N.t('report.avg_spl', { spl: meanSpl });
      if (elAvgStress) {
        elAvgStress.textContent = window.I18N.t('report.avg_stress', { stress: meanStress });
      }

      // 1. 10-Channel Problem-Frequency Heatmap
      const nBands = DSPEngine.BANDS.length;
      const bandIncidentCount = new Array(nBands).fill(0);
      const bandPowerSum = new Array(nBands).fill(0);
      const bandMaxPeak = new Array(nBands).fill(0);

      for (let e = 0; e < nEvents; e++) {
        const rec = this.logs[e];
        const m = rec.metrics || {};
        const bands = Array.isArray(m.bands) ? m.bands : [];
        const peaks = Array.isArray(m.peaks) ? m.peaks : [];
        const syms = Array.isArray(rec.symptomIds) ? rec.symptomIds : [];

        for (let b = 0; b < nBands; b++) {
          const center = DSPEngine.BANDS[b].center;
          const level = Number(bands[b]) || 0;
          const pk = Number(peaks[b]) || level;
          bandPowerSum[b] += Math.pow(10, level / 10);
          if (pk > bandMaxPeak[b]) bandMaxPeak[b] = pk;

          let weight = 0;
          if (rec.dominantBand === center) weight += 1.0;
          if (level > BANANA_UPPER[b] + 8 && level > 68) weight += 0.65;
          if (syms.includes('sharp') && center >= 2000 && center <= 6000 && level > 68) {
            weight += 0.45;
          }
          if (syms.includes('masking') && center <= 500 && level > 72) {
            weight += 0.45;
          }
          if (syms.includes('occlusion') && (center === 250 || center === 500) && level > 65) {
            weight += 0.55;
          }
          if (syms.includes('whistle') && center >= 1500 && center <= 6000 && level > 60) {
            weight += 0.45;
          }
          bandIncidentCount[b] += Math.min(1, weight);
        }
      }

      elHeatmap.innerHTML = DSPEngine.BANDS.map((bDef, b) => {
        const scorePct = Math.min(100, Math.round((bandIncidentCount[b] / nEvents) * 100));
        const meanDb =
          Math.round(10 * Math.log10(Math.max(1e-12, bandPowerSum[b] / nEvents)) * 10) / 10;
        const peakDb = Math.round(bandMaxPeak[b] * 10) / 10;

        let heatClass = 'heat-0';
        if (scorePct >= 75) heatClass = 'heat-5';
        else if (scorePct >= 55) heatClass = 'heat-4';
        else if (scorePct >= 35) heatClass = 'heat-3';
        else if (scorePct >= 18) heatClass = 'heat-2';
        else if (scorePct > 0) heatClass = 'heat-1';

        return `
          <div class="heat-cell ${heatClass} p-2.5 flex flex-col justify-between text-center space-y-1.5">
            <div class="text-[10px] font-mono uppercase opacity-75">${escapeHtml(
              window.I18N.t('report.channel')
            )} ${b + 1}</div>
            <div class="text-sm font-bold font-mono">${bDef.center} Hz</div>
            <div class="text-lg font-extrabold font-mono">${scorePct}%</div>
            <div class="text-[10px] font-mono opacity-85 border-t border-current/20 pt-1">
              <div>${escapeHtml(window.I18N.t('report.heatmap.avg_db'))}: ${window.I18N.formatNumber(
          meanDb,
          1
        )}</div>
              <div>Peak: ${window.I18N.formatNumber(peakDb, 1)}</div>
            </div>
          </div>
        `;
      }).join('');

      // 2. Aggregated Deterministic Fitting Recommendations
      const ruleGroups = new Map();
      for (let e = 0; e < nEvents; e++) {
        const rec = this.logs[e];
        const triggers = Array.isArray(rec.ruleTriggers)
          ? rec.ruleTriggers
          : evaluateRules(rec);
        for (let r = 0; r < triggers.length; r++) {
          const trig = triggers[r];
          if (!ruleGroups.has(trig.id)) {
            ruleGroups.set(trig.id, []);
          }
          ruleGroups.get(trig.id).push(trig);
        }
      }

      const sortedRuleIds = Array.from(ruleGroups.keys()).sort(
        (a, b) => ruleGroups.get(b).length - ruleGroups.get(a).length
      );

      if (sortedRuleIds.length === 0) {
        elRules.innerHTML = `<div class="text-xs text-slate-400 print-text-muted">${escapeHtml(
          window.I18N.t('common.none')
        )}</div>`;
      } else {
        elRules.innerHTML = sortedRuleIds
          .map((ruleId) => {
            const items = ruleGroups.get(ruleId);
            const count = items.length;
            const params = {};

            if (ruleId === 'RULE_MPO_HIGH') {
              const bandCounts = {};
              let minDb = -2;
              items.forEach((it) => {
                const b = it.band || 3000;
                bandCounts[b] = (bandCounts[b] || 0) + 1;
                if (typeof it.db === 'number' && it.db < minDb) minDb = it.db;
              });
              params.band = Number(
                Object.keys(bandCounts).sort((a, b) => bandCounts[b] - bandCounts[a])[0] || 3000
              );
              params.db = minDb;
            } else if (ruleId === 'RULE_TRANSIENT') {
              params.cf = Math.max(...items.map((it) => Number(it.cf) || 14.5));
            } else if (ruleId === 'RULE_MASKING') {
              params.usmr = Math.max(...items.map((it) => Number(it.usmr) || 6.5));
            } else if (ruleId === 'RULE_LOUD') {
              params.spl = Math.max(...items.map((it) => Number(it.spl) || 81.0));
            } else if (ruleId === 'RULE_FEEDBACK') {
              const hzVals = items
                .map((it) => Number(it.hz) || 0)
                .filter((v) => v > 0)
                .sort((a, b) => a - b);
              if (hzVals.length > 0) {
                const mid = hzVals.length >> 1;
                params.hz = Math.round(
                  hzVals.length % 2 === 1 ? hzVals[mid] : 0.5 * (hzVals[mid - 1] + hzVals[mid])
                );
              } else {
                params.hz = 0;
              }
            }

            const isHighPriority =
              count >= 2 ||
              ruleId === 'RULE_MPO_HIGH' ||
              ruleId === 'RULE_TRANSIENT' ||
              ruleId === 'RULE_FEEDBACK';
            const prioKey = isHighPriority
              ? 'report.rule.priority_high'
              : 'report.rule.priority_med';
            const prioClass = isHighPriority
              ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
              : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
            const evidenceKey =
              count === 1 ? 'report.rule.evidence_one' : 'report.rule.evidence';

            return `
              <div class="print-card bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-1.5">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-mono font-bold px-2 py-0.5 rounded border ${prioClass} print-text-dark">${escapeHtml(
                      window.I18N.t(prioKey)
                    )}</span>
                    <h4 class="text-sm font-bold text-white print-text-dark">${escapeHtml(
                      window.I18N.t(`rule.${ruleId}.title`)
                    )}</h4>
                  </div>
                  <span class="text-xs font-mono text-slate-400 print-text-muted">${escapeHtml(
                    window.I18N.t(evidenceKey, { n: count })
                  )}</span>
                </div>
                <p class="text-xs sm:text-sm text-slate-200 print-text-dark leading-relaxed">${escapeHtml(
                  formatRuleText({ id: ruleId, ...params })
                )}</p>
              </div>
            `;
          })
          .join('');
      }

      // 3. Symptom Frequency Distribution
      if (elSymptoms) {
        const symCounts = {};
        SYMPTOM_IDS.forEach((id) => (symCounts[id] = 0));
        this.logs.forEach((rec) => {
          (rec.symptomIds || []).forEach((s) => {
            if (s in symCounts) symCounts[s]++;
          });
        });

        elSymptoms.innerHTML = SYMPTOM_IDS.map((id) => {
          const c = symCounts[id];
          const pct = Math.round((c / nEvents) * 100);
          return `
            <div class="space-y-1">
              <div class="flex justify-between text-xs">
                <span class="text-slate-200 print-text-dark font-medium">${escapeHtml(
                  window.I18N.t(`symptom.${id}`)
                )}</span>
                <span class="font-mono text-slate-400 print-text-muted">${c} / ${nEvents} (${pct}%)</span>
              </div>
              <div class="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                <div class="h-full bg-rose-500 rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }

      // 4. Environment Breakdown
      if (elEnvs) {
        const envCounts = {};
        ENV_IDS.forEach((id) => (envCounts[id] = 0));
        this.logs.forEach((rec) => {
          if (rec.envId in envCounts) envCounts[rec.envId]++;
        });

        elEnvs.innerHTML = ENV_IDS.map((id) => {
          const c = envCounts[id];
          const pct = Math.round((c / nEvents) * 100);
          return `
            <div class="space-y-1">
              <div class="flex justify-between text-xs">
                <span class="text-slate-200 print-text-dark font-medium">${escapeHtml(
                  window.I18N.t(`env.${id}`)
                )}</span>
                <span class="font-mono text-slate-400 print-text-muted">${c} / ${nEvents} (${pct}%)</span>
              </div>
              <div class="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                <div class="h-full bg-cyan-500 rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        }).join('');
      }

      // 4b. Program & Volume Context Table
      if (elContext) {
        const progStats = {};
        PROGRAM_IDS.forEach((pId) => {
          progStats[pId] = { count: 0, stressSum: 0, volSum: 0, volCount: 0 };
        });
        let volUpCount = 0;

        this.logs.forEach((rec) => {
          const ctx = rec.context && typeof rec.context === 'object' ? rec.context : {};
          const pId = PROGRAM_IDS.includes(ctx.programId) ? ctx.programId : 'unknown';
          const st = progStats[pId];
          st.count++;
          const m = rec.metrics || {};
          st.stressSum += Number(m.stress) || 0;
          if (typeof ctx.volumeStep === 'number' && Number.isFinite(ctx.volumeStep)) {
            st.volSum += ctx.volumeStep;
            st.volCount++;
            if (ctx.volumeStep >= 2) {
              volUpCount++;
            }
          }
        });

        const activeProgs = PROGRAM_IDS.filter((pId) => progStats[pId].count > 0);
        const rowsHtml = activeProgs
          .map((pId) => {
            const st = progStats[pId];
            const meanProgStress = Math.round(st.stressSum / st.count);
            let meanVolStr = '—';
            if (st.volCount > 0) {
              const meanVol = Math.round((st.volSum / st.volCount) * 10) / 10;
              meanVolStr =
                (meanVol > 0 ? '+' : '') + window.I18N.formatNumber(meanVol, 1);
            }
            return `
              <tr class="border-t border-slate-800">
                <td class="py-2 pr-3 font-medium text-slate-200 print-text-dark">${escapeHtml(
                  window.I18N.t(`program.${pId}`)
                )}</td>
                <td class="py-2 px-3 font-mono text-slate-300 print-text-dark text-right">${
                  st.count
                }</td>
                <td class="py-2 px-3 font-mono text-cyan-300 print-text-dark text-right">${meanProgStress}%</td>
                <td class="py-2 pl-3 font-mono text-slate-300 print-text-dark text-right">${escapeHtml(
                  meanVolStr
                )}</td>
              </tr>
            `;
          })
          .join('');

        const volNoteKey =
          volUpCount === 1
            ? 'report.context.volume_up_note_one'
            : 'report.context.volume_up_note';
        const volNoteHtml =
          volUpCount >= 1
            ? `<div class="text-xs text-amber-300 print-text-dark bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">${escapeHtml(
                window.I18N.t(volNoteKey, { n: volUpCount })
              )}</div>`
            : '';

        elContext.innerHTML = `
          <div class="overflow-x-auto">
            <table class="w-full text-xs text-left border-collapse">
              <thead>
                <tr class="text-slate-400 print-text-muted border-b border-slate-800">
                  <th class="pb-2 pr-3 font-semibold">${escapeHtml(
                    window.I18N.t('report.context.col_program')
                  )}</th>
                  <th class="pb-2 px-3 font-semibold text-right">${escapeHtml(
                    window.I18N.t('report.context.col_events')
                  )}</th>
                  <th class="pb-2 px-3 font-semibold text-right">${escapeHtml(
                    window.I18N.t('report.context.col_stress')
                  )}</th>
                  <th class="pb-2 pl-3 font-semibold text-right">${escapeHtml(
                    window.I18N.t('report.context.col_volume')
                  )}</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          ${volNoteHtml}
        `;
      }

      // 5. Detailed Event Log Summary (shows duration when available)
      if (elEventsCard) {
        elEventsCard.classList.remove('hidden');
        const sortedEvents = [...this.logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const rowsHtml = sortedEvents
          .map((rec) => {
            const m = rec.metrics || {};
            const dateStr = window.I18N.formatDate(rec.timestamp);
            const envLabel = window.I18N.t(`env.${rec.envId || 'restaurant'}`);
            const durBadge =
              typeof rec.durationSec === 'number' && Number.isFinite(rec.durationSec)
                ? `<span class="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-900 text-slate-300 border border-slate-700 print-text-dark">${escapeHtml(
                    window.I18N.t('capture.duration', { time: formatDuration(rec.durationSec) })
                  )}</span>`
                : '';
            const syms = (rec.symptomIds || [])
              .map((sId) => escapeHtml(window.I18N.t(`symptom.${sId}`)))
              .join(', ');

            return `
              <div class="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                <div class="space-y-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-bold text-cyan-300 print-text-dark">${escapeHtml(envLabel)}</span>
                    <span class="font-mono text-slate-400 print-text-muted">${escapeHtml(dateStr)}</span>
                    ${durBadge}
                  </div>
                  <div class="text-slate-300 print-text-dark">${syms}</div>
                </div>
                <div class="flex flex-wrap items-center gap-3 font-mono text-slate-300 print-text-dark shrink-0">
                  <span>${escapeHtml(window.I18N.t('metric.spl.short'))}: <strong>${window.I18N.formatNumber(m.dbSPL ?? m.spl, 1)} dB</strong></span>
                  <span>${escapeHtml(window.I18N.t('metric.dominant_band'))}: <strong>${rec.dominantBand || 1000} Hz</strong></span>
                </div>
              </div>
            `;
          })
          .join('');

        elEventsCard.innerHTML = `
          <h3 class="text-sm sm:text-base font-bold text-white print-text-dark">${escapeHtml(
            window.I18N.t('report.events_table.heading')
          )}</h3>
          <div class="space-y-2">${rowsHtml}</div>
        `;
      }
    },

    addFittingVisit() {
      const dateEl = document.getElementById('fitting-date');
      const noteEl = document.getElementById('fitting-note');
      const rawDate = dateEl ? dateEl.value.trim() : '';

      if (!isValidDateYMD(rawDate)) {
        this.showToast(window.I18N.t('fitting.invalid_date'), true);
        return;
      }

      const rawNote = noteEl ? noteEl.value.trim().slice(0, 300) : '';
      const newVisit = {
        id: `fit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        date: rawDate,
        note: rawNote
      };

      this.fittings.push(newVisit);
      this.fittings.sort((a, b) => b.date.localeCompare(a.date));
      this.selectedFittingId = newVisit.id;
      this._saveFittingsToStorage();

      if (noteEl) noteEl.value = '';

      this.renderHistory();
      this.renderReport();
      this.showToast(window.I18N.t('fitting.added'));
    },

    _renderFittingSection() {
      const dateEl = document.getElementById('fitting-date');
      if (dateEl && !dateEl.value) {
        dateEl.value = formatDateYMD(Date.now());
      }

      const listEl = document.getElementById('fitting-list');
      const selectEl = document.getElementById('compare-select');

      const sortedFittings = [...(this.fittings || [])].sort((a, b) =>
        b.date.localeCompare(a.date)
      );

      if (sortedFittings.length === 0) {
        this.selectedFittingId = null;
        if (listEl) {
          listEl.innerHTML = `<div class="text-xs text-slate-400 py-1">${escapeHtml(
            window.I18N.t('fitting.empty')
          )}</div>`;
        }
        if (selectEl) {
          selectEl.innerHTML = `<option value="">—</option>`;
          selectEl.disabled = true;
        }
        this._renderFittingComparison();
        return;
      }

      if (
        !this.selectedFittingId ||
        !sortedFittings.some((f) => f.id === this.selectedFittingId)
      ) {
        this.selectedFittingId = sortedFittings[0].id;
      }

      if (selectEl) {
        selectEl.disabled = false;
        selectEl.innerHTML = sortedFittings
          .map((f) => {
            const noteText = formatFittingNote(f.note);
            const label = noteText
              ? `${f.date} — ${noteText.slice(0, 48)}`
              : f.date;
            const selectedAttr = f.id === this.selectedFittingId ? ' selected' : '';
            return `<option value="${escapeHtml(f.id)}"${selectedAttr}>${escapeHtml(
              label
            )}</option>`;
          })
          .join('');
      }

      if (listEl) {
        listEl.innerHTML = sortedFittings
          .map((f) => {
            const noteText = formatFittingNote(f.note);
            return `
              <div class="flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono font-bold text-teal-300">${escapeHtml(f.date)}</span>
                  ${
                    noteText
                      ? `<span class="text-slate-300">${escapeHtml(noteText)}</span>`
                      : ''
                  }
                </div>
                <button type="button" data-delete-fitting="${escapeHtml(
                  f.id
                )}" class="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40">
                  ${escapeHtml(window.I18N.t('fitting.delete'))}
                </button>
              </div>
            `;
          })
          .join('');

        listEl.querySelectorAll('[data-delete-fitting]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-delete-fitting');
            if (id && window.confirm(window.I18N.t('fitting.delete_confirm'))) {
              this.fittings = this.fittings.filter((item) => item.id !== id);
              if (this.selectedFittingId === id) {
                this.selectedFittingId = this.fittings[0] ? this.fittings[0].id : null;
              }
              this._saveFittingsToStorage();
              this.renderHistory();
              this.renderReport();
            }
          });
        });
      }

      this._renderFittingComparison();
    },

    _renderFittingComparison() {
      const container = document.getElementById('report-compare');
      if (!container) return;

      const sortedFittings = [...(this.fittings || [])].sort((a, b) =>
        b.date.localeCompare(a.date)
      );
      if (sortedFittings.length === 0) {
        container.innerHTML = `<div class="text-xs text-slate-400 print-text-muted">${escapeHtml(
          window.I18N.t('fitting.empty')
        )}</div>`;
        return;
      }

      const visit =
        sortedFittings.find((f) => f.id === this.selectedFittingId) || sortedFittings[0];
      const visitDateStr = visit.date;
      const visitMs = fittingDateToMs(visitDateStr);

      const beforeEvents = [];
      const afterEvents = [];
      for (let i = 0; i < this.logs.length; i++) {
        const rec = this.logs[i];
        const ts = Number(rec.timestamp) || 0;
        const recDateStr = formatDateYMD(ts);
        if (recDateStr < visitDateStr) {
          beforeEvents.push(rec);
        } else {
          afterEvents.push(rec);
        }
      }

      const noteCaveatHtml = `<p class="text-[11px] text-slate-400 print-text-muted italic pt-1">${escapeHtml(
        window.I18N.t('compare.note')
      )}</p>`;

      if (beforeEvents.length === 0 || afterEvents.length === 0) {
        container.innerHTML = `
          <div class="bg-slate-950/80 border border-slate-800 rounded-lg p-3.5 text-xs text-slate-300 print-text-dark">
            ${escapeHtml(window.I18N.t('compare.not_enough'))}
          </div>
          ${noteCaveatHtml}
        `;
        return;
      }

      const DAY_MS = 86400 * 1000;
      const minBeforeTs = Math.min(...beforeEvents.map((e) => Number(e.timestamp) || visitMs));
      const beforeSpanDays = Math.max(1, (visitMs - minBeforeTs) / DAY_MS);
      const beforePerWeek = Math.round((beforeEvents.length / (beforeSpanDays / 7)) * 10) / 10;

      const maxAfterTs = Math.max(
        Date.now(),
        ...afterEvents.map((e) => Number(e.timestamp) || visitMs)
      );
      const afterSpanDays = Math.max(1, (maxAfterTs - visitMs) / DAY_MS);
      const afterPerWeek = Math.round((afterEvents.length / (afterSpanDays / 7)) * 10) / 10;

      const summarizeSide = (events, perWeek) => {
        const n = events.length;
        let stressSum = 0;
        let splSum = 0;
        const symCounts = {};
        SYMPTOM_IDS.forEach((s) => (symCounts[s] = 0));
        const ruleCounts = {};
        RULE_IDS.forEach((r) => (ruleCounts[r] = 0));

        events.forEach((rec) => {
          const m = rec.metrics || {};
          stressSum += Number(m.stress) || 0;
          splSum += Number(m.dbSPL ?? m.spl) || 0;
          (rec.symptomIds || []).forEach((s) => {
            if (s in symCounts) symCounts[s]++;
          });
          const trigs = Array.isArray(rec.ruleTriggers)
            ? rec.ruleTriggers
            : evaluateRules(rec);
          const seenRules = new Set();
          trigs.forEach((t) => {
            if (t && t.id in ruleCounts && !seenRules.has(t.id)) {
              seenRules.add(t.id);
              ruleCounts[t.id]++;
            }
          });
        });

        const symRates = {};
        SYMPTOM_IDS.forEach((s) => {
          symRates[s] = Math.round((symCounts[s] / n) * 100);
        });
        const ruleRates = {};
        RULE_IDS.forEach((r) => {
          ruleRates[r] = Math.round((ruleCounts[r] / n) * 100);
        });

        return {
          count: n,
          perWeek,
          meanStress: Math.round(stressSum / n),
          meanSpl: Math.round((splSum / n) * 10) / 10,
          symRates,
          ruleRates
        };
      };

      const bStat = summarizeSide(beforeEvents, beforePerWeek);
      const aStat = summarizeSide(afterEvents, afterPerWeek);

      const formatChangeCell = (beforeVal, afterVal, mode, unitSuffix = '') => {
        const diff = afterVal - beforeVal;
        const decimals = mode === 'db' || mode === 'rate' ? 1 : 0;
        const absDiffStr = window.I18N.formatNumber(Math.abs(diff), decimals);
        const signedStr =
          (diff > 0 ? '+' : diff < 0 ? '−' : '') + absDiffStr + unitSuffix;

        if (mode === 'neutral') {
          return `<span class="inline-flex items-center gap-1 font-mono text-slate-400 print-text-muted">${escapeHtml(
            signedStr
          )}</span>`;
        }

        let isSame = false;
        if (mode === 'db') {
          isSame = Math.abs(diff) <= 1.0;
        } else if (mode === 'pctPoints') {
          isSame = Math.abs(diff) <= 5;
        } else {
          const rel = beforeVal > 0 ? Math.abs(diff) / beforeVal : Math.abs(diff);
          isSame = rel <= 0.05;
        }

        if (isSame) {
          return `<span class="inline-flex items-center gap-1 font-mono text-slate-400 print-text-muted">→ ${escapeHtml(
            signedStr
          )} (${escapeHtml(window.I18N.t('compare.same'))})</span>`;
        }
        if (diff < 0) {
          return `<span class="inline-flex items-center gap-1 font-mono font-semibold text-emerald-400 print-text-dark">↓ ${escapeHtml(
            signedStr
          )} (${escapeHtml(window.I18N.t('compare.improved'))})</span>`;
        }
        return `<span class="inline-flex items-center gap-1 font-mono font-semibold text-rose-400 print-text-dark">↑ ${escapeHtml(
          signedStr
        )} (${escapeHtml(window.I18N.t('compare.worse'))})</span>`;
      };

      const perWeekUnit = window.I18N.t('compare.per_week_unit');
      const rows = [
        {
          label: window.I18N.t('compare.events'),
          beforeStr: String(bStat.count),
          afterStr: String(aStat.count),
          changeHtml: formatChangeCell(bStat.count, aStat.count, 'neutral', '')
        },
        {
          label: window.I18N.t('compare.per_week'),
          beforeStr: `${window.I18N.formatNumber(bStat.perWeek, 1)}${perWeekUnit}`,
          afterStr: `${window.I18N.formatNumber(aStat.perWeek, 1)}${perWeekUnit}`,
          changeHtml: formatChangeCell(bStat.perWeek, aStat.perWeek, 'rate', perWeekUnit)
        },
        {
          label: window.I18N.t('compare.stress'),
          beforeStr: `${bStat.meanStress}%`,
          afterStr: `${aStat.meanStress}%`,
          changeHtml: formatChangeCell(bStat.meanStress, aStat.meanStress, 'pctPoints', '%')
        },
        {
          label: window.I18N.t('compare.spl'),
          beforeStr: `${window.I18N.formatNumber(bStat.meanSpl, 1)} dB`,
          afterStr: `${window.I18N.formatNumber(aStat.meanSpl, 1)} dB`,
          changeHtml: formatChangeCell(bStat.meanSpl, aStat.meanSpl, 'db', ' dB')
        }
      ];

      SYMPTOM_IDS.forEach((sId) => {
        const bRate = bStat.symRates[sId];
        const aRate = aStat.symRates[sId];
        if (bRate > 0 || aRate > 0) {
          rows.push({
            label: window.I18N.t('compare.symptom_rate', {
              symptom: window.I18N.t(`symptom.${sId}`)
            }),
            beforeStr: `${bRate}%`,
            afterStr: `${aRate}%`,
            changeHtml: formatChangeCell(bRate, aRate, 'pctPoints', '%')
          });
        }
      });

      RULE_IDS.forEach((rId) => {
        const bRate = bStat.ruleRates[rId];
        const aRate = aStat.ruleRates[rId];
        if (bRate > 0 || aRate > 0) {
          rows.push({
            label: window.I18N.t('compare.rule_rate', {
              rule: window.I18N.t(`rule.${rId}.title`)
            }),
            beforeStr: `${bRate}%`,
            afterStr: `${aRate}%`,
            changeHtml: formatChangeCell(bRate, aRate, 'pctPoints', '%')
          });
        }
      });

      const visitNote = formatFittingNote(visit.note);
      const visitHeaderHtml = `
        <div class="flex flex-wrap items-center justify-between gap-2 bg-teal-500/10 border border-teal-500/30 rounded-lg px-3 py-2 text-xs">
          <span class="font-bold text-teal-300 print-text-dark">${escapeHtml(
            window.I18N.t('history.fitting_marker', { date: visitDateStr })
          )}</span>
          ${
            visitNote
              ? `<span class="text-slate-300 print-text-dark italic">${escapeHtml(
                  visitNote
                )}</span>`
              : ''
          }
        </div>
      `;

      const tableRowsHtml = rows
        .map(
          (r) => `
          <tr class="border-t border-slate-800">
            <td class="py-2 pr-3 font-medium text-slate-200 print-text-dark">${escapeHtml(
              r.label
            )}</td>
            <td class="py-2 px-3 font-mono text-slate-300 print-text-dark text-right">${escapeHtml(
              r.beforeStr
            )}</td>
            <td class="py-2 px-3 font-mono text-slate-200 print-text-dark text-right font-semibold">${escapeHtml(
              r.afterStr
            )}</td>
            <td class="py-2 pl-3 text-right">${r.changeHtml}</td>
          </tr>
        `
        )
        .join('');

      container.innerHTML = `
        ${visitHeaderHtml}
        <div class="overflow-x-auto">
          <table class="w-full text-xs text-left border-collapse">
            <thead>
              <tr class="text-slate-400 print-text-muted border-b border-slate-800">
                <th class="pb-2 pr-3 font-semibold">${escapeHtml(
                  window.I18N.t('compare.metric')
                )}</th>
                <th class="pb-2 px-3 font-semibold text-right">${escapeHtml(
                  window.I18N.t('compare.before', { date: visitDateStr })
                )}</th>
                <th class="pb-2 px-3 font-semibold text-right">${escapeHtml(
                  window.I18N.t('compare.after', { date: visitDateStr })
                )}</th>
                <th class="pb-2 pl-3 font-semibold text-right">${escapeHtml(
                  window.I18N.t('compare.change')
                )}</th>
              </tr>
            </thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>
        ${noteCaveatHtml}
      `;
    },

    showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      if (!toast) return;
      if (this.toastTimer) clearTimeout(this.toastTimer);

      toast.textContent = message;
      toast.className = isError
        ? 'no-print fixed bottom-5 right-5 z-50 max-w-sm bg-slate-900 border border-rose-500/70 text-rose-200 px-4 py-3 rounded-xl shadow-2xl text-xs sm:text-sm font-medium'
        : 'no-print fixed bottom-5 right-5 z-50 max-w-sm bg-slate-900 border border-cyan-500/60 text-slate-100 px-4 py-3 rounded-xl shadow-2xl text-xs sm:text-sm font-medium';

      this.toastTimer = setTimeout(() => {
        toast.classList.add('hidden');
      }, 4500);
    }
  };

  window.AcousticApp = AcousticApp;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AcousticApp.init());
  } else {
    AcousticApp.init();
  }
}
