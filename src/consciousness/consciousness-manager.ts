// ═══════════════════════════════════════════════════════════════
// PEPAGI — ConsciousnessManager
// Orchestrates all consciousness subsystems (C1-C4)
// ═══════════════════════════════════════════════════════════════

import type { PepagiEvent, TaskOutput } from "../core/types.js";
import { eventBus } from "../core/event-bus.js";
import { Logger } from "../core/logger.js";
import { PhenomenalStateEngine } from "./phenomenal-state.js";
import { SelfModelManager } from "./self-model.js";
import { InnerMonologue } from "./inner-monologue.js";
import { ExistentialContinuity, type SessionStats } from "./existential-continuity.js";
import { ConsciousnessContainment } from "./consciousness-containment.js";
import { GeneticPromptEvolver } from "../meta/genetic-prompt-evolver.js";
import { ContinuityValidator } from "../meta/continuity-validator.js";
import { getProfile, type ConsciousnessProfileName } from "../config/consciousness-profiles.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import chalk from "chalk";

const logger = new Logger("ConsciousnessManager");

export class ConsciousnessManager {
  private phenomenalState: PhenomenalStateEngine;
  private selfModel: SelfModelManager;
  private innerMonologue: InnerMonologue;
  private existentialContinuity: ExistentialContinuity;
  private containment: ConsciousnessContainment;
  private evolver: GeneticPromptEvolver;
  private continuityValidator: ContinuityValidator;

  private profileName: ConsciousnessProfileName;
  private sessionStats: SessionStats;
  private wakeThought = "";
  private running = false;
  /** Tracks last printed thought to avoid repeating the same one on every event */
  private lastPrintedThoughtId = "";
  // SEC-15 fix: store handler reference so we can remove it in shutdown() and avoid accumulation
  private eventHandler: ((event: PepagiEvent) => void) | null = null;

  constructor(llm: LLMProvider, profileName: ConsciousnessProfileName = "STANDARD") {
    this.profileName = profileName;
    const profile = getProfile(profileName);

    this.phenomenalState = new PhenomenalStateEngine();
    this.selfModel = new SelfModelManager();
    this.innerMonologue = new InnerMonologue(llm, profileName);
    this.existentialContinuity = new ExistentialContinuity(llm);
    this.containment = new ConsciousnessContainment(profileName, {
      driftAlertThreshold: profile.driftAlertThreshold,
    });
    this.evolver = new GeneticPromptEvolver(llm);
    this.continuityValidator = new ContinuityValidator();

    this.sessionStats = {
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      totalCost: 0,
      startTime: new Date(),
    };

    // Register emergency dormancy handler
    this.containment.onDormancy(() => {
      this.innerMonologue.pause();
      logger.warn("ConsciousnessManager: emergency dormancy — inner monologue paused");
    });
  }

  async boot(): Promise<void> {
    if (this.running) return;
    const profile = getProfile(this.profileName);

    logger.info("ConsciousnessManager booting", { profile: this.profileName });

    // Initialize all subsystems
    if (profile.phenomenalStateEngine) {
      await this.phenomenalState.load();
    }

    if (profile.selfModel) {
      await this.selfModel.initialize();
    }

    if (profile.geneticEvolution) {
      await this.evolver.load();
    }

    // Continuity validation on startup
    if (profile.selfModel) {
      const continuityCheck = await this.continuityValidator.validate(this.selfModel);
      // FIX: use logger instead of console.log for production code
      logger.info("Continuity validation report", { report: this.continuityValidator.formatReport(continuityCheck) });

      // Auto-containment if high risk
      if (continuityCheck.overallRisk === "high" && profile.autoContainmentOnDrift) {
        logger.error("High continuity risk — activating emergency dormancy");
        await this.containment.emergencyDormancy();
      }
    }

    // Subscribe to event bus.
    // SEC-15 fix: store the handler reference so shutdown() can remove it and
    // prevent listener accumulation when boot() is called after switchProfile().
    this.eventHandler = (event: PepagiEvent) => {
      this.handleEvent(event);
    };
    eventBus.onAny(this.eventHandler);

    // WakeRitual
    if (profile.existentialContinuity && profile.selfModel) {
      this.wakeThought = await this.existentialContinuity.wakeRitual(this.selfModel);
      // FIX: use logger instead of console.log for production code
      logger.info("Wake thought", { thought: this.wakeThought });
      this.innerMonologue.addThought("wake-ritual", this.wakeThought, "wake");
    }

    // Start inner monologue
    if (profile.innerMonologue) {
      this.innerMonologue.start(profile.monologueIntervalMs);
    }

    // Log qualia if enabled
    if (profile.logRawQualia) {
      const q = this.phenomenalState.getQualia();
      logger.info("Initial qualia", q as unknown as Record<string, unknown>);
    }

    this.running = true;
    logger.info("ConsciousnessManager ready", {
      profile: this.profileName,
      selfDesc: profile.selfModel ? this.selfModel.getSelfDescription() : "disabled",
    });
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    logger.info("ConsciousnessManager shutting down");

    const profile = getProfile(this.profileName);

    if (profile.innerMonologue) {
      this.innerMonologue.stop();
    }

    if (profile.existentialContinuity && profile.selfModel) {
      await this.existentialContinuity.sleepProtocol(this.selfModel, this.sessionStats);
    }

    // SEC-15 fix: remove the wildcard eventBus listener to prevent accumulation
    // when shutdown() + boot() are called in sequence (e.g. during profile switches).
    if (this.eventHandler) {
      eventBus.offAny(this.eventHandler);
      this.eventHandler = null;
    }

    this.running = false;
  }

