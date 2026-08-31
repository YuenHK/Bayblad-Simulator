import { describe, expect, it, vi } from "vitest";
import { GameAudio } from "./GameAudio";

function audioHarness() {
  const oscillator = { type: "sine", frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  const context = { currentTime: 1, destination: {}, state: "suspended", resume: vi.fn().mockResolvedValue(undefined), createOscillator: vi.fn(() => oscillator), createGain: vi.fn(() => gain), close: vi.fn().mockResolvedValue(undefined) };
  return { context, oscillator };
}

describe("GameAudio", () => {
  it("未經可信任互動解鎖前不建立聲音", () => {
    const factory = vi.fn();
    const audio = new GameAudio(factory);
    audio.play("launch", "event-1");
    expect(factory).not.toHaveBeenCalled();
  });

  it("解鎖後播放，同一事件鍵只播放一次", async () => {
    const { context, oscillator } = audioHarness();
    const audio = new GameAudio(() => context);
    await audio.unlock();
    audio.play("perfect", "event-1");
    audio.play("perfect", "event-1");
    expect(oscillator.start).toHaveBeenCalledTimes(1);
  });

  it("靜音時不播放並可安全dispose", async () => {
    const { context, oscillator } = audioHarness();
    const audio = new GameAudio(() => context);
    await audio.unlock();
    audio.setEnabled(false);
    audio.play("impact", "event-2");
    expect(oscillator.start).not.toHaveBeenCalled();
    await audio.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
