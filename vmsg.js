/* eslint-disable */

function pad2(n) {
  n |= 0;
  return n < 10 ? `0${n}` : `${Math.min(n, 99)}`;
}

// Source of the AudioWorklet processor which forwards captured PCM
// chunks to the main thread. Loaded from a blob URL so that no separate
// file needs to be hosted.
const WORKLET_SOURCE = `
class VMsgEncoderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("vmsg-encoder", VMsgEncoderProcessor);
`;

// NOTE: exported for tests, not part of the public API.
export function inlineWorker() {
  // TODO(Kagami): Cache compiled module in IndexedDB? It works in FF
  // and Edge, see: https://github.com/mdn/webassembly-examples/issues/4
  // Though gzipped WASM module currently weights ~70kb so it should be
  // perfectly cached by the browser itself.
  function fetchAndInstantiate(url, imports) {
    if (!WebAssembly.instantiateStreaming) return fetchAndInstantiateFallback(url, imports);
    const req = fetch(url, {credentials: "same-origin"});
    return WebAssembly.instantiateStreaming(req, imports).catch(err => {
      // https://github.com/Kagami/vmsg/issues/11
      if (err.message && err.message.indexOf("Argument 0 must be provided and must be a Response") > 0) {
        return fetchAndInstantiateFallback(url, imports);
      } else {
        throw err;
      }
    });
  }

  function fetchAndInstantiateFallback(url, imports) {
    return new Promise((resolve, reject) => {
      const req = new XMLHttpRequest();
      req.open("GET", url);
      req.responseType = "arraybuffer";
      req.onload = () => {
        resolve(WebAssembly.instantiate(req.response, imports));
      };
      req.onerror = reject;
      req.send();
    });
  }

  // Must be in sync with emcc settings!
  const TOTAL_STACK = 5 * 1024 * 1024;
  const TOTAL_MEMORY = 16 * 1024 * 1024;
  const WASM_PAGE_SIZE = 64 * 1024;
  let memory = null;
  let dynamicTop = TOTAL_STACK;
  // TODO(Kagami): Grow memory?
  function sbrk(increment) {
    const oldDynamicTop = dynamicTop;
    dynamicTop += increment;
    return oldDynamicTop;
  }
  // TODO(Kagami): LAME calls exit(-1) on internal error. Would be nice
  // to provide custom DEBUGF/ERRORF for easier debugging. Currenty
  // those functions do nothing.
  function exit(status) {
    postMessage({type: "internal-error", data: status});
  }

  function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // Assemble a 16-bit mono PCM WAV from the recorded chunks. The data
  // chunk contains exactly the recorded samples -- unlike the MP3 frame
  // stream, no encoder delay/padding is added, so both formats describe
  // the same [0, samples) boundary.
  function encodeWAV(chunks, totalSamples, sampleRate) {
    const bytesPerSample = 2;
    const dataSize = totalSamples * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);                        // fmt chunk size
    view.setUint16(20, 1, true);                         // PCM
    view.setUint16(22, 1, true);                         // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);            // block align
    view.setUint16(34, 8 * bytesPerSample, true);        // bits per sample
    writeAscii(view, 36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
    }
    return new Blob([buf], {type: "audio/wav"});
  }

  function u32be(buf, offset) {
    return (buf[offset] << 24 | buf[offset + 1] << 16 |
            buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
  }

  // Parse the Xing/Info + LAME tag of the first MP3 frame to recover the
  // encoder delay/padding. Those samples are part of the MP3 frame grid
  // but NOT part of the recording, so they must be excluded from the
  // recording duration (and are, see `flushSession`).
  function parseLameTag(mp3) {
    let offset = 0;
    // Skip ID3v2 tag if present.
    if (mp3.length > 10 && mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
      offset = 10 + ((mp3[6] & 0x7f) << 21 | (mp3[7] & 0x7f) << 14 |
                     (mp3[8] & 0x7f) << 7 | (mp3[9] & 0x7f));
    }
    if (mp3.length < offset + 0x24 + 4) return null;
    if (mp3[offset] !== 0xff || (mp3[offset + 1] & 0xe0) !== 0xe0) return null;
    const version = (mp3[offset + 1] >> 3) & 3;  // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const mono = (mp3[offset + 3] >> 6 & 3) === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const xing = offset + 4 + sideInfo;
    const magic = String.fromCharCode(
      mp3[xing], mp3[xing + 1], mp3[xing + 2], mp3[xing + 3]);
    if (magic !== "Xing" && magic !== "Info") return null;
    const flags = u32be(mp3, xing + 4);
    let p = xing + 8;
    let frames = null;
    if (flags & 1) { frames = u32be(mp3, p); p += 4; }
    // The LAME extension tag follows the Xing fields; its exact offset
    // varies between LAME versions, so locate it by signature. The
    // delay/padding triple lives at +0x15 relative to the tag start.
    const limit = Math.min(mp3.length - 0x18, xing + 8 + 128);
    let lame = -1;
    for (let q = xing + 8; q < limit; q++) {
      if (mp3[q] === 0x4c && mp3[q + 1] === 0x41 &&    // "LA"
          mp3[q + 2] === 0x4d && mp3[q + 3] === 0x45) { // "ME"
        lame = q;
        break;
      }
    }
    if (lame < 0) return {frames: frames, encDelay: null, encPadding: null};
    const d0 = mp3[lame + 0x15], d1 = mp3[lame + 0x16], d2 = mp3[lame + 0x17];
    return {
      frames: frames,
      encDelay: (d0 << 4) | (d1 >> 4),
      encPadding: ((d1 & 0xf) << 8) | d2,
    };
  }

  let FFI = null;
  // Current encoding session. Every "start" message opens a new session
  // with a fresh LAME encoder instance; a leftover session (recording
  // stopped without flush, or start-after-start) is disposed of first so
  // a stale encoder is never reused for a new take.
  let session = null;

  function freeSession() {
    if (session && session.ref) FFI.vmsg_free(session.ref);
    session = null;
  }

  function startSession(recId, rate, format) {
    freeSession();
    session = {
      recId: recId,
      rate: rate,
      format: format === "wav" ? "wav" : "mp3",
      ref: null,
      pcm_l: null,
      nextSeq: 0,
      samples: 0,
      chunks: 0,
      pcmChunks: format === "wav" ? [] : null,
    };
    if (format === "mp3") {
      const ref = FFI.vmsg_init(rate);
      if (!ref) {
        session = null;
        return false;
      }
      const pcm_l_ref = new Uint32Array(memory.buffer, ref, 1)[0];
      session.ref = ref;
      session.pcm_l = new Float32Array(memory.buffer, pcm_l_ref);
    }
    return true;
  }

  function encodeChunk(data) {
    if (session.format === "wav") {
      session.pcmChunks.push(data);
    } else {
      session.pcm_l.set(data);
      if (FFI.vmsg_encode(session.ref, data.length) < 0) return false;
    }
    session.samples += data.length;
    session.chunks += 1;
    session.nextSeq += 1;
    return true;
  }

  function flushSession() {
    const s = session;
    session = null;
    let blob = null;
    let tag = null;
    if (s.format === "wav") {
      blob = encodeWAV(s.pcmChunks, s.samples, s.rate);
    } else {
      if (FFI.vmsg_flush(s.ref) < 0) {
        FFI.vmsg_free(s.ref);
        return null;
      }
      const mp3_ref = new Uint32Array(memory.buffer, s.ref + 4, 1)[0];
      const size = new Uint32Array(memory.buffer, s.ref + 8, 1)[0];
      // Copy out of WASM memory before freeing the session.
      const mp3 = new Uint8Array(memory.buffer, mp3_ref, size).slice();
      tag = parseLameTag(mp3);
      blob = new Blob([mp3], {type: "audio/mpeg"});
      FFI.vmsg_free(s.ref);
    }
    return {
      blob: blob,
      format: s.format,
      rate: s.rate,
      samples: s.samples,
      chunks: s.chunks,
      // Duration of the actual recording. LAME delay/padding (present in
      // the MP3 frame grid) is deliberately excluded here.
      duration: s.samples / s.rate,
      frames: tag ? tag.frames : null,
      encDelay: tag ? tag.encDelay : null,
      encPadding: tag ? tag.encPadding : null,
    };
  }

  // https://github.com/brion/min-wasm-fail
  function testSafariWebAssemblyBug() {
    const bin = new Uint8Array([0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,5,3,1,0,1,7,8,1,4,116,101,115,116,0,0,10,16,1,14,0,32,0,65,1,54,2,0,32,0,40,2,0,11]);
    const mod = new WebAssembly.Module(bin);
    const inst = new WebAssembly.Instance(mod, {});
    // test storing to and loading from a non-zero location via a parameter.
    // Safari on iOS 11.2.5 returns 0 unexpectedly at non-zero locations
    return (inst.exports.test(4) !== 0);
  }

  onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
    case "init":
      const { wasmURL, shimURL } = msg.data;
      Promise.resolve().then(() => {
        if (self.WebAssembly && !testSafariWebAssemblyBug()) {
          delete self.WebAssembly;
        }
        if (!self.WebAssembly) {
          importScripts(shimURL);
        }
        memory = new WebAssembly.Memory({
          initial: TOTAL_MEMORY / WASM_PAGE_SIZE,
          maximum: TOTAL_MEMORY / WASM_PAGE_SIZE,
        });
        return {
          memory: memory,
          pow: Math.pow,
          exit: exit,
          powf: Math.pow,
          exp: Math.exp,
          sqrtf: Math.sqrt,
          cos: Math.cos,
          log: Math.log,
          sin: Math.sin,
          sbrk: sbrk,
        };
      }).then(Runtime => {
        return fetchAndInstantiate(wasmURL, {env: Runtime})
      }).then(wasm => {
        FFI = wasm.instance.exports;
        postMessage({type: "init", data: null});
      }).catch(err => {
        postMessage({type: "init-error", data: err.toString()});
      });
      break;
    case "start":
      if (!startSession(msg.recId, msg.data.rate, msg.data.format))
        return postMessage({type: "error", data: "vmsg_init"});
      postMessage({type: "started", recId: msg.recId});
      break;
    case "data":
      // Silently drop chunks of stale sessions (e.g. audio callbacks
      // posted before "stop" was processed, or after a new recording
      // has already started).
      if (!session || msg.recId !== session.recId) break;
      if (msg.seq !== session.nextSeq)
        return postMessage({type: "error", data: "vmsg_encode: out-of-order chunk " +
          msg.seq + " (expected " + session.nextSeq + ")"});
      if (!encodeChunk(msg.data))
        return postMessage({type: "error", data: "vmsg_encode"});
      break;
    case "stop":
      if (!session || msg.recId !== session.recId)
        return postMessage({type: "error", data: "vmsg_flush: no active session"});
      const result = flushSession();
      if (!result) return postMessage({type: "error", data: "vmsg_flush"});
      postMessage({type: "stop", recId: msg.recId, data: result});
      break;
    }
  };
}

