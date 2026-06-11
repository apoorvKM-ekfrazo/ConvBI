'use strict';
/* VoiceManager — simplified: mic input (fills input field) + TTS playback.
   No live mode, no PTT, no state machine. */

const VOICES = {
  aria: {
    name: 'Aria', description: 'Warm & conversational',
    preferredVoiceNames: ['Microsoft Aria Online (Natural)','Microsoft Aria','Google UK English Female','Samantha','Karen','Aria'],
    pitch: 1.05, rate: 0.95
  },
  nova: {
    name: 'Nova', description: 'Professional & clear',
    preferredVoiceNames: ['Microsoft Jenny Online (Natural)','Microsoft Jenny','Google US English','Victoria','Moira','Nova'],
    pitch: 1.0, rate: 1.0
  },
  luna: {
    name: 'Luna', description: 'Soft & soothing',
    preferredVoiceNames: ['Microsoft Sonia Online (Natural)','Microsoft Sonia','Google UK English Female','Tessa','Fiona','Luna'],
    pitch: 1.1, rate: 0.88
  }
};

class VoiceManager {
  constructor(callbacks = {}) {
    this._voiceId    = 'aria';
    this._speed      = 1.0;
    this._micActive  = false;
    this._recognition = null;
    this._ttsTimer   = null;
    this._ttsSeq     = 0;
    this._callbacks  = callbacks;

    this._initRecognition();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.onvoiceschanged = () => {};
    }
  }

  // ── Mic input (toggle) ────────────────────────────────────────────────────────
  toggleMic() {
    if (this._micActive) this._stopMic();
    else                 this._startMic();
  }

  _startMic() {
    if (!this._recognition) {
      this._callbacks.onError?.('Speech recognition not supported — use Chrome or Edge.');
      return;
    }
    this._micActive = true;
    this._callbacks.onMicState?.(true);
    try {
      this._recognition.start();
    } catch (e) {
      if (!e.message?.includes('already started') && !e.message?.includes('InvalidState')) {
        this._micActive = false;
        this._callbacks.onMicState?.(false);
        this._callbacks.onError?.('Mic error: ' + e.message);
      }
    }
  }

  _stopMic() {
    this._micActive = false;
    this._callbacks.onMicState?.(false);
    try { this._recognition?.stop(); } catch (_) {}
  }

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const r = new SR();
    r.continuous     = true;
    r.interimResults = true;
    r.lang           = 'en-US';

    r.onresult = (event) => {
      if (!this._micActive) return;
      let interim = '', final = '';
      for (const result of event.results) {
        if (result.isFinal) final  += result[0].transcript;
        else                interim += result[0].transcript;
      }
      const text = (final || interim).trim();
      const qaInput = document.getElementById('qaInput');
      if (qaInput) qaInput.value = text;
      this._callbacks.onTranscript?.(text);
    };

    r.onend = () => {
      if (this._micActive) {
        // Auto-restart to keep mic open until user explicitly stops
        setTimeout(() => {
          if (this._micActive) {
            try { r.start(); } catch (_) {}
          }
        }, 100);
      } else {
        this._callbacks.onMicState?.(false);
      }
    };

    r.onerror = (e) => {
      if (e.error === 'no-speech') return;
      if (e.error === 'aborted')   return;
      this._micActive = false;
      this._callbacks.onMicState?.(false);
      this._callbacks.onError?.('Mic: ' + e.error);
    };

    this._recognition = r;
  }

  // ── TTS playback ──────────────────────────────────────────────────────────────
  speakText(text, voiceIdOverride) {
    if (!text) return;
    this._safeSpeak(text, voiceIdOverride);
  }

  stopSpeaking() {
    try { speechSynthesis?.cancel(); } catch (_) {}
    clearTimeout(this._ttsTimer);
    this._ttsSeq++;
    this._callbacks.onSpeakingState?.(false);
  }

  previewVoice(id) {
    const cfg = VOICES[id] || VOICES.aria;
    this._safeSpeak(`Hi, I'm ${cfg.name}. I'll be reading your data insights today.`, id);
  }

  setVoice(id) { if (VOICES[id]) this._voiceId = id; }
  setSpeed(v)  { this._speed = Math.min(1.3, Math.max(0.7, parseFloat(v))); }

  _safeSpeak(text, voiceIdOverride) {
    if (typeof speechSynthesis === 'undefined') return;

    const id  = voiceIdOverride || this._voiceId;
    const cfg = VOICES[id] || VOICES.aria;
    const seq = ++this._ttsSeq;

    try { speechSynthesis.cancel(); } catch (_) {}

    const doSpeak = () => {
      if (seq !== this._ttsSeq) return;
      try { speechSynthesis.resume(); } catch (_) {}

      const clean = this._cleanForSpeech(text);
      if (!clean) return;

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.voice  = this._selectBestVoice(cfg.preferredVoiceNames);
      utterance.pitch  = cfg.pitch;
      utterance.rate   = cfg.rate * this._speed;

      const charMs = 65;

      const finish = () => {
        if (seq !== this._ttsSeq) return;
        clearTimeout(this._ttsTimer);
        this._callbacks.onSpeakingState?.(false);
      };

      utterance.onstart = () => {
        if (seq !== this._ttsSeq) return;
        this._callbacks.onSpeakingState?.(true);

        clearTimeout(this._ttsTimer);
        const ceiling = Math.min(30_000, clean.length * charMs + 4_000);
        this._ttsTimer = setTimeout(() => {
          if (seq === this._ttsSeq) {
            this._callbacks.onSpeakingState?.(false);
          }
        }, ceiling);
      };

      utterance.onend   = finish;
      utterance.onerror = (ev) => {
        if (ev.error !== 'interrupted' && ev.error !== 'cancelled') {
          console.warn('[VoiceManager] TTS error:', ev.error);
        }
        finish();
      };

      // Startup watchdog: 5s if onstart never fires
      clearTimeout(this._ttsTimer);
      this._ttsTimer = setTimeout(() => {
        if (seq === this._ttsSeq) this._callbacks.onSpeakingState?.(false);
      }, 5_000);

      try {
        speechSynthesis.speak(utterance);
        setTimeout(() => {
          if (seq === this._ttsSeq) { try { speechSynthesis.resume(); } catch (_) {} }
        }, 600);
      } catch (e) {
        finish();
      }
    };

    setTimeout(doSpeak, 80);
  }

  _selectBestVoice(preferredNames) {
    const all = (typeof speechSynthesis !== 'undefined') ? speechSynthesis.getVoices() : [];
    if (!all.length) return null;
    for (const name of preferredNames) {
      const v = all.find(v => v.name.includes(name) && v.lang.startsWith('en'));
      if (v) return v;
    }
    return all.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('female'))
        || all.find(v => v.lang.startsWith('en'))
        || null;
  }

  _cleanForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, 'a code block')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/(\d+\.\d{3,})/g, n => parseFloat(n).toFixed(1))
      .replace(/\n+/g, '. ')
      .trim()
      .slice(0, 800);
  }
}

if (typeof window !== 'undefined') window.VoiceManager = VoiceManager;
