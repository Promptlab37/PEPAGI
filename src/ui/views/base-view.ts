// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Base View (overlay scaffolding)
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { blessed } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyElement = any;

export interface ViewOptions {
  title:       string;
  fKey:        string;
  width:       string | number;
  height:      string | number;
  borderColor: string;
}

export abstract class BaseView {
  protected box:     AnyElement;
  protected content: AnyElement;
  private   _visible = false;

  constructor(
    protected readonly screen:  AnyElement,
    protected readonly opts:    ViewOptions,
  ) {
    this.box = blessed.box({
      parent:  screen,
      top:     "center",
      left:    "center",
      width:   opts.width,
      height:  opts.height,
      tags:    true,
      border:  { type: "line", fg: opts.borderColor },
      label:   ` {bold}{${opts.borderColor}-fg}[${opts.fKey}] ${opts.title}{/}{/} `,
      style:   { fg: "white", bg: "#0a0a16", border: { fg: opts.borderColor } },
      hidden:  true,
      shadow:  true,
    });

    this.content = blessed.box({
      parent:       this.box,
      top:          1,
      left:         1,
      width:        "100%-4",
      height:       "100%-4",
      tags:         true,
      scrollable:   true,
      alwaysScroll: false,
      scrollbar:    { ch: "│", style: { fg: "#3a3a4a" } },
      style:        { fg: "white", bg: "#0a0a16" },
      keys:         true,
      vi:           true,
    });

    blessed.box({
      parent:  this.box,
      bottom:  1,
      left:    1,
      width:   "100%-4",
      height:  1,
      tags:    true,
      content: " {#666677-fg}[Escape] close  [↑↓] scroll  [PgUp/PgDn] page{/} ",
      style:   { fg: "grey", bg: "#0a0a16" },
    });
  }

  show(): void {
    this._visible = true;
    this.box.show();
    this.content.focus();
  }

  hide(): void {
    this._visible = false;
    this.box.hide();
  }

  isVisible(): boolean { return this._visible; }

  update(state: DashboardState): void {
    if (!this._visible) return;
    this.content.setContent(this.renderContent(state));
  }

  protected abstract renderContent(state: DashboardState): string;

  getElement(): AnyElement { return this.box; }
}
