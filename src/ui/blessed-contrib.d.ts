// Type declarations for blessed-contrib (no official @types package)
declare module "blessed-contrib" {
  import type { Widgets } from "blessed";

  interface GridOptions {
    rows: number;
    cols: number;
    screen: Widgets.Screen;
  }

  interface GridItemOptions {
    row: number;
    col: number;
    rowSpan?: number;
    colSpan?: number;
  }

  class grid {
    constructor(opts: GridOptions);
    set<T>(row: number, col: number, rowSpan: number, colSpan: number, widget: unknown, opts?: Record<string, unknown>): T;
  }

  interface LineOptions extends Widgets.BoxOptions {
    label?: string;
    showLegend?: boolean;
    legend?: { width: number };
    wholeNumbersOnly?: boolean;
    style?: Record<string, unknown>;
    xPadding?: number;
    numYLabels?: number;
    abbreviate?: boolean;
  }

  interface LineData {
    title?: string;
    x: string[];
    y: number[];
    style?: { line?: string; text?: string; baseline?: string };
  }

  class line extends Widgets.BoxElement {
    setData(data: LineData | LineData[]): void;
  }

  interface BarOptions extends Widgets.BoxOptions {
    label?: string;
    barWidth?: number;
    barSpacing?: number;
    xOffset?: number;
    maxHeight?: number;
    style?: Record<string, unknown>;
  }

  interface BarData {
    titles: string[];
    data: number[];
  }

  class bar extends Widgets.BoxElement {
    setData(data: BarData): void;
  }

  interface GaugeOptions extends Widgets.BoxOptions {
    label?: string;
    stroke?: string;
    fill?: string;
    percent?: number | number[];
    stack?: Array<{ percent: number; stroke: string }>;
  }

  class gauge extends Widgets.BoxElement {
    setPercent(percent: number): void;
    setStack(stack: Array<{ percent: number; stroke: string }>): void;
  }

  interface SparklineOptions extends Widgets.BoxOptions {
    label?: string;
    tags?: boolean;
    style?: Record<string, unknown>;
  }

  class sparkline extends Widgets.BoxElement {
    setData(titles: string[], data: number[][]): void;
  }

  interface TableOptions extends Widgets.BoxOptions {
    label?: string;
    keys?: boolean;
    interactive?: boolean;
    columnSpacing?: number;
    columnWidth?: number[];
    fg?: string;
    selectedFg?: string;
    selectedBg?: string;
    style?: Record<string, unknown>;
  }

  class table extends Widgets.BoxElement {
    setData(data: { headers: string[]; data: string[][] }): void;
    rows: Widgets.ListElement;
  }

  interface DonutOptions extends Widgets.BoxOptions {
    label?: string;
    radius?: number;
    arcWidth?: number;
    remainColor?: string;
    yPadding?: number;
    data?: Array<{ percent: number; label: string; color: string }>;
  }

  class donut extends Widgets.BoxElement {
    setData(data: Array<{ percent: number; label: string; color: string }>): void;
  }

  interface LogOptions extends Widgets.BoxOptions {
    label?: string;
    tags?: boolean;
    fg?: string;
    selectedFg?: string;
    style?: Record<string, unknown>;
  }

  class log extends Widgets.ScrollableBoxElement {
    log(text: string): void;
    add(text: string): void;
  }

  interface TreeOptions extends Widgets.BoxOptions {
    label?: string;
    style?: Record<string, unknown>;
    template?: Record<string, unknown>;
  }

  interface TreeNode {
    name: string;
    children?: Record<string, TreeNode>;
    extended?: boolean;
    selected?: boolean;
  }

  class tree extends Widgets.BoxElement {
    setData(data: { extended: boolean; children: Record<string, TreeNode> }): void;
    on(event: "select", cb: (node: TreeNode) => void): this;
    on(event: string, cb: (...args: unknown[]) => void): this;
  }

  interface MapOptions extends Widgets.BoxOptions {
    label?: string;
    style?: { bg?: string; fg?: string; shiftX?: number; shiftY?: number };
  }

  class map extends Widgets.BoxElement {
    addMarker(opts: { lon: string; lat: string; color: string; char: string }): void;
    clearMarkers(): void;
  }

  interface LcdOptions extends Widgets.BoxOptions {
    label?: string;
    segmentWidth?: number;
    segmentInterval?: number;
    strokeWidth?: number;
    elements?: number;
    display?: number;
    elementSpacing?: number;
    elementPadding?: number;
    color?: string;
    stroke?: string;
  }

  class lcd extends Widgets.BoxElement {
    setDisplay(value: number): void;
    setOptions(opts: LcdOptions): void;
  }

  const contrib: {
    grid: typeof grid;
    line: typeof line;
    bar: typeof bar;
    gauge: typeof gauge;
    sparkline: typeof sparkline;
    table: typeof table;
    donut: typeof donut;
    log: typeof log;
    tree: typeof tree;
    map: typeof map;
    lcd: typeof lcd;
  };

  export = contrib;
}
