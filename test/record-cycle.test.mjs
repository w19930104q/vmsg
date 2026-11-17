// Record -> stop -> record cycle tests for the vmsg Recorder.
//
// The browser environment is mocked: AudioWorkletNode input is pumped
// by hand, and the encoder worker runs in-process (via `new Function`)
// against the real vmsg.wasm build. Assertions cover:
//   * per-take durations (LAME delay/padding excluded),
//   * chunk sequence numbers and session ids of the worker protocol,
//   * WAV/MP3 output header fields and their mutual consistency.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM_PATH = path.join(ROOT, "vmsg.wasm");
const RATE = 44100;
const CHUNK = 128; // AudioWorklet quantum

const vmsgSrc = fs.readFileSync(path.join(ROOT, "vmsg.js"), "utf8");
const vmsg = await import(
  "data:text/javascript;base64," + Buffer.from(vmsgSrc).toString("base64"));
const {Recorder, inlineWorker} = vmsg;

// ---------------------------------------------------------------------------
// Browser mocks
// ---------------------------------------------------------------------------

class MockAudioParam {
  constructor(value = 0) { this.value = value; }
  setTargetAtTime() {}
}

class MockAudioNode {
  connect() {}
  disconnect() {}
  start() {}
}

class MockAudioContext {
  constructor() {
    this.sampleRate = RATE;
    this.state = "running";
    this.currentTime = 0;
    this.destination = new MockAudioNode();
    this.audioWorklet = {addModule: () => Promise.resolve()};
  }
  createMediaStreamSource() { return new MockAudioNode(); }
  createGain() {
    const node = new MockAudioNode();
    node.gain = new MockAudioParam(1);
    return node;
  }
  createBuffer(channels, length) {
    const data = new Float32Array(length);
    return {length, getChannelData: () => data};
  }
  createBufferSource() { return new MockAudioNode(); }
  createDelay() {
    const node = new MockAudioNode();
    node.delayTime = new MockAudioParam(0);
    return node;
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

// Simulated AudioWorklet input: `pump` plays the role of the worklet
// processor posting a captured chunk to the main thread.
class MockAudioWorkletNode extends MockAudioNode {
  constructor() {
    super();
    this.port = {onmessage: null};
  }
  pump(samples) {
    if (this.port.onmessage) this.port.onmessage({data: samples});
  }
}

class MockMediaStream {
  constructor() { this._tracks = [{stop() {}}]; }
  getTracks() { return this._tracks; }
}

// Runs inlineWorker in-process with the real WASM module. Message
// delivery is asynchronous (setImmediate) to mimic worker semantics.
function createMockWorkerClass(log, instances) {
  return class MockWorker {
    constructor() {
      instances.push(this);
      this.onmessage = null;
      const sandbox = {
        self: {},
        // No instantiateStreaming -> the worker takes the XHR fallback
        // path, which the mock below serves from disk.
        WebAssembly: {
          Memory: WebAssembly.Memory,
          Module: WebAssembly.Module,
          Instance: WebAssembly.Instance,
          instantiate: WebAssembly.instantiate,
          compile: WebAssembly.compile,
          validate: WebAssembly.validate,
        },
        Blob,
        XMLHttpRequest: class {
          open(method, url) { this._url = url; }
          send() {
            this.response = fs.readFileSync(fileURLToPath(this._url));
            this.onload();
          }
        },
        importScripts() { throw new Error("wasm shim unavailable in tests"); },
        fetch: undefined,
        postMessage: (data) => {
          log.push({dir: "from-worker", msg: data});
          setImmediate(() => this.onmessage && this.onmessage({data}));
        },
        console,
      };
      sandbox.self.WebAssembly = sandbox.WebAssembly;
      const names = Object.keys(sandbox);
      // `onmessage` is declared as a parameter so the assignment inside
      // inlineWorker stays local to this worker instance.
      const run = new Function(...names, "onmessage",
        `(${inlineWorker.toString()})(); return () => onmessage;`);
      this._getOnmessage = run(...names.map((n) => sandbox[n]), null);
    }
    postMessage(msg) {
      log.push({dir: "to-worker", msg});
      const onmessage = this._getOnmessage();
      setImmediate(() => onmessage({data: msg}));
    }
    terminate() {}
  };
}

Object.defineProperty(globalThis, "navigator", {
  value: {mediaDevices: {getUserMedia: () => Promise.resolve(new MockMediaStream())}},
  configurable: true,
  writable: true,
});
globalThis.window = globalThis;
globalThis.location = new URL("https://vmsg.test/");
globalThis.AudioContext = MockAudioContext;
globalThis.AudioWorkletNode = MockAudioWorkletNode;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHarness() {
  const log = [];
  const instances = [];
  globalThis.Worker = createMockWorkerClass(log, instances);
  return {log, instances};
}

function sineChunk(seq) {
  const chunk = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    chunk[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (seq * CHUNK + i)) / RATE);
  }
  return chunk;
}