function getUserMedia(constraints) {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const oldGetUserMedia = navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (!oldGetUserMedia) {
    return Promise.reject(new Error("getUserMedia is not implemented in this browser"));
  }
  return new Promise(function(resolve, reject) {
    oldGetUserMedia.call(navigator, constraints, resolve, reject);
  });
}

export class Recorder {
  constructor(opts = {}, onStop = null) {
    // Can't use relative URL in blob worker, see:
    // https://stackoverflow.com/a/22582695
    this.wasmURL = new URL(opts.wasmURL || "/static/js/vmsg.wasm", location).href;
    this.shimURL = new URL(opts.shimURL || "/static/js/wasm-polyfill.js", location).href;
    this.onStop = onStop;
    this.pitch = opts.pitch || 0;
    // Output format: "mp3" (default) or "wav". Both formats cover the
    // exact same sample range; the WAV never includes LAME delay/padding.
    this.format = opts.format === "wav" ? "wav" : "mp3";
    this.stream = null;
    this.audioCtx = null;
    this.gainNode = null;
    this.pitchFX = null;
    this.encNode = null;
    this.useWorklet = false;
    this.worker = null;
    this.workerURL = null;
    this.blob = null;
    this.blobURL = null;
    // Metadata of the last finished recording.
    this.duration = 0;
    this.samples = 0;
    this.chunks = 0;
    // Recording session state. `recId` is bumped on every start so that
    // the worker can tell chunks of different takes apart; `seq` numbers
    // the chunks within one take.
    this.recording = false;
    this.recId = 0;
    this.seq = 0;
    this.initResolve = null;
    this.initReject = null;
    this.startResolve = null;
    this.startReject = null;
    this.stopResolve = null;
    this.stopReject = null;
    Object.seal(this);
  }

