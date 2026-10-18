# AcousticLog – Audiological Spectrum Detective & Fitting Assistant

**AcousticLog** is a zero-backend, offline-first Progressive Web App (PWA) designed for hearing aid users and clinical audiologists. It captures real-world annoying acoustic environments, extracts objective psychoacoustic and spectral features in real time using the Web Audio API, and translates patient complaints into actionable, channel-specific hearing aid fine-tuning adjustments.

---

## 1. The Clinical Problem

During follow-up appointments, hearing aid wearers frequently struggle to describe unpleasant auditory experiences in their daily lives. Patients often use vague terms such as *"the restaurant was too sharp,"* *"traffic drowns out speech,"* *"dishes clattering hurt my ears,"* or *"my own voice sounds like I'm talking inside a barrel."*

Because the audiologist cannot reproduce that exact acoustic scene inside a sound-treated clinic booth, fine-tuning parameters such as **Maximum Power Output (MPO)**, **G50/G80 channel gains**, **Compression Ratio (CR)**, **Transient Noise Reduction**, or **Beamforming directionality** often relies on trial and error.

**AcousticLog bridges this gap:** when the user encounters a frustrating acoustic environment, they press **Start Capture** to measure continuously for as long as needed (from 2 seconds up to 10 minutes), press **Stop & Tag** to log their subjective symptoms, and bring a structured, A4-printable **Audiologist Clinical Report** to their next fitting session.

---

## 2. Key Features

- **Live 10-Band Audiological Spectrum Analyzer:**
  - Real-time Fast Fourier Transform (FFT) mapped to the 10 standard audiometric fitting channels (`125 Hz` to `8000 Hz`).
  - Toggleable **10-Band Bar Chart** (with Peak-Hold markers and semi-transparent **Speech Banana** overlay) and **Scrolling Waterfall Spectrogram**.
  - Live metric cards: **Estimated dB SPL** (with calibration offset slider), **Crest Factor (dB)**, **Spectral Centroid (Hz)**, **Upward Spread of Masking Ratio – USMR (dB)**, **Possible Feedback Detector (Hz)**, and a **0–100% Acoustic Stress Gauge**.
- **Built-in Demo Noise Synthesizer:**
  - Allows testing and clinical demonstration without an external noise source using Web Audio oscillators, noise buffers, and `BiquadFilterNode` chains:
    - **Restaurant Clatter:** Pink/speech babble bed with stochastic `3000–4000 Hz` high-crest transient clatter spikes.
    - **Traffic Rumble:** Intense `125–500 Hz` low-frequency band-passed rumble demonstrating upward spread of masking.
    - **Feedback Whistle:** Steady speech-band room tone with an intermittent `~3150 Hz` sine whistle (`±8 Hz` wobble, gated on for `0.75–1.5 s` and off for `0.5–1.1 s`) for demonstrating narrowband acoustic feedback detection without false-triggering transient impulse rules.
- **Start/Stop GDPR-Safe Environment Capture & Hearing Aid Context:**
  - Manual start/stop recording (minimum 2 seconds, automatic safety stop at 10 minutes) that samples spectral frames every 50 ms using a drift-compensated timer and constant-memory running aggregates (band power sums, peak holds, max Crest Factor, possible-feedback frame share and median frequency, and running sums for Centroid, USMR, SPL, and stress — no raw audio stored) and opens a clinical symptom modal (`sharp`, `masking`, `impulses`, `reverb`, `occlusion`, `whistle`), environment selector (`restaurant`, `street`, `office`, `home_tv`, `store`), and **Hearing Aid Context** selector (active program `auto`, `quiet`, `noise`, `music`, `phone`, `other`, `unknown` and volume offset `-3` to `+3` or `unknown`, pre-filled from the last capture via `acousticlog_last_ctx`).
- **Device Profile & Program/Volume Report Table:**
  - Users can save their hearing aid brand and model once in the Clinical Report tab (`localStorage` key `acousticlog_device`). The report prints the device header and a **Program & Volume Context** breakdown showing event counts, mean acoustic stress, and mean volume step per program, plus a clinical alert when volume was raised to `+2` or higher.
