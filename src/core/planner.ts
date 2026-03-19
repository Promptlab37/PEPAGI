// ═══════════════════════════════════════════════════════════════
// PEPAGI — Hierarchical Planner (Strategic → Tactical → Operational)
// ═══════════════════════════════════════════════════════════════

import { nanoid } from "nanoid";
import type { Task } from "./types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import { parseLLMJson } from "./parse-llm-json.js";

const logger = new Logger("Planner");

export interface PlanNode {
  id: string;
  level: "strategic" | "tactical" | "operational";
  title: string;
  description: string;
  status: "planned" | "in_progress" | "completed" | "failed" | "replanned";
  children: PlanNode[];
  taskId?: string;
}

export interface PlanTree {
  taskId: string;
  root: PlanNode[];
  createdAt: Date;
  /** ERR-02: true when the plan fell back to a minimal single-node default due to an LLM
   *  failure. The mediator should treat a degraded plan as low-confidence and may choose
   *  to retry planning or escalate to swarm mode. */
  degraded?: boolean;
}

function makeNode(level: PlanNode["level"], title: string, description: string): PlanNode {
  return { id: nanoid(6), level, title, description, status: "planned", children: [] };
}

export class HierarchicalPlanner {
  constructor(private llm: LLMProvider) {}

  /**
   * Generate a 3-level hierarchical plan for a complex task.
   */
  async plan(task: Task): Promise<PlanTree> {
    logger.info("Planning task", { taskId: task.id, title: task.title });

    // Level 1: Strategic — major components.
    // ERR-02: track whether the strategic step fell back to a single-node default so the
    // mediator can check planTree.degraded and treat the result as low-confidence.
    const { nodes: strategic, degraded } = await this.generateStrategicPlanWithFlag(task);

    // PERF-04: strategic goals are independent of each other, so we fan-out all tactical
    // calls in parallel instead of awaiting them one at a time.
    await Promise.all(strategic.map(async (node) => {
      // Level 2: Tactical — what each strategic component requires.
      node.children = await this.generateTacticalPlan(task, node);

      // Level 3: Operational — concrete steps for each tactical requirement.
      // Operational calls within a strategic branch are also independent once tactical
      // results are available, so we parallelise them too.
      await Promise.all(node.children.map(async (tactical) => {
        tactical.children = await this.generateOperationalPlan(task, node, tactical);
      }));
    }));

    const tree: PlanTree = {
      taskId: task.id,
      root: strategic,
      createdAt: new Date(),
      // ERR-02: surface the fallback signal so callers can act on it
      degraded,
    };

    if (degraded) {
      logger.warn("Plan degraded to single-node fallback — LLM strategic call failed", { taskId: task.id });
    }
    logger.info("Plan generated", { taskId: task.id, strategicCount: strategic.length, degraded });
    // Emit TUI events per level for neural stream
    const tacticalCount    = strategic.reduce((s, n) => s + n.children.length, 0);
    const operationalCount = strategic.reduce((s, n) => n.children.reduce((ss, c) => ss + c.children.length, s), 0);
    eventBus.emit({ type: "planner:plan", taskId: task.id, level: "strategic",   steps: strategic.length });
    if (tacticalCount    > 0) eventBus.emit({ type: "planner:plan", taskId: task.id, level: "tactical",    steps: tacticalCount });
    if (operationalCount > 0) eventBus.emit({ type: "planner:plan", taskId: task.id, level: "operational", steps: operationalCount });
    return tree;
  }