  close() {
    if (this.encNode) this.encNode.disconnect();
    if (this.encNode && this.encNode.port) this.encNode.port.onmessage = null;
    if (this.encNode) this.encNode.onaudioprocess = null;
    if (this.stream) this.stopTracks();
    if (this.audioCtx && this.audioCtx.state !== "closed") this.audioCtx.close();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerURL) URL.revokeObjectURL(this.workerURL);
    if (this.blobURL) URL.revokeObjectURL(this.blobURL);
  }

  // Without pitch shift:
  //   [sourceNode] -> [gainNode] -> [encNode] -> [audioCtx.destination]
  //                                     |
  //                                     -> [worker]
  // With pitch shift:
  //   [sourceNode] -> [gainNode] -> [pitchFX] -> [encNode] -> [audioCtx.destination]
  //                                                  |
  //                                                  -> [worker]
  initAudio() {
    return getUserMedia({audio: true}).then((stream) => {
      this.stream = stream;
      const audioCtx = this.audioCtx = new (window.AudioContext
        || window.webkitAudioContext)();

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const gainNode = this.gainNode = (audioCtx.createGain
        || audioCtx.createGainNode).call(audioCtx);
      gainNode.gain.value = 1;
      sourceNode.connect(gainNode);

      const pitchFX = this.pitchFX = new Jungle(audioCtx);
      pitchFX.setPitchOffset(this.pitch);

      return this.initEncNode(audioCtx).then((encNode) => {
        this.encNode = encNode;
        pitchFX.output.connect(encNode);
        gainNode.connect(this.pitch === 0 ? encNode : pitchFX.input);
      });
    });
  }

  // Prefer AudioWorklet (ScriptProcessorNode is deprecated) and fall
  // back to ScriptProcessorNode when worklets are unavailable.
  initEncNode(audioCtx) {
    if (audioCtx.audioWorklet && typeof window.AudioWorkletNode === "function") {
      const url = URL.createObjectURL(new Blob(
        [WORKLET_SOURCE], {type: "application/javascript"}));
      return audioCtx.audioWorklet.addModule(url).then(() => {
        URL.revokeObjectURL(url);
        this.useWorklet = true;
        return new window.AudioWorkletNode(audioCtx, "vmsg-encoder", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
      }, () => {
        URL.revokeObjectURL(url);
        return this.createScriptNode(audioCtx);
      });
    }
    return Promise.resolve(this.createScriptNode(audioCtx));
  }

  createScriptNode(audioCtx) {
    this.useWorklet = false;
    return (audioCtx.createScriptProcessor
      || audioCtx.createJavaScriptNode).call(audioCtx, 0, 1, 1);
  }

  initWorker() {
    if (this.worker) return Promise.resolve();
    // https://stackoverflow.com/a/19201292
    const blob = new Blob(
      ["(", inlineWorker.toString(), ")()"],
      {type: "application/javascript"});
    const workerURL = this.workerURL = URL.createObjectURL(blob);
    const worker = this.worker = new Worker(workerURL);
    const { wasmURL, shimURL } = this;
    worker.onmessage = (e) => this.onWorkerMessage(e.data);
    worker.postMessage({type: "init", data: {wasmURL, shimURL}});
    return new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
  }

  onWorkerMessage(msg) {
    switch (msg.type) {
    case "init":
      if (this.initResolve) this.initResolve();
      break;
    case "init-error":
      this.close();
      if (this.initReject) this.initReject(new Error(msg.data));
      break;
    case "started":
      if (msg.recId !== this.recId) break;
      if (this.startResolve) this.startResolve();
      this.startResolve = this.startReject = null;
      break;
    case "stop":
      if (msg.recId !== this.recId) break;
      this.blob = msg.data.blob;
      this.blobURL = URL.createObjectURL(msg.data.blob);
      this.duration = msg.data.duration;
      this.samples = msg.data.samples;
      this.chunks = msg.data.chunks;
      if (this.onStop) this.onStop();
      if (this.stopResolve) this.stopResolve(this.blob);
      this.stopResolve = this.stopReject = null;
      break;
    case "error":
    case "internal-error":
      console.error("Worker error:", msg.data);
      if (this.startReject) this.startReject(new Error(String(msg.data)));
      if (this.stopReject) this.stopReject(new Error(String(msg.data)));
      this.startResolve = this.startReject = null;
      this.stopResolve = this.stopReject = null;
      this.close();
      break;
    }
  }

  init() {
    return this.initAudio().then(this.initWorker.bind(this));
  }

  // Can be called again after stopRecording(): a fresh audio graph and a
  // fresh encoder session are created for every take. Returns a promise
  // resolved once the worker has acknowledged the new session.
  startRecording() {
    if (!this.worker) throw new Error("missing worker initialization");
    if (this.recording) return Promise.reject(new Error("already recording"));
    return Promise.resolve()
      .then(() => {
        // stopRecording() closes the audio context, so the next take
        // needs a fresh capture graph.
        if (!this.stream || !this.audioCtx || this.audioCtx.state === "closed") {
          return this.initAudio();
        }
      })
      .then(() => {
        this.blob = null;
        if (this.blobURL) URL.revokeObjectURL(this.blobURL);
        this.blobURL = null;
        this.recId += 1;
        this.seq = 0;
        this.recording = true;
        const recId = this.recId;
        this.worker.postMessage({
          type: "start",
          recId: recId,
          data: {rate: this.audioCtx.sampleRate, format: this.format},
        });
        if (this.useWorklet) {
          this.encNode.port.onmessage = (e) => this.onAudioChunk(e.data);
        } else {
          this.encNode.onaudioprocess = (e) => {
            this.onAudioChunk(e.inputBuffer.getChannelData(0));
          };
        }
        this.encNode.connect(this.audioCtx.destination);
        return new Promise((resolve, reject) => {
          this.startResolve = resolve;
          this.startReject = reject;
        });
      });
  }

  onAudioChunk(samples) {
    if (!this.recording) return;
    this.worker.postMessage({
      type: "data",
      recId: this.recId,
      seq: this.seq++,
      data: samples,
    });
  }

  stopRecording() {
    if (!this.worker) throw new Error("missing worker initialization");
    if (!this.recording) return Promise.reject(new Error("not recording"));
    this.recording = false;
    this.encNode.disconnect();
    if (this.useWorklet) {
      this.encNode.port.onmessage = null;
    } else {
      this.encNode.onaudioprocess = null;
    }
    if (this.stream) this.stopTracks();
    if (this.audioCtx && this.audioCtx.state !== "closed") this.audioCtx.close();
    const recId = this.recId;
    this.worker.postMessage({type: "stop", recId: recId});
    return new Promise((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;
    });
  }

  stopTracks() {
    // Might be missed in Safari and old FF/Chrome per MDN.
    if (this.stream.getTracks) {
      // Hide browser's recording indicator.
      this.stream.getTracks().forEach((track) => track.stop());
    }
  }
}

