// The slice of the Emscripten module that `audio/signalsmith.ts` calls.
// Lengths are in frames; buffer pointers are byte offsets into `HEAP8.buffer`.
export type SignalsmithStretchModule = {
  HEAP8: Int8Array;
  exports?: { memory: WebAssembly.Memory };
  _presetDefault(channels: number, sampleRate: number): void;
  _setBuffers(channels: number, length: number): number;
  _inputLatency(): number;
  _outputLatency(): number;
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;
  _setFormantSemitones(semitones: number, compensate: boolean): void;
  _setFormantBase(baseFrequency: number): void;
  _reset(): void;
  _seek(inputLength: number, playbackRate: number): void;
  _process(inputLength: number, outputLength: number): void;
};

declare const createSignalsmithStretch: () => Promise<SignalsmithStretchModule>;
export default createSignalsmithStretch;