function pump(recorder, nChunks, firstSeq = 0) {
  for (let i = 0; i < nChunks; i++) {
    recorder.encNode.pump(sineChunk(firstSeq + i));
  }
  return nChunks * CHUNK;
}

function parseWavHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (off, len) =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  return {
    riff: str(0, 4),
    chunkSize: view.getUint32(4, true),
    wave: str(8, 4),
    fmt: str(12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: str(36, 4),
    dataSize: view.getUint32(40, true),
  };
}

// Independent re-implementation of the Xing/LAME tag parsing used to
// cross-check the metadata reported by the worker.
function parseMp3(bytes) {
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    offset = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 |
                   (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  }
  const version = (bytes[offset + 1] >> 3) & 3;
  const mono = (bytes[offset + 3] >> 6 & 3) === 3;
  const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const xing = offset + 4 + sideInfo;
  const magic = String.fromCharCode(
    bytes[xing], bytes[xing + 1], bytes[xing + 2], bytes[xing + 3]);
  const u32 = (p) =>
    (bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3]) >>> 0;
  const flags = u32(xing + 4);
  let p = xing + 8;
  let frames = null;
  if (flags & 1) { frames = u32(p); p += 4; }
  // Locate the LAME extension tag by signature (its offset after the
  // Xing fields varies between LAME versions).
  let lame = -1;
  for (let q = xing + 8; q < xing + 8 + 128; q++) {
    if (bytes[q] === 0x4c && bytes[q + 1] === 0x41 &&
        bytes[q + 2] === 0x4d && bytes[q + 3] === 0x45) {
      lame = q;
      break;
    }
  }
  assert.ok(lame > 0, "LAME tag present");
  const d0 = bytes[lame + 0x15], d1 = bytes[lame + 0x16], d2 = bytes[lame + 0x17];
  return {
    sync: bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0,
    magic,
    frames,
    encDelay: (d0 << 4) | (d1 >> 4),
    encPadding: ((d1 & 0xf) << 8) | d2,
  };
}