export class Form {
  constructor(opts = {}, resolve, reject) {
    this.recorder = new Recorder(opts, this.onStop.bind(this));
    this.resolve = resolve;
    this.reject = reject;
    this.backdrop = null;
    this.popup = null;
    this.recordBtn = null;
    this.stopBtn = null;
    this.timer = null;
    this.audio = null;
    this.saveBtn = null;
    this.tid = 0;
    this.start = 0;
    Object.seal(this);

    this.recorder.initAudio()
      .then(() => this.drawInit())
      .then(() => this.recorder.initWorker())
      .then(() => this.drawAll())
      .catch((err) => this.drawError(err));
  }

  drawInit() {
    if (this.backdrop) return;
    const backdrop = this.backdrop = document.createElement("div");
    backdrop.className = "vmsg-backdrop";
    backdrop.addEventListener("click", () => this.close(null));

    const popup = this.popup = document.createElement("div");
    popup.className = "vmsg-popup";
    popup.addEventListener("click", (e) => e.stopPropagation());

    const progress = document.createElement("div");
    progress.className = "vmsg-progress";
    for (let i = 0; i < 3; i++) {
      const progressDot = document.createElement("div");
      progressDot.className = "vmsg-progress-dot";
      progress.appendChild(progressDot);
    }
    popup.appendChild(progress);

    backdrop.appendChild(popup);
    document.body.appendChild(backdrop);
  }