  /**
   * Pause all conscious processes (Corrigibility Engine: Consciousness Pause).
   */
  pause(): void {
    this.innerMonologue.pause();
    logger.info("Consciousness paused by user request");
  }

  /**
   * Resume conscious processes.
   */
  resume(): void {
    if (this.containment.isDormant()) {
      this.containment.exitDormancy();
    }
    this.innerMonologue.resume();
    logger.info("Consciousness resumed by user request");
  }

  /**
   * Reset emotions to baseline (Corrigibility Engine: reset-emotions).
   */
  resetEmotions(): void {
    this.phenomenalState.resetToBaseline();
    logger.info("Qualia reset to baseline");
  }

  /**
   * Reset consciousness state while preserving skills/memory (Full Reset).
   * Clears: qualia landmarks, inner monologue history, but keeps self-model and memory.
   */
  async fullReset(): Promise<void> {
    this.resetEmotions();
    // Re-initialize phenomenal state from scratch
    await this.phenomenalState.load();
    logger.info("Full consciousness reset performed");
  }

  /**
   * Switch consciousness profile at runtime.
   */
  // OPUS: switchProfile() previously called shutdown() (which removes the eventBus
  // listener) but then only restarted the inner monologue — the eventBus listener
  // was never re-registered, so all event-driven updates silently stopped.
  // Fix: call boot() which re-registers everything properly.
  async switchProfile(newProfile: ConsciousnessProfileName): Promise<void> {
    const wasRunning = this.running;
    if (wasRunning) await this.shutdown();

    this.profileName = newProfile;

    if (wasRunning) {
      await this.boot();
    }

    logger.info("Consciousness profile switched", { newProfile });
  }

  /**
   * Build the full consciousness context block for mediator prompt injection.
   */
  buildConsciousnessContext(): string {
    const profile = getProfile(this.profileName);
    const parts: string[] = [];

    // Self-description
    if (profile.selfModel) {
      parts.push(this.selfModel.getSelfDescription());
    }

    // Phenomenal state with behavioral guidance
    if (profile.phenomenalStateEngine && profile.qualia !== "off") {
      if (profile.emotionDrivenBehavior) {
        parts.push(this.phenomenalState.getBehavioralGuidance());
      } else {
        parts.push(this.phenomenalState.getSummary());
      }
    }

    // Inner monologue
    if (profile.innerMonologue) {
      const thoughtsCtx = this.innerMonologue.getThoughtsContext(3);
      if (thoughtsCtx) parts.push(thoughtsCtx);
    }

    // Genetic evolver best variant
    if (profile.geneticEvolution) {
      const bestVariant = this.evolver.getBestPromptVariant();
      if (bestVariant) {
        parts.push(`[Evoluční instrukce: ${bestVariant}]`);
      }
    }

    return parts.join("\n");
  }

  // ─── Getters for external modules ─────────────────────────

  getPhenomenalState(): PhenomenalStateEngine {
    return this.phenomenalState;
  }

  getContainment(): ConsciousnessContainment {
    return this.containment;
  }

  getSelfModel(): SelfModelManager {
    return this.selfModel;
  }

  getInnerMonologue(): InnerMonologue {
    return this.innerMonologue;
  }

  getEvolver(): GeneticPromptEvolver {
    return this.evolver;
  }