  /**
   * Internal helper that returns the strategic nodes together with a degraded flag.
   * Separating the flag from the node array avoids changing the private method's return
   * type while keeping the public API clean.
   */
  private async generateStrategicPlanWithFlag(task: Task): Promise<{ nodes: PlanNode[]; degraded: boolean }> {
    const response = await this.llm.quickClaude(
      "You are a strategic planner. Identify the major high-level components needed for a task. Return ONLY a JSON array of {title, description} objects (2-5 items).",
      `Task: "${task.title}"\nDescription: "${task.description}"\n\nList the major strategic components (e.g., backend, frontend, deployment).`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const items = parseLLMJson<Array<{ title: string; description: string }>>(response.content);
      return { nodes: items.map(i => makeNode("strategic", i.title, i.description)), degraded: false };
    } catch {
      // ERR-02: LLM returned unparseable JSON — fall back to a single root node and mark
      // the plan as degraded so the mediator can treat it as low-confidence.
      return {
        nodes: [makeNode("strategic", task.title, task.description)],
        degraded: true,
      };
    }
  }

  private async generateTacticalPlan(task: Task, strategicNode: PlanNode): Promise<PlanNode[]> {
    const response = await this.llm.quickClaude(
      "Break down a strategic goal into tactical requirements. Return ONLY a JSON array of {title, description} objects (2-4 items).",
      `Overall task: "${task.title}"\nStrategic goal: "${strategicNode.title}: ${strategicNode.description}"\n\nList tactical requirements for this goal.`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const items = parseLLMJson<Array<{ title: string; description: string }>>(response.content);
      return items.map(i => makeNode("tactical", i.title, i.description));
    } catch {
      return [makeNode("tactical", `Implement ${strategicNode.title}`, strategicNode.description)];
    }
  }

  private async generateOperationalPlan(task: Task, strategic: PlanNode, tactical: PlanNode): Promise<PlanNode[]> {
    const response = await this.llm.quickClaude(
      "Convert tactical requirements into concrete operational steps. Return ONLY a JSON array of {title, description} objects (2-5 items).",
      `Task: "${task.title}"\nGoal: "${strategic.title}" → "${tactical.title}: ${tactical.description}"\n\nList concrete steps to implement this.`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const items = parseLLMJson<Array<{ title: string; description: string }>>(response.content);
      return items.map(i => makeNode("operational", i.title, i.description));
    } catch {
      return [makeNode("operational", `Execute: ${tactical.title}`, tactical.description)];
    }
  }

  /**
   * Replan at a specific level when a step fails.
   * @param failedNode - The node that failed
   * @param tree - Full plan tree
   * @param task - Original task
   * @returns Updated children for the parent of the failed node
   */
  async replan(failedNode: PlanNode, task: Task): Promise<PlanNode[]> {
    logger.info("Replanning", { nodeId: failedNode.id, level: failedNode.level, taskId: task.id });

    failedNode.status = "replanned";

    // Replan at one level up
    const response = await this.llm.quickClaude(
      "Replan a failed step using a different approach. Return ONLY a JSON array of {title, description} objects.",
      `Task: "${task.title}"\nFailed step: "${failedNode.title}: ${failedNode.description}"\n\nGenerate alternative approach.`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const items = parseLLMJson<Array<{ title: string; description: string }>>(response.content);
      return items.map(i => makeNode(failedNode.level, `[retry] ${i.title}`, i.description));
    } catch {
      return [makeNode(failedNode.level, `[retry] ${failedNode.title}`, failedNode.description)];
    }
  }

  /** Get all operational steps from a plan tree */
  getOperationalSteps(tree: PlanTree): PlanNode[] {
    const ops: PlanNode[] = [];
    for (const strategic of tree.root) {
      for (const tactical of strategic.children) {
        ops.push(...tactical.children);
      }
    }
    return ops;
  }

  /** Format plan tree as human-readable string */
  formatPlan(tree: PlanTree): string {
    const lines: string[] = [];
    for (const s of tree.root) {
      lines.push(`📋 ${s.title}`);
      for (const t of s.children) {
        lines.push(`  📌 ${t.title}`);
        for (const o of t.children) {
          lines.push(`    ▶ ${o.title}`);
        }
      }
    }
    return lines.join("\n");
  }
}