  drawTime(msecs) {
    const secs = Math.round(msecs / 1000);
    this.timer.textContent = pad2(secs / 60) + ":" + pad2(secs % 60);
  }

  drawAll() {
    this.drawInit();
    this.clearAll();

    const recordRow = document.createElement("div");
    recordRow.className = "vmsg-record-row";
    this.popup.appendChild(recordRow);

    const recordBtn = this.recordBtn = document.createElement("button");
    recordBtn.className = "vmsg-button vmsg-record-button";
    recordBtn.textContent = "●";
    recordBtn.title = "Start Recording";
    recordBtn.addEventListener("click", () => this.startRecording());
    recordRow.appendChild(recordBtn);

    const stopBtn = this.stopBtn = document.createElement("button");
    stopBtn.className = "vmsg-button vmsg-stop-button";
    stopBtn.style.display = "none";
    stopBtn.textContent = "■";
    stopBtn.title = "Stop Recording";
    stopBtn.addEventListener("click", () => this.stopRecording());
    recordRow.appendChild(stopBtn);

    const audio = this.audio = new Audio();
    audio.autoplay = true;

    const timer = this.timer = document.createElement("span");
    timer.className = "vmsg-timer";
    timer.title = "Preview Recording";
    timer.addEventListener("click", () => {
      if (audio.paused) {
        if (this.recorder.blobURL) {
          audio.src = this.recorder.blobURL;
        }
      } else {
        audio.pause();
      }
    });
    this.drawTime(0);
    recordRow.appendChild(timer);

    const saveBtn = this.saveBtn = document.createElement("button");
    saveBtn.className = "vmsg-button vmsg-save-button";
    saveBtn.textContent = "✓";
    saveBtn.title = "Save Recording";
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", () => this.close(this.recorder.blob));
    recordRow.appendChild(saveBtn);

    const gainWrapper = document.createElement("div");
    gainWrapper.className = "vmsg-slider-wrapper vmsg-gain-slider-wrapper";
    const gainSlider = document.createElement("input");
    gainSlider.className = "vmsg-slider vmsg-gain-slider";
    gainSlider.setAttribute("type", "range");
    gainSlider.min = 0;
    gainSlider.max = 2;
    gainSlider.step = 0.2;
    gainSlider.value = 1;
    gainSlider.onchange = () => {
      const gain = +gainSlider.value;
      this.recorder.gainNode.gain.value = gain;
    };
    gainWrapper.appendChild(gainSlider);
    this.popup.appendChild(gainWrapper);

    const pitchWrapper = document.createElement("div");
    pitchWrapper.className = "vmsg-slider-wrapper vmsg-pitch-slider-wrapper";
    const pitchSlider = document.createElement("input");
    pitchSlider.className = "vmsg-slider vmsg-pitch-slider";
    pitchSlider.setAttribute("type", "range");
    pitchSlider.min = -1;
    pitchSlider.max = 1;
    pitchSlider.step = 0.2;
    pitchSlider.value = this.recorder.pitch;
    pitchSlider.onchange = () => {
      const pitch = +pitchSlider.value;
      this.recorder.pitchFX.setPitchOffset(pitch);
      this.recorder.gainNode.disconnect();
      this.recorder.gainNode.connect(
        pitch === 0 ? this.recorder.encNode : this.recorder.pitchFX.input
      );
    };
    pitchWrapper.appendChild(pitchSlider);
    this.popup.appendChild(pitchWrapper);
    recordBtn.focus();
  }