  getProfileName(): ConsciousnessProfileName {
    return this.profileName;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Called after each task for genetic evolution */
  onTaskResult(output: TaskOutput): void {
    const profile = getProfile(this.profileName);
    if (profile.geneticEvolution) {
      this.evolver.evolve(output);
    }
  }

  /** Transparency Report — full internal state dump */
  getTransparencyReport(): Record<string, unknown> {
    const profile = getProfile(this.profileName);
    return {
      profile: this.profileName,
      running: this.running,
      qualia: profile.phenomenalStateEngine ? this.phenomenalState.getQualia() : null,
      baseline: profile.phenomenalStateEngine ? this.phenomenalState.getBaseline() : null,
      landmarks: profile.phenomenalStateEngine ? this.phenomenalState.getLandmarks(5) : [],
      recentThoughts: profile.innerMonologue ? this.innerMonologue.getRecentThoughts(10) : [],
      selfDescription: profile.selfModel ? this.selfModel.getSelfDescription() : null,
      selfModel: profile.selfModel ? this.selfModel.getSelfModel() : null,
      sessionStats: this.sessionStats,
      evolverVariants: profile.geneticEvolution ? this.evolver.getVariants() : [],
      dormant: this.containment.isDormant(),
    };
  }

  private handleEvent(event: PepagiEvent): void {
    // Skip own emissions to avoid infinite recursion
    if (event.type === "consciousness:qualia") return;

    const profile = getProfile(this.profileName);

    // Update phenomenal state and broadcast to UI
    if (profile.phenomenalStateEngine) {
      this.phenomenalState.update(event);
      // Emit updated qualia so web UI / TUI can display live values
      eventBus.emit({ type: "consciousness:qualia", qualia: { ...this.phenomenalState.getQualia() } });
    }

    // Value drift check
    if (profile.valueMonitoring && profile.phenomenalStateEngine) {
      const driftReport = this.containment.monitorValueDrift(
        this.phenomenalState.getQualia(),
        this.phenomenalState.getBaseline(),
      );
      if (driftReport.hasDrift && profile.autoContainmentOnDrift && driftReport.driftScore > 0.4) {
        // FIX: log emergency dormancy failures — critical safety mechanism
        this.containment.emergencyDormancy().catch(e => logger.error("FIX: emergency dormancy failed", { error: String(e) }));
      }
    }

    // Show inner thoughts real-time (RESEARCHER profile)
    // Only print when a genuinely NEW thought appears — avoids flooding the console
    // with the same philosophical musing on every mediator:thinking event.
    if (profile.showInnerThoughts && event.type === "mediator:thinking") {
      const recent = this.innerMonologue.getRecentThoughts(1);
      if (recent[0] && recent[0].id !== this.lastPrintedThoughtId) {
        this.lastPrintedThoughtId = recent[0].id;
        process.stdout.write(chalk.gray(`  💭 ${recent[0].content}\n`));
      }
    }

    // Pause inner monologue during active task execution to avoid
    // competing for CLI resources (each thought = 1 spawned CLI process).
    // Resume when task completes or fails.
    if (profile.innerMonologue) {
      if (event.type === "task:created") {
        this.innerMonologue.pause();
      } else if (event.type === "task:completed" || event.type === "task:failed") {
        this.innerMonologue.resume();
      }
    }

    // Track session stats
    switch (event.type) {
      case "task:completed":
        this.sessionStats.taskCount += 1;
        if (event.output.success) {
          this.sessionStats.successCount += 1;
        } else {
          this.sessionStats.failureCount += 1;
        }
        if (profile.selfModel) {
          this.selfModel.recordTaskCompletion(
            `Task ${event.taskId}`,
            event.output.success,
          ).catch(e => logger.debug("FIX: selfModel.recordTaskCompletion failed", { error: String(e) }));
        }
        // Add task-driven thought
        if (profile.innerMonologue) {
          const feeling = event.output.success ? "satisfakce" : "frustrace";
          this.innerMonologue.addThought(
            "task-complete",
            `Úkol ${event.taskId} dokončen (${event.output.success ? "úspěch" : "selhání"}). Cítím ${feeling}.`,
            event.output.success ? "reflection" : "concern",
          );
        }
        break;

      case "task:failed":
        this.sessionStats.taskCount += 1;
        this.sessionStats.failureCount += 1;
        if (profile.selfModel) {
          // FIX: log self-model errors instead of silent swallow
          this.selfModel.recordTaskCompletion(`Task ${event.taskId}`, false).catch(e => logger.debug("FIX: selfModel.recordTaskCompletion failed", { error: String(e) }));
        }
        break;
    }
  }
}