function protocolAssertions(log, samplesPerTake, expectedSeqs) {
  const toWorker = log.filter((e) => e.dir === "to-worker").map((e) => e.msg);
  const fromWorker = log.filter((e) => e.dir === "from-worker").map((e) => e.msg);

  // Two takes -> two sessions with increasing ids.
  assert.deepEqual(
    toWorker.filter((m) => m.type === "start").map((m) => m.recId), [1, 2]);
  assert.deepEqual(
    fromWorker.filter((m) => m.type === "started").map((m) => m.recId), [1, 2]);
  assert.deepEqual(
    toWorker.filter((m) => m.type === "stop").map((m) => m.recId), [1, 2]);
  assert.deepEqual(
    fromWorker.filter((m) => m.type === "stop").map((m) => m.recId), [1, 2]);

  // Chunk sequence numbers restart at 0 for every take and are dense.
  for (const recId of [1, 2]) {
    const seqs = toWorker
      .filter((m) => m.type === "data" && m.recId === recId)
      .map((m) => m.seq);
    assert.deepEqual(seqs,
      expectedSeqs[recId] || [...Array(samplesPerTake / CHUNK).keys()]);
  }

  // Worker-side sample accounting matches what was pumped.
  const stops = fromWorker.filter((m) => m.type === "stop");
  assert.deepEqual(stops.map((m) => m.data.samples),
    [samplesPerTake, samplesPerTake]);
  assert.deepEqual(stops.map((m) => m.data.chunks),
    [samplesPerTake / CHUNK, samplesPerTake / CHUNK]);
  return stops;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("mp3: record-stop-record creates fresh encoder sessions", async () => {
  const {log, instances} = makeHarness();
  const recorder = new Recorder({
    wasmURL: pathToFileURL(WASM_PATH).href,
    format: "mp3",
  });
  await recorder.init();

  // Take 1.
  await recorder.startRecording();
  const samples1 = pump(recorder, 25);
  const blob1 = await recorder.stopRecording();
  assert.equal(recorder.samples, samples1);
  assert.equal(recorder.chunks, 25);
  assert.equal(recorder.duration, samples1 / RATE);

  // Take 2 on the same recorder: audio graph and encoder are recreated.
  await recorder.startRecording();
  const samples2 = pump(recorder, 25);
  // A stale chunk from take 1 must be dropped by the worker.
  instances[0].postMessage({type: "data", recId: 1, seq: 99, data: sineChunk(0)});
  const blob2 = await recorder.stopRecording();
  assert.equal(recorder.samples, samples2);
  assert.equal(recorder.duration, samples2 / RATE);

  // The trailing 99 in take 1's sequence is the injected stale chunk;
  // the worker dropped it (samples above still match the pumped count).
  const stops = protocolAssertions(log, samples1,
    {1: [...Array(samples1 / CHUNK).keys(), 99]});

  // Blob API is preserved.
  assert.ok(blob1 instanceof Blob);
  assert.ok(blob2 instanceof Blob);
  assert.equal(blob1.type, "audio/mpeg");
  assert.equal(blob2.type, "audio/mpeg");
  assert.equal(recorder.blob, blob2);
  assert.ok(recorder.blobURL);

  // MP3 header fields of both takes.
  for (const [i, blob] of [blob1, blob2].entries()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mp3 = parseMp3(bytes);
    assert.ok(mp3.sync, "MPEG frame sync");
    assert.ok(mp3.magic === "Xing" || mp3.magic === "Info", "Xing/Info tag");
    assert.ok(mp3.frames > 0);
    assert.ok(mp3.encDelay > 0, "LAME encoder delay present in tag");
    // The LAME delay/padding is part of the frame grid but must not be
    // counted into the recording: nominal samples == pumped samples.
    const nominal = mp3.frames * 1152 - mp3.encDelay - mp3.encPadding;
    assert.equal(nominal, samples1);
    // The worker reports the same boundary metadata.
    assert.equal(stops[i].data.frames, mp3.frames);
    assert.equal(stops[i].data.encDelay, mp3.encDelay);
    assert.equal(stops[i].data.encPadding, mp3.encPadding);
    assert.equal(stops[i].data.duration, samples1 / RATE);
  }

  recorder.close();
});

test("wav: record-stop-record emits exact PCM boundaries", async () => {
  const {log} = makeHarness();
  const recorder = new Recorder({
    wasmURL: pathToFileURL(WASM_PATH).href,
    format: "wav",
  });
  await recorder.init();

  await recorder.startRecording();
  const samples1 = pump(recorder, 25);
  const blob1 = await recorder.stopRecording();

  await recorder.startRecording();
  const samples2 = pump(recorder, 10);
  const blob2 = await recorder.stopRecording();

  const stops = log.filter((e) => e.dir === "from-worker")
    .map((e) => e.msg).filter((m) => m.type === "stop");
  assert.deepEqual(stops.map((m) => m.data.samples), [samples1, samples2]);
  assert.deepEqual(stops.map((m) => m.data.duration),
    [samples1 / RATE, samples2 / RATE]);

  for (const [blob, samples] of [[blob1, samples1], [blob2, samples2]]) {
    assert.equal(blob.type, "audio/wav");
    assert.equal(blob.size, 44 + samples * 2);
    const hdr = parseWavHeader(new Uint8Array(await blob.arrayBuffer()));
    assert.equal(hdr.riff, "RIFF");
    assert.equal(hdr.wave, "WAVE");
    assert.equal(hdr.fmt, "fmt ");
    assert.equal(hdr.chunkSize, 36 + samples * 2);
    assert.equal(hdr.fmtSize, 16);
    assert.equal(hdr.audioFormat, 1);
    assert.equal(hdr.channels, 1);
    assert.equal(hdr.sampleRate, RATE);
    assert.equal(hdr.byteRate, RATE * 2);
    assert.equal(hdr.blockAlign, 2);
    assert.equal(hdr.bitsPerSample, 16);
    assert.equal(hdr.data, "data");
    assert.equal(hdr.dataSize, samples * 2);
  }

  recorder.close();
});

test("wav and mp3 takes agree on the recording boundary", async () => {
  const durations = [];
  for (const format of ["mp3", "wav"]) {
    makeHarness();
    const recorder = new Recorder({
      wasmURL: pathToFileURL(WASM_PATH).href,
      format,
    });
    await recorder.init();
    await recorder.startRecording();
    const samples = pump(recorder, 25);
    await recorder.stopRecording();
    // Duration is derived from the recorded sample count, not from the
    // MP3 frame grid (which includes LAME delay/padding).
    assert.equal(recorder.duration, samples / RATE);
    durations.push(recorder.duration);
    recorder.close();
  }
  assert.equal(durations[0], durations[1]);
});

test("out-of-order chunk sequence is rejected", async () => {
  const {log, instances} = makeHarness();
  const recorder = new Recorder({
    wasmURL: pathToFileURL(WASM_PATH).href,
    format: "mp3",
  });
  await recorder.init();
  await recorder.startRecording();
  pump(recorder, 2);
  // Skip a sequence number -> protocol error.
  instances[0].postMessage({type: "data", recId: 1, seq: 5, data: sineChunk(5)});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const errors = log.filter((e) => e.dir === "from-worker")
    .map((e) => e.msg).filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].data, /out-of-order chunk 5 \(expected 2\)/);
  // The recorder was torn down after the protocol error.
  assert.throws(() => recorder.stopRecording(), /missing worker/);
});