- **Fitting Visits & Before / After Comparison:**
  - Log clinical fitting appointments (`date` + optional `note`, stored in `acousticlog_fittings`), displayed as chronological markers in the Log History and used in the Clinical Report to compare events strictly **before** vs. **from** a selected fitting visit (event count, normalized events/week, mean stress, mean dB SPL, per-symptom share, and per-rule trigger share with directional improvement indicators).
- **5-Language Instant Switching (No Reload):**
  - Full UI, audiological terminology, Speech Banana phoneme overlays, log history, and clinical fitting rules in **English (EN, default)**, **German (DE)**, **French (FR)**, **Hungarian (HU)**, and **Polish (PL)**.
  - Logs are stored in `localStorage` using language-agnostic IDs and numeric vectors so switching languages updates historical reports on the fly.
- **Audiologist Clinical Report & Print Stylesheet:**
  - Aggregates all logged events into a **10-Channel Problem-Frequency Heatmap**, program/volume context summary, before/after fitting comparison, and deterministic fine-tuning recommendations formatted for **A4 PDF export / printing** (`@media print`).
- **JSON Backup, Export & Device Transfer:**
  - Export and import the complete clinical log as a validated `.json` backup file to back up data or move logs between a smartphone and a clinic computer without any cloud account or server.

---

## 3. Backup, Export & Moving to Another Device

Because all logged events, device profile settings, and fitting visits live exclusively in the browser's `localStorage` (`acousticlog_v1_logs`, `acousticlog_device`, `acousticlog_fittings`, `acousticlog_last_ctx`), clearing browser data or switching devices would otherwise leave data behind. The **Log History** tab provides built-in JSON backup and restore tools:

### Exporting a JSON Backup (Format 2)
Clicking **Export JSON backup** downloads `acousticlog-backup-YYYY-MM-DD.json` formatted with 2-space indentation in **format 2**:
```json
{
  "app": "AcousticLog",
  "format": 2,
  "exportedAt": "2025-05-12T14:30:00.000Z",
  "calibrationDb": 0,
  "device": { "brand": "phonak", "model": "Audéo Lumity L90-R" },
  "fittings": [
    { "id": "fit_1", "date": "2025-05-02", "note": "Reduced G80 at 3-4 kHz" }
  ],
  "logs": [ ... ]
}
```
If no events have been logged yet, a toast notification is shown and no file is downloaded.

### Importing & Merging on Another Device
Clicking **Import JSON backup** lets you select a `.json` file (up to **5 MB**).
- **Accepted Formats:** Format 2 backup objects, legacy **Format 1** backup objects, or a bare JSON array of log records.
- **Strict Validation & Sanitization:** Every record is validated before import (`id` string, finite `timestamp`, valid `envId` and `symptomIds` subsets including `whistle`, 10 finite numbers in `metrics.bands` and `metrics.peaks`, finite scalar metrics plus optional feedback metrics `feedbackPct`/`feedbackHz`/`feedbackProm`, optional `context: { programId, volumeStep }`, known `ruleTriggers` IDs including `RULE_FEEDBACK`, optional `durationSec`/`frameCount`, and `note` truncated to 1,000 characters and always HTML-escaped on render). Fitting visits validate `date` (`YYYY-MM-DD` and a real calendar date) and `note` (`≤ 300` chars). Malformed records are dropped and never executed or injected.
- **Non-Destructive Merge by ID:** Imported events and fitting visits (`fittings`) are merged by `id` (existing IDs are skipped; missing `dominantBand` or `ruleTriggers` are recomputed automatically). Imported `device` profile is applied only if no local device profile is currently set, and the local microphone calibration offset (`calibrationDb`) on the receiving device is left untouched.

### Saving the Clinical Report as a PDF
In the **Clinical Report** tab, click **Print / Export PDF** to invoke the browser's print engine (styled with dedicated `@media print` A4 rules):
- **Desktop (Chrome, Edge, Firefox):** In the print dialog, set the **Destination / Printer** dropdown to **"Save as PDF"** (or *"Microsoft Print to PDF"*) and click **Save**.
- **Android (Chrome):** When the system print preview opens, tap the printer selector at the top, choose **"Save as PDF"**, and tap the circular **PDF download** button.
- **iOS / iPadOS (Safari):** In the print Options sheet, **pinch outward (zoom in)** with two fingers on the report preview thumbnail to open it as a full-screen PDF, or tap the **Share** icon at the top of the print dialog and select **"Save to Files"**.

