declare module "vmsg" {
  interface RecordOptions {
    wasmURL?: string;
    shimURL?: string;
    pitch?: number;
    /** Output format: "mp3" (default) or "wav". */
    format?: "mp3" | "wav";
  }

  export class Recorder {
    constructor(opts: RecordOptions, onStop?: () => void);
    /** Blob of the last finished recording. */
    blob: Blob | null;
    /** Object URL of the last finished recording. */
    blobURL: string | null;
    /** Duration of the last recording in seconds (encoder delay/padding excluded). */
    duration: number;
    /** Number of recorded samples of the last recording. */
    samples: number;
    /** Number of audio chunks of the last recording. */
    chunks: number;
    stopRecording(): Promise<Blob>;
    initAudio(): Promise<void>;
    initWorker(): Promise<void>;
    init(): Promise<void>;
    /** May be called again after stopRecording() for another take. */
    startRecording(): Promise<void>;
    close(): void;
  }

  interface Exports {
    record: (opts?: RecordOptions) => Promise<Blob>;
  }
  const exports: Exports;
  export default exports;
}
