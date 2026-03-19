// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F7: Evolution Engine
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { trunc, fmtCost, renderBar } from "../theme.js";

const DATA = join(homedir(), ".pepagi");
const CHEAP_PROVIDERS = ["ollama", "lmstudio"];

interface ProcedureRecord {
  id?: string;
  name?: string;
  successRate?: number;
  timesUsed?: number;
  averageCost?: number;
  triggerPattern?: string;
}

interface ABExperiment {
  id: string; taskType?: string; hypothesis?: string;
  variantA?: string; variantB?: string;
  winnerVariant?: string; winnerImprovement?: number;
  status?: string; createdAt?: string;
}

interface ReflectionEntry { summary: string; score?: number; ts?: number; }

interface EvoStats {
  procedures: number; skills: number; reflections: number;
  experiments: number; recentSkills: string[];
  sortedReflections: ReflectionEntry[];
  recentExperiments: ABExperiment[];
  procedureRecords: ProcedureRecord[];
}

async function loadEvoStats(): Promise<EvoStats> {
  const countLines = async (file: string): Promise<number> => {
    if (!existsSync(file)) return 0;
    try { return (await readFile(file, "utf8")).split("\n").filter(l => l.trim()).length; }
    catch { return 0; }
  };
  const [procedures, reflections, experiments] = await Promise.all([
    countLines(join(DATA, "memory", "procedures.jsonl")),
    countLines(join(DATA, "memory", "reflections.jsonl")),
    countLines(join(DATA, "memory", "experiments.jsonl")),
  ]);
  let sortedReflections: ReflectionEntry[] = [];
  try {
    const raw = await readFile(join(DATA, "memory", "reflections.jsonl"), "utf8");
    sortedReflections = raw.split("\n").filter(l => l.trim()).map(l => {
      try {
        const p = JSON.parse(l) as Record<string, unknown>;
        return {
          summary: String(p["summary"] ?? p["reflection"] ?? l).slice(0, 100),
          score:   typeof p["score"] === "number" ? p["score"] as number : undefined,
          ts:      typeof p["createdAt"] === "number" ? p["createdAt"] as number : undefined,
        } satisfies ReflectionEntry;
      } catch { return { summary: l.slice(0, 100) }; }
    });
    // Sort by score desc (undefined last), then by ts desc
    sortedReflections.sort((a, b) => {
      const sa = a.score ?? -1, sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      return (b.ts ?? 0) - (a.ts ?? 0);
    });
  } catch { /* ignore */ }
  let skills = 0;
  let recentSkills: string[] = [];
  try {
    const files = await readdir(join(DATA, "skills")).catch(() => []);
    const sf = (files as string[]).filter(f => f.endsWith(".json") || f.endsWith(".mjs"));
    skills = sf.length;
    recentSkills = sf.slice(-5);
  } catch { /* ignore */ }
  // Load recent A/B experiments
  let recentExperiments: ABExperiment[] = [];
  try {
    const raw = await readFile(join(DATA, "memory", "experiments.jsonl"), "utf8");
    recentExperiments = raw.split("\n").filter(l => l.trim()).slice(-8).map(l => {
      try { return JSON.parse(l) as ABExperiment; }
      catch { return { id: "?", hypothesis: l.slice(0, 60) }; }
    });
  } catch { /* ignore */ }
  // Load procedure records for GeneticEvolver
  let procedureRecords: ProcedureRecord[] = [];
  try {
    const raw = await readFile(join(DATA, "memory", "procedures.jsonl"), "utf8");
    procedureRecords = raw.split("\n").filter(l => l.trim()).map(l => {
      try { return JSON.parse(l) as ProcedureRecord; } catch { return {}; }
    }).filter(p => p.name);
  } catch { /* ignore */ }
  return { procedures, skills, reflections, experiments, recentSkills, sortedReflections, recentExperiments, procedureRecords };
}

export class EvolutionEngineView extends BaseView {
  private stats: EvoStats | null = null;
  private lastRefresh = 0;