---

## 4. Privacy by Design (GDPR Compliant)

AcousticLog **never records, stores, or transmits raw audio or voice snippets**.
- Microphone processing happens exclusively in volatile memory inside the browser's `AudioContext`.
- Only statistical spectral envelopes (10 band power averages, peak levels, Crest Factor, Spectral Centroid, and USMR) are saved locally in the user's browser (`localStorage` key `acousticlog_v1_logs`).
- Zero backend servers, zero analytics trackers, zero external API calls.

---

## 5. DSP Architecture & Mathematical Formulas

### Raw Audio Stream Constraints
To prevent the operating system from distorting acoustic measurements, `navigator.mediaDevices.getUserMedia` is requested with all voice-call DSP disabled:
```js
{
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1
  }
}
```
The stream feeds a Web Audio `AnalyserNode` configured with `fftSize = 4096` (~`11.72 Hz` bin resolution at `48 kHz`) and `smoothingTimeConstant = 0.2`.

### 1. Band Energy Aggregation (Power Summing)
Decibel values from `getFloatFrequencyData()` are **never averaged directly**. Each FFT bin $i$ within a band's lower and upper frequency bounds is converted from dBFS to linear power, summed, and converted back to dB (with a floor guard against $-\infty$):

$$P_{\text{band}} = \sum_{i=i_{\min}}^{i_{\max}} 10^{\left(\frac{L_i}{10}\right)}, \qquad L_{\text{band (dBFS)}} = 10 \cdot \log_{10}\!\left(\max(P_{\text{band}}, 10^{-12})\right)$$

### 2. Estimated Sound Pressure Level (dB SPL)
Computed from the time-domain Root Mean Square ($\text{RMS}$) amplitude via `getFloatTimeDomainData()` plus a reference 94 dB SPL full-scale offset and user calibration offset $C_{\text{cal}}$:

$$\text{RMS} = \sqrt{\frac{1}{N}\sum_{n=0}^{N-1} x[n]^2}, \qquad \text{dB SPL} = 20 \cdot \log_{10}(\max(\text{RMS}, 10^{-6})) + 94 + C_{\text{cal}}$$

### 3. Crest Factor (250 ms Rolling Time-Domain Window)
Measures impulsive transients (e.g., cutlery clatter, slamming doors) by comparing peak amplitude to RMS amplitude in decibels over a rolling **250 ms** time-domain window:

$$\text{CF}_{\text{dB}} = 20 \cdot \log_{10}\!\left(\frac{\max_{250\text{ms}} |x[n]|}{\text{RMS}_{250\text{ms}}}\right) = \text{Peak}_{\text{dB}} - \text{RMS}_{\text{dB}}$$

- **Clinical Threshold:** $\text{CF}_{\text{dB}} > 14\text{ dB}$ indicates strong transient impulses requiring Impulse/Transient Noise Reduction and faster AGC attack times.

### 4. Spectral Centroid (Hz)
Represents the "center of gravity" of the spectrum using linear bin magnitudes $a_i = 10^{L_i / 20}$:

$$f_c = \frac{\sum_{i} f_i \cdot a_i}{\sum_{i} a_i}$$

- **Clinical Threshold:** $f_c > 2500\text{ Hz}$ correlates with perceived sharpness, tinny/metallic timbre, or excessive high-frequency gain.

### 5. Upward Spread of Masking Ratio (USMR)
Compares total acoustic energy in the low-frequency vowel/noise bands (`125–500 Hz`) against the primary speech consonant/formant bands (`1000–4000 Hz`):

$$\text{USMR}_{\text{dB}} = E_{125\text{–}500\text{ Hz}}\text{ (dB)} - E_{1000\text{–}4000\text{ Hz}}\text{ (dB)}$$

- **Clinical Threshold:** $\text{USMR}_{\text{dB}} > +6\text{ dB}$ indicates severe low-frequency dominance capable of masking mid-to-high frequency consonants on the basilar membrane.

### 6. Possible Acoustic Feedback (Whistling) Detection
Detects sustained narrowband tonal peaks in the `1500–6000 Hz` feedback-prone region while rejecting brief clatter impulses:

1. **Peak Search & Parabolic Interpolation:** Find the highest FFT bin $k_{\max}$ between `1500 Hz` and `6000 Hz` and refine its center frequency $f_{\text{peak}}$ via 3-point parabolic interpolation over $(k_{\max}-1, k_{\max}, k_{\max}+1)$.
2. **Spectral Prominence:** Compute the median bin level (in dB) within $\pm 400\text{ Hz}$ of $k_{\max}$, excluding the immediate $\pm 2$ bins around the peak:
   $$\text{Prominence}_{\text{dB}} = L_{k_{\max}} - \text{median}_{|f_i - f_{\text{peak}}| \le 400\text{ Hz},\, |i - k_{\max}| > 2}(L_i)$$
3. **Candidate Gate:** A frame is a feedback candidate if $\text{Prominence}_{\text{dB}} \ge 20\text{ dB}$ and the calibrated peak level is $\ge 40\text{ dB SPL}$.
4. **Time-Based Persistence (`performance.now()`):** Independent of rendering frame rate, if the candidate frequency stays within $\pm 30\text{ Hz}$ of the previous candidate, elapsed time is accumulated (`durationMs`); otherwise persistence restarts. `detected` becomes `true` once persistence reaches $\ge 300\text{ ms}$ (releasing after `150 ms` without a candidate) so short `5–40 ms` dish clatter spikes never trigger false positives.
5. **Known Limits:** Because an external continuous pure-tone electronic beep (e.g., microwave, crosswalk, or alarm tone between `1.5–6 kHz`) shares the same narrowband sinusoidal signature as acoustic hearing aid feedback, the UI and clinical report always label findings as **"possible acoustic feedback"** for correlation with the patient's `whistle` symptom and in-clinic feedback manager verification.

---

## 6. The 10 Audiological Frequency Bands

| Band # | Center Freq (Hz) | Cutoff Range (Hz) | Primary Speech & Clinical Relevance |
| :---: | :---: | :---: | :--- |
| **1** | **125 Hz** | 88 – 177 Hz | Fundamental voice pitch ($F_0$), HVAC & traffic rumble |
| **2** | **250 Hz** | 177 – 354 Hz | Vowel power, low-frequency fullness, **occlusion effect** zone |
| **3** | **500 Hz** | 354 – 707 Hz | First formant ($F_1$), vowel warmth, upward masking origin |
| **4** | **1000 Hz** | 707 – 1225 Hz | Vowel-to-consonant transition, nasal consonants (`/m/`, `/n/`) |
| **5** | **1500 Hz** | 1225 – 1768 Hz | Second formant ($F_2$), voiced plosives & liquids (`/l/`, `/r/`) |
| **6** | **2000 Hz** | 1768 – 2500 Hz | Critical speech intelligibility locus, plosives (`/p/`, `/t/`, `/k/`) |
| **7** | **3000 Hz** | 2500 – 3536 Hz | Ear canal resonance peak, clatter annoyance, MPO sensitivity |
| **8** | **4000 Hz** | 3536 – 5000 Hz | Affricates & fricatives (`/f/`, `/th/`, `/sh/`), metallic sharpness |
| **9** | **6000 Hz** | 5000 – 7071 Hz | Sibilant clarity (`/s/`, `/z/`), acoustic feedback & hiss zone |
| **10** | **8000 Hz** | 7071 – 11000 Hz | High-frequency air, ultra-high sibilance |

---

## 7. Deterministic Rule Engine Overview

When an event is captured, `app.js` evaluates both objective DSP metrics and patient-reported symptoms to trigger language-neutral rule objects stored in `ruleTriggers`:

| Rule ID | Trigger Condition | Clinical Fitting Action |
| :--- | :--- | :--- |
| `RULE_MPO_HIGH` | `Spectral Centroid > 2500 Hz` or `sharp` symptom reported | Reduce **MPO** and **G80** (loud input gain) by `{db} dB` at `{band} Hz`; increase high-frequency Compression Ratio. |
| `RULE_TRANSIENT` | `Crest Factor > 14 dB` or `impulses` symptom reported | Set **Transient / Impulse Noise Reduction** (e.g., SoundRelax) to *Strong* and shorten AGC attack time. |
| `RULE_MASKING` | `USMR > +6 dB` or `masking` symptom reported | Reduce low-band gain (`125–500 Hz`) in Noise Program, activate narrow **Beamforming**, and support `2–3 kHz` speech clarity. |
| `RULE_OCCLUSION` | `occlusion` symptom reported (`250–500 Hz` buildup) | Reduce **G50/G65** gain below `500 Hz`, run **Own Voice Processing (OVP)** calibration, or increase acoustic vent size. |
| `RULE_REVERB` | `reverb` symptom reported | Enable **Dereverberation / EchoBlock**, lengthen AGC release time to prevent pumping, and slightly reduce `500–1000 Hz` diffuse gain. |
| `RULE_LOUD` | Estimated `dB SPL > 80 dB` | Lower overall **G80** (loud input gain) by `3–5 dB`, verify wideband **MPO** ceiling against patient UCL, and increase stationary Noise Reduction. |
| `RULE_FEEDBACK` | `feedbackPct >= 10%` of capture frames or `whistle` symptom reported | Re-run the **Feedback Manager / Feedback Test**, inspect dome or earmould fit and vent size, and if needed reduce high-frequency gain around `{hz} Hz`. |

---

## 8. File Structure (Strict 7-File Architecture)

```text
./
├── index.html      # App shell, Tailwind CDN, 3 clinical views, symptom modal
├── style.css       # Custom sliders, Canvas layout, heatmap scale, @media print A4 rules
├── i18n.js         # Complete 5-language dictionary (EN, DE, FR, HU, PL) + window.I18N
├── dsp-engine.js   # Web Audio FFT analyzer, 250ms Crest Factor, Demo Synth (window.DSPEngine)
├── app.js          # Dual-role Service Worker + UI controller, Canvas renderer & Rule Engine
├── manifest.json   # PWA manifest with inline SVG data-URI icons
└── README.md       # Technical documentation & deployment guide
```

> **Single-File Service Worker Note:** To adhere strictly to the 7-file architecture, `app.js` detects its execution context (`if (typeof window === 'undefined')`) and acts as the offline-first Service Worker when registered via `navigator.serviceWorker.register('./app.js')` (network-first with cache fallback for same-origin files so GitHub Pages updates appear immediately, and cache-first with background refresh for the Tailwind CDN).

---

## 9. Running Locally

Because modern browsers block `navigator.mediaDevices.getUserMedia()` and Service Worker registration on `file://` URLs for security reasons, serve the folder over `localhost` using any static HTTP server:

```bash
# Python 3 built-in HTTP server
python -m http.server 8000
```

Then open **`http://localhost:8000`** in Chrome, Edge, Firefox, or Safari.

---

## 10. Deploying to GitHub Pages

AcousticLog uses relative paths (`./`) everywhere and requires **zero build steps**:

1. Push all 7 files (`index.html`, `style.css`, `i18n.js`, `dsp-engine.js`, `app.js`, `manifest.json`, `README.md`) to the root of a GitHub repository.
2. In your GitHub repository, navigate to **Settings → Pages**.
3. Under **Build and deployment → Source**, select **Deploy from a branch**.
4. Choose branch **`main`** (or `master`) and folder **`/ (root)`**, then click **Save**.
5. Within 1–2 minutes, your PWA will be live over HTTPS at `https://<username>.github.io/<repo-name>/` with full microphone and offline installation support.

---

## 11. Calibration Note & Medical Disclaimer

- **Microphone Calibration:** Built-in smartphone and laptop MEMS microphones vary in sensitivity, frequency response roll-off below `150 Hz`, and maximum acoustic overload point (AOP). Use the **Calibration Offset (dB)** slider in the top bar to align readings against a reference Type 2 Sound Level Meter if absolute SPL accuracy is required.
- **Medical Disclaimer:** *AcousticLog is an educational, observational, and communication support tool—NOT a certified medical device or ANSI/IEC Class 1/2 Sound Level Meter. Generated fitting suggestions are decision-support prompts intended strictly for review and interpretation by a licensed audiologist or hearing instrument specialist.*

---

## 12. License

Released under the **MIT License**. Free for personal, academic, and clinical use.