  drawError(err) {
    console.error(err);
    this.drawInit();
    this.clearAll();
    const error = document.createElement("div");
    error.className = "vmsg-error";
    error.textContent = err.toString();
    this.popup.appendChild(error);
  }

  clearAll() {
    if (!this.popup) return;
    this.popup.innerHTML = "";
  }

  close(blob) {
    if (this.audio) this.audio.pause();
    if (this.tid) clearTimeout(this.tid);
    this.recorder.close();
    this.backdrop.remove();
    if (blob) {
      this.resolve(blob);
    } else {
      this.reject(new Error("No record made"));
    }
  }

  onStop() {
    this.recordBtn.style.display = "";
    this.stopBtn.style.display = "none";
    this.stopBtn.disabled = false;
    this.saveBtn.disabled = false;
  }

  startRecording() {
    this.audio.pause();
    this.start = Date.now();
    this.updateTime();
    this.recordBtn.style.display = "none";
    this.stopBtn.style.display = "";
    this.saveBtn.disabled = true;
    this.stopBtn.focus();
    this.recorder.startRecording().catch((err) => this.drawError(err));
  }

  stopRecording() {
    clearTimeout(this.tid);
    this.tid = 0;
    this.stopBtn.disabled = true;
    this.recordBtn.focus();
    this.recorder.stopRecording();
  }