  constructor(screen: AnyElement) {
    super(screen, { title: "EVOLUTION ENGINE", fKey: "F7", width: "80%", height: "85%", borderColor: "#c084fc" });
  }

  show(): void { super.show(); void this.refresh(); }

  private async refresh(): Promise<void> {
    this.stats = await loadEvoStats();
    this.lastRefresh = Date.now();
  }

  protected renderContent(state: DashboardState): string {
    if (Date.now() - this.lastRefresh > 10_000) void this.refresh();
    const s = this.stats;
    const lines: string[] = [
      "{bold}{purple-fg}◈ EVOLUTION ENGINE{/bold}{/}",
      "{#666677-fg}Continuous self-improvement: reflections → skills → procedures{/}",
      "",
    ];
    if (!s) { lines.push("{#444455-fg}  Loading...{/}"); return lines.join("\n"); }

    lines.push(
      "{#888899-fg}IMPROVEMENT LOOP{/}",
      `  {purple-fg}Procedures:  {/}{bold}${s.procedures}{/bold}`,
      `  {purple-fg}Skills:      {/}{bold}${s.skills}{/bold}`,
      `  {purple-fg}Reflections: {/}{bold}${s.reflections}{/bold}`,
      `  {purple-fg}A/B tests:   {/}{bold}${s.experiments}{/bold}`,
      "",
      "{#888899-fg}SESSION PERFORMANCE{/}",
    );
    const total = state.totalCompleted + state.totalFailed;
    const rate  = total > 0 ? ((state.totalCompleted / total) * 100).toFixed(1) : "—";
    lines.push(
      `  {green-fg}Success rate:{/}  {bold}${rate}%{/bold}`,
      `  {yellow-fg}Total cost:{/}    {bold}${fmtCost(state.sessionCost)}{/bold}`,
      `  {cyan-fg}Active tasks:{/}  {bold}${state.activeTasks.size}{/bold}`,
      "",
    );

    if (s.recentSkills.length > 0) {
      lines.push("{#888899-fg}RECENTLY DISTILLED SKILLS{/}");
      for (const sk of s.recentSkills) lines.push(`  {cyan-fg}▸ {/}${trunc(sk, 60)}`);
      lines.push("");
    }
    if (s.sortedReflections.length > 0) {
      lines.push("{#888899-fg}REFLECTIONS — IMPACT SORTED{/}");
      for (const r of s.sortedReflections.slice(0, 12)) {
        const stars = r.score === undefined ? "{#444455-fg}[?  ]{/}" :
          r.score >= 0.8 ? "{yellow-fg}[★★★]{/}" :
          r.score >= 0.5 ? "{yellow-fg}[★★{/}{#666677-fg}○{/}{yellow-fg}]{/}" :
                           "{yellow-fg}[★{/}{#666677-fg}○○{/}{yellow-fg}]{/}";
        lines.push(`  ${stars} {#aaaacc-fg}${trunc(r.summary, 72)}{/}`);
      }
      lines.push("");
    }

    lines.push("{#888899-fg}MEDIATOR DECISIONS (last 5){/}");
    const recent = state.decisions.slice(-5).reverse();
    if (recent.length === 0) lines.push("  {#444455-fg}No decisions recorded yet{/}");
    else for (const d of recent) {
      const confC = d.decision.confidence >= 0.7 ? "green" : d.decision.confidence >= 0.4 ? "yellow" : "red";
      lines.push(
        `  {#666677-fg}${new Date(d.ts).toLocaleTimeString()}{/} {cyan-fg}[${d.decision.action}]{/} ` +
        `{${confC}-fg}${(d.decision.confidence * 100).toFixed(0)}%{/}  ` +
        `{#888899-fg}${trunc(d.decision.reasoning ?? "", 50)}{/}`,
      );
    }

    // A/B Experiments table
    if (s.recentExperiments.length > 0) {
      const now = Date.now();
      const running = s.recentExperiments.filter(e => (e.status ?? "pending") === "running");
      if (running.length > 0) {
        lines.push("{#888899-fg}ACTIVE EXPERIMENTS{/}");
        for (const exp of running) {
          const hyp      = trunc(exp.hypothesis ?? exp.id ?? "?", 50);
          const startMs  = exp.createdAt ? new Date(exp.createdAt).getTime() : now;
          const elapsed  = isNaN(startMs) ? 0 : now - startMs;
          const progress = Math.min(0.99, elapsed / 3_600_000); // assume 1h max
          const progBar  = renderBar(progress, 1, 16);
          lines.push(
            `  {cyan-fg}▸ {/}{#aaaacc-fg}${hyp}{/}`,
            `    {cyan-fg}${progBar}{/} {#666677-fg}${(progress * 100).toFixed(0)}% elapsed{/}`,
          );
        }
        lines.push("");
      }

      lines.push("{#888899-fg}A/B EXPERIMENTS (last 8){/}");
      lines.push("  {#3a3a4a-fg}┌──────────┬─────────────────────────────────────────────┬──────────┐{/}");
      lines.push("  {#3a3a4a-fg}│{/} {#888899-fg}Status   {/} {#3a3a4a-fg}│{/} {#888899-fg}Hypothesis                                   {/} {#3a3a4a-fg}│{/} {#888899-fg}Winner   {/} {#3a3a4a-fg}│{/}");
      lines.push("  {#3a3a4a-fg}├──────────┼─────────────────────────────────────────────┼──────────┤{/}");
      for (const exp of s.recentExperiments) {
        const status = exp.status ?? "pending";
        const sCl    = status === "completed" ? "green" : status === "running" ? "cyan" : "#666677";
        const hyp    = trunc(exp.hypothesis ?? exp.id ?? "?", 43);
        const winner = exp.winnerVariant
          ? `{green-fg}${exp.winnerVariant.slice(0, 7)}${exp.winnerImprovement != null ? `+${exp.winnerImprovement.toFixed(0)}%` : ""}{/}`
          : "{#444455-fg}—        {/}";
        lines.push(
          `  {#3a3a4a-fg}│{/} {${sCl}-fg}${status.slice(0, 8).padEnd(8)}{/} ` +
          `{#3a3a4a-fg}│{/} {#aaaacc-fg}${hyp.padEnd(43)}{/} ` +
          `{#3a3a4a-fg}│{/} ${winner} {#3a3a4a-fg}│{/}`,
        );
      }
      lines.push("  {#3a3a4a-fg}└──────────┴─────────────────────────────────────────────┴──────────┘{/}");
      lines.push("");
    }

    // ── Genetic Evolver ───────────────────────────────────────
    lines.push("{#888899-fg}GENETIC EVOLVER{/}");
    if (s.procedureRecords.length === 0) {
      lines.push("  {#444455-fg}No procedures to evolve yet{/}");
    } else {
      // Fitness = successRate * sqrt(timesUsed + 1)
      const withFitness = s.procedureRecords.map(p => ({
        ...p,
        fitness: (p.successRate ?? 0) * Math.sqrt((p.timesUsed ?? 0) + 1),
      })).sort((a, b) => b.fitness - a.fitness);

      // Population diversity = std-dev of fitness scores
      const fitVals = withFitness.map(p => p.fitness);
      const mean    = fitVals.reduce((s, v) => s + v, 0) / fitVals.length;
      const stdev   = Math.sqrt(fitVals.reduce((s, v) => s + (v - mean) ** 2, 0) / fitVals.length);
      const divC    = stdev > 0.3 ? "green" : stdev > 0.1 ? "yellow" : "red";
      lines.push(
        `  {#666677-fg}Population:{/} {white-fg}${withFitness.length}{/}  ` +
        `{#666677-fg}Diversity:{/} {${divC}-fg}σ=${stdev.toFixed(2)}{/}  ` +
        `{#666677-fg}Generation:{/} {cyan-fg}${Math.floor(s.procedures / 3) + 1}{/}`,
      );

      // Top 4 by fitness
      lines.push("  {#888899-fg}TOP GENOME (fitness = SR × √usage){/}");
      for (const p of withFitness.slice(0, 4)) {
        const srStr  = p.successRate != null ? `{green-fg}${(p.successRate * 100).toFixed(0)}%SR{/}` : "";
        const useStr = p.timesUsed  != null ? `{cyan-fg}${p.timesUsed}×{/}` : "";
        const fitStr = `{yellow-fg}fit=${p.fitness.toFixed(2)}{/}`;
        lines.push(`  {cyan-fg}▸{/} {white-fg}${trunc(p.name ?? "?", 28).padEnd(28)}{/}  ${srStr}  ${useStr}  ${fitStr}`);
      }

      // Mutation candidates = low fitness
      const mutCandidates = withFitness.filter(p => p.fitness < 0.3 && (p.timesUsed ?? 0) >= 2);
      if (mutCandidates.length > 0) {
        lines.push(`  {red-fg}⚠ Mutation candidates (low fitness): ${mutCandidates.map(p => trunc(p.name ?? "?", 15)).join(", ")}{/}`);
      }
    }
    lines.push("");

    // ── Arch Proposer ─────────────────────────────────────────
    lines.push("{#888899-fg}ARCH PROPOSER{/}");
    const proposals: Array<{ text: string; impact: "high" | "medium" | "low" }> = [];
    const agents = [...state.agents.values()];
    // Error-rate-based proposals
    for (const a of agents) {
      if (a.requestsTotal > 3 && a.errorCount / a.requestsTotal > 0.4) {
        proposals.push({ text: `Route away from ${a.provider} (${(a.errorCount / a.requestsTotal * 100).toFixed(0)}% errors)`, impact: "high" });
      }
    }
    // Procedure reuse proposal
    const avgUse = s.procedureRecords.reduce((s, p) => s + (p.timesUsed ?? 0), 0) / Math.max(1, s.procedureRecords.length);
    if (avgUse < 2 && s.procedures > 0) proposals.push({ text: "Low procedure reuse — tighten triggerPattern matching", impact: "medium" });
    // Memory decay proposal
    if (state.memoryStats.decayedFacts > 5) proposals.push({ text: `${state.memoryStats.decayedFacts} decayed facts — run knowledge consolidation`, impact: "medium" });
    // Cost proposal
    const totalCost = agents.reduce((s, a) => s + a.costTotal, 0);
    const cheapAgent = agents.find(a => a.available && (CHEAP_PROVIDERS.includes(a.provider)));
    if (totalCost > 0.1 && !cheapAgent) proposals.push({ text: "Add ollama/lmstudio for cost reduction on simple tasks", impact: "high" });
    // Swarm proposal
    if (state.totalFailed > state.totalCompleted && state.totalFailed > 2) proposals.push({ text: "High failure rate — increase swarm coverage for complex tasks", impact: "high" });
    if (proposals.length === 0) proposals.push({ text: "System architecture is well-optimised ✓", impact: "low" });

    for (const p of proposals.slice(0, 5)) {
      const ic = p.impact === "high" ? "red" : p.impact === "medium" ? "yellow" : "green";
      const tag = `{${ic}-fg}[${p.impact.toUpperCase().slice(0,3)}]{/}`;
      lines.push(`  ${tag} {#aaaacc-fg}${p.text}{/}`);
    }
    lines.push("");

    lines.push("{#666677-fg}DISTILLATION PIPELINE{/}");
    const succRate = state.totalCompleted + state.totalFailed > 0
      ? state.totalCompleted / (state.totalCompleted + state.totalFailed)
      : 0;
    const distillReady = succRate >= 0.9 && s.procedures >= 5;
    lines.push(
      distillReady
        ? `  {green-fg}✓ Ready to distill — ${s.procedures} procedures, ${(succRate * 100).toFixed(0)}% success rate{/}`
        : `  {#666677-fg}Waiting: need ≥5 procedures (${s.procedures}) + ≥90% success rate (${(succRate * 100).toFixed(0)}%){/}`,
    );

    lines.push("", `{#666677-fg}Last refresh: ${this.lastRefresh > 0 ? new Date(this.lastRefresh).toLocaleTimeString() : "—"}{/}`);
    return lines.join("\n");
  }
}
