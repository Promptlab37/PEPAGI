import EventEmitter from "eventemitter3";
import type { PepagiEvent } from "./types.js";

// OPUS: Sonnet's original on() wrapped handlers in anonymous lambdas for type
// narrowing, but off() tried to remove the ORIGINAL handler — which the emitter
// never stored. Result: every off() call was silently a no-op, leaking listeners.
// Fix: pass handler references directly to EventEmitter3 (type safety is
// compile-time only; the cast adds no runtime behavior).

class PepagiEventBus {
  private emitter = new EventEmitter();

  emit(event: PepagiEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit("*", event);
  }

  on<T extends PepagiEvent["type"]>(type: T, handler: (event: Extract<PepagiEvent, { type: T }>) => void): void {
    // OPUS: register the handler directly — NOT wrapped — so off() can find it
    this.emitter.on(type, handler as (...args: unknown[]) => void);
  }

  onAny(handler: (event: PepagiEvent) => void): void {
    this.emitter.on("*", handler as (...args: unknown[]) => void);
  }

  off<T extends PepagiEvent["type"]>(type: T, handler: (event: Extract<PepagiEvent, { type: T }>) => void): void;
  off(type: string, handler: (event: PepagiEvent) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload impl must accept all overload param types
  off(type: string, handler: (...args: any[]) => void): void {
    this.emitter.off(type, handler);
  }

  offAny(handler: (event: PepagiEvent) => void): void {
    this.emitter.off("*", handler as (...args: unknown[]) => void);
  }
}

export const eventBus = new PepagiEventBus();