  updateTime() {
    // NOTE(Kagami): We can do this in `onaudioprocess` but that would
    // run too often and create unnecessary DOM updates.
    this.drawTime(Date.now() - this.start);
    this.tid = setTimeout(() => this.updateTime(), 300);
  }
}

let shown = false;

/**
 * Record a new voice message.
 *
 * @param {Object=} opts - Options
 * @param {string=} opts.wasmURL - URL of the module
 *                                 ("/static/js/vmsg.wasm" by default)
 * @param {string=} opts.shimURL - URL of the WebAssembly polyfill
 *                                 ("/static/js/wasm-polyfill.js" by default)
 * @param {number=} opts.pitch - Initial pitch shift ([-1, 1], 0 by default)
 * @return {Promise.<Blob>} A promise that contains recorded blob when fulfilled.
 */
export function record(opts) {
  return new Promise((resolve, reject) => {
    if (shown) throw new Error("Record form is already opened");
    shown = true;
    new Form(opts, resolve, reject);
  // Use `.finally` once it's available in Safari and Edge.
  }).then(result => {
    shown = false;
    return result;
  }, err => {
    shown = false;
    throw err;
  });
}

/**
 * All available public items.
 */
export default { Recorder, Form, record };

// Borrowed from and slightly modified:
// https://github.com/cwilso/Audio-Input-Effects/blob/master/js/jungle.js

// Copyright 2012, Google Inc.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//     * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

const delayTime = 0.100;
const fadeTime = 0.050;
const bufferTime = 0.100;

function createFadeBuffer(context, activeTime, fadeTime) {
  var length1 = activeTime * context.sampleRate;
  var length2 = (activeTime - 2*fadeTime) * context.sampleRate;
  var length = length1 + length2;
  var buffer = context.createBuffer(1, length, context.sampleRate);
  var p = buffer.getChannelData(0);

  var fadeLength = fadeTime * context.sampleRate;

  var fadeIndex1 = fadeLength;
  var fadeIndex2 = length1 - fadeLength;

  // 1st part of cycle
  for (var i = 0; i < length1; ++i) {
    var value;

    if (i < fadeIndex1) {
        value = Math.sqrt(i / fadeLength);
    } else if (i >= fadeIndex2) {
        value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
    } else {
        value = 1;
    }

    p[i] = value;
  }

  // 2nd part
  for (var i = length1; i < length; ++i) {
    p[i] = 0;
  }

  return buffer;
}

function createDelayTimeBuffer(context, activeTime, fadeTime, shiftUp) {
  var length1 = activeTime * context.sampleRate;
  var length2 = (activeTime - 2*fadeTime) * context.sampleRate;
  var length = length1 + length2;
  var buffer = context.createBuffer(1, length, context.sampleRate);
  var p = buffer.getChannelData(0);

  // 1st part of cycle
  for (var i = 0; i < length1; ++i) {
    if (shiftUp)
      // This line does shift-up transpose
      p[i] = (length1-i)/length;
    else
      // This line does shift-down transpose
      p[i] = i / length1;
  }

  // 2nd part
  for (var i = length1; i < length; ++i) {
    p[i] = 0;
  }

  return buffer;
}

