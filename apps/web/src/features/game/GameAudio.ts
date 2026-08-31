export type GameSound = "beat" | "launch" | "perfect" | "great" | "good" | "miss" | "impact" | "heavy-impact" | "rim" | "round" | "victory";

type AudioParamLike = Readonly<{
  setValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
}>;
type OscillatorLike = {
  type: OscillatorType | string;
  frequency: AudioParamLike;
  connect(node: unknown): unknown;
  start(time?: number): void;
  stop(time?: number): void;
};
type GainLike = Readonly<{ gain: AudioParamLike; connect(node: unknown): unknown }>;
type AudioContextLike = Readonly<{
  currentTime: number;
  destination: unknown;
  state: string;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  close(): Promise<void>;
}>;

const profiles: Record<GameSound, readonly [number, number, number, OscillatorType]> = {
  beat: [520, 340, .07, "sine"], launch: [180, 720, .18, "sawtooth"], perfect: [880, 1320, .24, "sine"], great: [660, 990, .19, "triangle"], good: [440, 620, .16, "triangle"], miss: [170, 90, .25, "square"], impact: [130, 70, .12, "square"], "heavy-impact": [95, 45, .25, "sawtooth"], rim: [310, 160, .09, "square"], round: [520, 780, .24, "triangle"], victory: [440, 1040, .42, "sine"],
};

const defaultFactory = (): AudioContextLike => {
  const Context = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("Web Audio is unavailable");
  return new Context();
};

export class GameAudio {
  #context: AudioContextLike | null = null;
  #enabled = true;
  #played = new Set<string>();

  constructor(private readonly factory: () => AudioContextLike = defaultFactory) {}

  setEnabled(enabled: boolean): void { this.#enabled = enabled; }

  async unlock(): Promise<void> {
    if (!this.#context) this.#context = this.factory();
    if (this.#context.state === "suspended") await this.#context.resume();
  }

  play(sound: GameSound, eventKey?: string): void {
    if (!this.#context || !this.#enabled || (eventKey && this.#played.has(eventKey))) return;
    if (eventKey) this.#played.add(eventKey);
    const [startFrequency, endFrequency, duration, type] = profiles[sound];
    const now = this.#context.currentTime;
    const oscillator = this.#context.createOscillator();
    const gain = this.#context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    gain.gain.setValueAtTime(sound === "heavy-impact" ? .12 : .07, now);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(gain); gain.connect(this.#context.destination);
    oscillator.start(now); oscillator.stop(now + duration);
  }

  async dispose(): Promise<void> {
    const context = this.#context; this.#context = null; this.#played.clear();
    if (context) await context.close();
  }
}
