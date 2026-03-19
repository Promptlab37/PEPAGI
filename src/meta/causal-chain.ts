// ═══════════════════════════════════════════════════════════════
// PEPAGI — Causal Chain (Decision Causality Tracking)
// ═══════════════════════════════════════════════════════════════

import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { eventBus } from "../core/event-bus.js";

export interface CausalNode {
  id: string;
  taskId: string;
  action: string;
  reason: string;
  parentNodeId: string | null;
  timestamp: Date;
  outcome: "success" | "failure" | "pending";
  counterfactual?: string;
}

export class CausalChain {
  private nodes: Map<string, CausalNode[]> = new Map(); // taskId -> nodes

  constructor() {
    // MEM-06: evict in-memory nodes when a task reaches a terminal state.
    // persist() is called by the mediator just before completion, so by the
    // time this event fires the data is already on disk.
    // task events carry taskId at top level, not nested under payload
    eventBus.on("task:completed", (e) => { if (e.taskId) this.nodes.delete(e.taskId); });
    eventBus.on("task:failed",    (e) => { if (e.taskId) this.nodes.delete(e.taskId); });
  }

  /** Add a decision node */
  addNode(params: {
    taskId: string;
    action: string;
    reason: string;
    parentNodeId?: string;
    counterfactual?: string;
  }): CausalNode {
    const node: CausalNode = {
      id: nanoid(8),
      taskId: params.taskId,
      action: params.action,
      reason: params.reason,
      parentNodeId: params.parentNodeId ?? null,
      timestamp: new Date(),
      outcome: "pending",
      counterfactual: params.counterfactual,
    };

    const chain = this.nodes.get(params.taskId) ?? [];
    const parentAction = params.parentNodeId
      ? (chain.find(n => n.id === params.parentNodeId)?.action ?? null)
      : null;
    chain.push(node);
    this.nodes.set(params.taskId, chain);

    eventBus.emit({
      type: "causal:node",
      taskId: params.taskId,
      action: params.action,
      reason: params.reason,
      parentAction,
      counterfactual: params.counterfactual,
    });

    return node;
  }

  /** Update node outcome */
  updateOutcome(nodeId: string, taskId: string, outcome: "success" | "failure"): void {
    const chain = this.nodes.get(taskId) ?? [];
    const node = chain.find(n => n.id === nodeId);
    if (node) node.outcome = outcome;
  }

  /** Get full chain for a task */
  getChain(taskId: string): CausalNode[] {
    return this.nodes.get(taskId) ?? [];
  }

  /** Trace back from a failure to identify root cause */
  traceFailure(taskId: string): string {
    const chain = this.getChain(taskId);
    const failures = chain.filter(n => n.outcome === "failure");

    if (failures.length === 0) return "No failures recorded";

    const trace = failures.map(f => {
      const parent = f.parentNodeId ? chain.find(n => n.id === f.parentNodeId) : null;
      return `- ${f.action}: ${f.reason}${parent ? ` (after: ${parent.action})` : ""}`;
    });

    return `Failure trace:\n${trace.join("\n")}`;
  }

  /** Save chain to disk */
  async persist(taskId: string): Promise<void> {
    const chain = this.getChain(taskId);
    if (chain.length === 0) return;

    const dir = join(PEPAGI_DATA_DIR, "causal");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${taskId}.json`);
    // AUD-03: atomic write — temp file + rename prevents corruption on crash
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(chain, null, 2), "utf8");
    await rename(tmp, path);

    // MEM-06: drop the in-memory nodes once safely persisted — keeping them
    // after this point only wastes RAM; they can be reloaded via load() if needed.
    this.nodes.delete(taskId);
  }

  /** Load chain from disk */
  async load(taskId: string): Promise<void> {
    const path = join(PEPAGI_DATA_DIR, "causal", `${taskId}.json`);
    if (!existsSync(path)) return;
    const content = await readFile(path, "utf8");
    const nodes = JSON.parse(content) as CausalNode[];
    this.nodes.set(taskId, nodes);
  }

  /** Generate decision summary for reporting */
  summarize(taskId: string): string {
    const chain = this.getChain(taskId);
    if (chain.length === 0) return "No decisions recorded";

    return chain
      .map(n => `[${n.outcome}] ${n.action}: ${n.reason.slice(0, 80)}`)
      .join("\n");
  }
}