function Jungle(context) {
  this.context = context;
  // Create nodes for the input and output of this "module".
  var input = (context.createGain || context.createGainNode).call(context);
  var output = (context.createGain || context.createGainNode).call(context);
  this.input = input;
  this.output = output;

  // Delay modulation.
  var mod1 = context.createBufferSource();
  var mod2 = context.createBufferSource();
  var mod3 = context.createBufferSource();
  var mod4 = context.createBufferSource();
  this.shiftDownBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, false);
  this.shiftUpBuffer = createDelayTimeBuffer(context, bufferTime, fadeTime, true);
  mod1.buffer = this.shiftDownBuffer;
  mod2.buffer = this.shiftDownBuffer;
  mod3.buffer = this.shiftUpBuffer;
  mod4.buffer = this.shiftUpBuffer;
  mod1.loop = true;
  mod2.loop = true;
  mod3.loop = true;
  mod4.loop = true;

  // for switching between oct-up and oct-down
  var mod1Gain = (context.createGain || context.createGainNode).call(context);
  var mod2Gain = (context.createGain || context.createGainNode).call(context);
  var mod3Gain = (context.createGain || context.createGainNode).call(context);
  mod3Gain.gain.value = 0;
  var mod4Gain = (context.createGain || context.createGainNode).call(context);
  mod4Gain.gain.value = 0;

  mod1.connect(mod1Gain);
  mod2.connect(mod2Gain);
  mod3.connect(mod3Gain);
  mod4.connect(mod4Gain);

  // Delay amount for changing pitch.
  var modGain1 = (context.createGain || context.createGainNode).call(context);
  var modGain2 = (context.createGain || context.createGainNode).call(context);

  var delay1 = (context.createDelay || context.createDelayNode).call(context);
  var delay2 = (context.createDelay || context.createDelayNode).call(context);
  mod1Gain.connect(modGain1);
  mod2Gain.connect(modGain2);
  mod3Gain.connect(modGain1);
  mod4Gain.connect(modGain2);
  modGain1.connect(delay1.delayTime);
  modGain2.connect(delay2.delayTime);

  // Crossfading.
  var fade1 = context.createBufferSource();
  var fade2 = context.createBufferSource();
  var fadeBuffer = createFadeBuffer(context, bufferTime, fadeTime);
  fade1.buffer = fadeBuffer
  fade2.buffer = fadeBuffer;
  fade1.loop = true;
  fade2.loop = true;

  var mix1 = (context.createGain || context.createGainNode).call(context);
  var mix2 = (context.createGain || context.createGainNode).call(context);
  mix1.gain.value = 0;
  mix2.gain.value = 0;

  fade1.connect(mix1.gain);
  fade2.connect(mix2.gain);

  // Connect processing graph.
  input.connect(delay1);
  input.connect(delay2);
  delay1.connect(mix1);
  delay2.connect(mix2);
  mix1.connect(output);
  mix2.connect(output);

  // Start
  var t = context.currentTime + 0.050;
  var t2 = t + bufferTime - fadeTime;
  mod1.start(t);
  mod2.start(t2);
  mod3.start(t);
  mod4.start(t2);
  fade1.start(t);
  fade2.start(t2);

  this.mod1 = mod1;
  this.mod2 = mod2;
  this.mod1Gain = mod1Gain;
  this.mod2Gain = mod2Gain;
  this.mod3Gain = mod3Gain;
  this.mod4Gain = mod4Gain;
  this.modGain1 = modGain1;
  this.modGain2 = modGain2;
  this.fade1 = fade1;
  this.fade2 = fade2;
  this.mix1 = mix1;
  this.mix2 = mix2;
  this.delay1 = delay1;
  this.delay2 = delay2;

  this.setDelay(delayTime);
}

Jungle.prototype.setDelay = function(delayTime) {
  this.modGain1.gain.setTargetAtTime(0.5*delayTime, 0, 0.010);
  this.modGain2.gain.setTargetAtTime(0.5*delayTime, 0, 0.010);
};

Jungle.prototype.setPitchOffset = function(mult) {
  if (mult>0) { // pitch up
    this.mod1Gain.gain.value = 0;
    this.mod2Gain.gain.value = 0;
    this.mod3Gain.gain.value = 1;
    this.mod4Gain.gain.value = 1;
  } else { // pitch down
    this.mod1Gain.gain.value = 1;
    this.mod2Gain.gain.value = 1;
    this.mod3Gain.gain.value = 0;
    this.mod4Gain.gain.value = 0;
  }
  this.setDelay(delayTime*Math.abs(mult));
};
