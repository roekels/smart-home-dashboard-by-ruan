// The Brain map's graph: forces, focus fade, synapses, flashes, labels, orbit and camera moves.
//  - it lives in a box on the page (sizes come from the host, not the window), and cleans up on destroy();
//  - colours come from the dashboard's tokens (palette.ts), never fixed hex values;
//  - the hover tooltip uses classes, not inline styles (the page CSP has no 'unsafe-inline').

import { ForceGraph3D, ForceGraph, SphereGeometry, Mesh, MeshBasicMaterial, AdditiveBlending, NormalBlending, Color, Vector3 } from "../../../vendor/brain-map.js";
import type { GNode, GLink, Graph } from "./source.ts";
import type { Settings } from "./settings.ts";
import { type Palette, type RGB, rgba, whoOf, mix, hsl } from "./palette.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const nid = (x: string | GNode) => (typeof x === "string" ? x : x.id);

export interface GraphHandlers { onNodeClick(n: GNode): void; onBackgroundClick(): void }

/** Opacity by hops from the focused note: itself and its neighbours full, then 50%, 25%, 10%. */
const FADE = [1, 1, 0.5, 0.25];
const FAR = 0.1;
/** The slow orbit starts this long after the last touch of the map. */
const ORBIT_AFTER_MS = 2000;
/** How close the overview stands: 1 = the body of the map just fits, below 1 = closer. */
const FIT = 1;
/** One round of the orbit, in seconds (the screensaver takes twice as long). */
const ORBIT_ROUND_S = 120;

export class BrainGraph {
  private g: any;
  private data: Graph = { roots: [], nodes: [], links: [] };
  private el: HTMLElement;
  private host: HTMLElement;
  private h: GraphHandlers;
  private byId = new Map<string, GNode>();
  private byPath = new Map<string, GNode>();
  private adj = new Map<string, GLink[]>();
  /** Each note's colour as hue, saturation and lightness (retint). */
  private tints = new Map<string, { h: number; s: number; l: number }>();
  private pal!: Palette;
  private settings!: Settings;
  private fitted = false;

  /** Space the side panel takes on the right (desktop) or bottom (phone). */
  private inset = { right: 0, bottom: 0 };
  private lastClick = { id: "", at: 0 };

  /** The focused note and how many hops every other note is from it. */
  private focusId: string | null = null;
  private hops = new Map<string, number>();
  /** Per focused link: how often it fires (more when more notes lie beyond it) and when next. */
  private weight = new Map<GLink, number>();
  private nextAt = new Map<GLink, number>();
  private synTimer = 0;
  private orbitRaf = 0;
  private orbitAt = 0;   // the auto-orbit waits until this time (after a fly-in or the user's own dragging)
  private lastT = 0;
  /** Short local flashes: where a synapse fires and where it lands. */
  private flashes: { n: GNode; start: number; dur: number; grow: number; peak: number; mesh?: Mesh }[] = [];
  private arrivals: { n: GNode; frames: number; peak: number }[] = [];
  private fxRaf = 0;
  private timers = new Set<number>();
  private paused = false;
  /** Screensaver: the orbit at half speed, flashes half as bright and large again. */
  private calm = false;
  private static ball = new SphereGeometry(1, 16, 12);
  /** Labels for the focused note and its busiest direct links (10 at most), kept over the nodes each frame. */
  private labelBox = document.createElement("div");
  private labelled: { n: GNode; el: HTMLElement }[] = [];
  private labelRaf = 0;

  /** `el` holds the canvas; `host` is the whole map box (labels and tags are placed in it). */
  constructor(el: HTMLElement, host: HTMLElement, h: GraphHandlers) {
    this.el = el; this.host = host; this.h = h;
    this.labelBox.className = "bm-labels";
    host.append(this.labelBox);
  }

  private get W() { return this.host.clientWidth; }
  private get H() { return this.host.clientHeight; }

  setInset(right: number, bottom: number) {
    this.inset = { right, bottom };
    this.resize();
  }
  resize() {
    this.g?.width(Math.max(1, this.W - this.inset.right)).height(Math.max(1, this.H - this.inset.bottom));
  }

  /** Stop drawing while the map is out of view (another tab); resume picks up where it was. */
  pause() {
    if (this.paused || !this.g) return;
    this.paused = true;
    this.g.pauseAnimation();
    this.stopOrbit();
    clearInterval(this.synTimer);
    this.synTimer = 0;
    cancelAnimationFrame(this.labelRaf);
    this.labelRaf = 0;
  }
  resume() {
    if (!this.paused || !this.g) return;
    this.paused = false;
    this.resize();
    this.g.resumeAnimation();
    this.syncMotion();
  }

  destroy() {
    this.pause();
    cancelAnimationFrame(this.fxRaf);
    this.timers.forEach(clearTimeout);
    for (const f of this.flashes) f.mesh?.removeFromParent();
    this.flashes = [];
    this.g?._destructor?.();
    this.g = null;
    this.labelBox.remove();
  }

  private later(fn: () => void, ms: number) {
    const t = window.setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  // ---------- data ----------

  setData(d: Graph) {
    // Keep positions of nodes we already had, so a refresh doesn't scramble the layout.
    const old = this.byId;
    for (const n of d.nodes) {
      const o = old.get(n.id);
      if (o) Object.assign(n, { x: o.x, y: o.y, z: o.z, vx: (o as any).vx, vy: (o as any).vy, vz: (o as any).vz });
    }
    this.data = d;
    this.byId = new Map(d.nodes.map((n) => [n.id, n]));
    this.byPath = new Map(d.nodes.map((n) => [n.path, n]));
    this.adj = new Map();
    for (const l of d.links) for (const id of [nid(l.source), nid(l.target)]) {
      if (!this.adj.has(id)) this.adj.set(id, []);
      this.adj.get(id)!.push(l);
    }
    if (this.focusId && !this.byId.has(this.focusId)) this.focusId = null;
    this.computeFocus();
    this.retint();
    this.g?.graphData(d);
    this.syncMotion();
  }
  node(path: string) { return this.byPath.get(path); }
  nodeById(id: string) { return this.byId.get(id); }
  get nodes() { return this.data.nodes; }
  get instance() { return this.g; }

  // ---------- focus ----------

  get focused() { return this.focusId; }

  /** Highlight one note: synapses loop out to its neighbours, the rest fades with distance. */
  setFocus(n: GNode | null) {
    if ((n?.id ?? null) === this.focusId) return;
    this.focusId = n?.id ?? null;
    this.computeFocus();
    this.restyle();
  }

  private computeFocus() {
    this.hops = new Map();
    const f = this.focusId;
    if (!f) return;
    this.hops.set(f, 0);
    let frontier = [f];
    for (let d = 1; frontier.length && d < FADE.length; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const l of this.adj.get(id) ?? []) {
        const o = nid(l.source) === id ? nid(l.target) : nid(l.source);
        if (!this.hops.has(o)) { this.hops.set(o, d); next.push(o); }
      }
      frontier = next;
    }
    // Point the focused note's links outward, so the synapses run from it to its neighbours.
    this.weight = new Map();
    for (const l of this.adj.get(f) ?? []) {
      if (nid(l.target) === f) [l.source, l.target] = [l.target, l.source];
      // A neighbour that opens onto more 2nd- and 3rd-tier notes fires more often.
      const m = nid(l.target);
      let t2 = 0, t3 = 0;
      const seen = new Set<string>();
      for (const l2 of this.adj.get(m) ?? []) {
        const x = nid(l2.source) === m ? nid(l2.target) : nid(l2.source);
        if (this.hops.get(x) !== 2 || seen.has(x)) continue;
        seen.add(x); t2++;
        for (const l3 of this.adj.get(x) ?? []) {
          const y = nid(l3.source) === x ? nid(l3.target) : nid(l3.source);
          if (this.hops.get(y) === 3 && !seen.has(y)) { seen.add(y); t3++; }
        }
      }
      this.weight.set(l, 1 + t2 + t3 * 0.5);
    }
  }

  /** Mean gap between synapses on a link: about 7 s for a dead end, down to about 1.2 s for a busy one. */
  private gap(l: GLink) { return Math.max(1200, 7000 / Math.sqrt(this.weight.get(l) ?? 1)); }

  /** The focused note plus its 9 most-connected neighbours. */
  private labelSet(): GNode[] {
    if (!this.focusId) return [];
    const f = this.byId.get(this.focusId);
    if (!f) return [];
    const nb = [...this.hops].filter(([, h]) => h === 1).map(([id]) => this.byId.get(id)!).filter((n) => n && this.visible(n));
    nb.sort((a, b) => b.degree - a.degree);
    return [f, ...nb.slice(0, 9)];
  }

  private syncLabels() {
    cancelAnimationFrame(this.labelRaf);
    this.labelRaf = 0;
    this.labelBox.replaceChildren();
    this.labelled = this.labelSet().map((n, i) => {
      const el = document.createElement("div");
      el.className = i === 0 ? "bm-label is-focus" : "bm-label";
      el.textContent = n.title;
      el.style.setProperty("--c", this.flashColor(n));
      this.labelBox.append(el);
      return { n, el };
    });
    if (!this.labelled.length || !this.g || this.paused) return;
    const step = () => {
      this.labelRaf = requestAnimationFrame(step);
      const d3 = this.settings.view === "3d";
      const w = this.W - this.inset.right, h = this.H - this.inset.bottom;
      const cam = d3 ? this.g.camera() : null;
      for (const { n, el } of this.labelled) {
        const c = d3 ? this.g.graph2ScreenCoords(n.x, n.y, n.z) : this.g.graph2ScreenCoords(n.x, n.y);
        // In 3D, skip nodes behind the camera (their projection lands somewhere misleading).
        let behind = false;
        if (cam) {
          const dx = (n.x ?? 0) - cam.position.x, dy = (n.y ?? 0) - cam.position.y, dz = (n.z ?? 0) - cam.position.z;
          const dir = cam.getWorldDirection(this.tmpV);
          behind = dx * dir.x + dy * dir.y + dz * dir.z <= 0;
        }
        const off = !c || behind || c.x < 0 || c.y < 0 || c.x > w || c.y > h;
        el.style.opacity = off ? "0" : "";
        if (off) continue;
        // Sit just below the node: its on-screen radius, roughly, plus a gap.
        let r: number;
        if (d3) {
          const up = this.tmpUp.copy(cam!.up).applyQuaternion(cam!.quaternion).multiplyScalar(this.radius(n));
          const t = this.g.graph2ScreenCoords((n.x ?? 0) + up.x, (n.y ?? 0) + up.y, (n.z ?? 0) + up.z);
          r = Math.hypot(t.x - c.x, t.y - c.y);
        } else r = this.radius(n) * this.g.zoom();
        el.style.transform = `translate(${c.x}px, ${c.y + r + 8}px) translateX(-50%)`;
      }
    };
    this.labelRaf = requestAnimationFrame(step);
  }
  private tmpV = new Vector3();
  private tmpUp = new Vector3();

  /** The person did something (moved, clicked, typed): the orbit waits again. A drag in progress keeps it off. */
  touch() {
    if (this.orbitAt !== Infinity) this.orbitAt = Math.max(this.orbitAt, performance.now() + ORBIT_AFTER_MS);
  }
  setScreensaver(on: boolean) { this.calm = on; }

  /** Start or stop the looping synapses and the slow orbit to match focus, view and settings. */
  private syncMotion() {
    this.syncLabels();
    clearInterval(this.synTimer);
    this.synTimer = 0;
    this.nextAt = new Map();
    const on = !!this.g && !this.paused && !!this.focusId && !!this.settings?.animations;
    if (on) {
      const now = performance.now();
      for (const l of this.weight.keys()) this.nextAt.set(l, now + Math.random() * this.gap(l));
      this.synTimer = window.setInterval(() => {
        const t = performance.now();
        for (const [l, at] of this.nextAt) if (t >= at) {
          this.fire(l);
          this.nextAt.set(l, t + this.gap(l) * (0.4 + Math.random() * 1.2));
        }
      }, 120);
    }
    // The orbit turns the whole brain, or the focused note's surroundings, whenever the map is left alone.
    if (this.g && !this.paused && this.settings?.animations && this.settings.view === "3d") this.startOrbit();
    else this.stopOrbit();
  }

  /** A very slow turn around what's in view (about 2 minutes a round); waits while the map is being used. */
  private startOrbit() {
    if (this.orbitRaf) return;
    this.lastT = 0;
    const step = (t: number) => {
      this.orbitRaf = requestAnimationFrame(step);
      const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
      this.lastT = t;
      if (t < this.orbitAt || !this.g) return;
      const cam = this.g.camera(), tg = this.g.controls().target;
      const a = (dt / 1000) * ((2 * Math.PI) / ORBIT_ROUND_S) * (this.calm ? 0.5 : 1);
      const dx = cam.position.x - tg.x, dz = cam.position.z - tg.z;
      cam.position.x = tg.x + dx * Math.cos(a) - dz * Math.sin(a);
      cam.position.z = tg.z + dx * Math.sin(a) + dz * Math.cos(a);
      cam.lookAt(tg);
    };
    this.orbitRaf = requestAnimationFrame(step);
  }
  private stopOrbit() {
    cancelAnimationFrame(this.orbitRaf);
    this.orbitRaf = 0;
  }

  private fade(id: string) {
    if (!this.focusId) return 1;
    const h = this.hops.get(id);
    return h === undefined ? FAR : FADE[h] ?? FAR;
  }
  private touchesFocus = (l: GLink) => !!this.focusId && (nid(l.source) === this.focusId || nid(l.target) === this.focusId);

  /** Re-apply every style accessor (after focus or flash changes). */
  private restyle() {
    if (!this.g) return;
    this.g.nodeColor(this.color).nodeVal(this.size).linkColor(this.linkColor).linkWidth(this.linkWidth)
      .linkDirectionalParticleColor(this.particleColor)
      .linkDirectionalParticleWidth(this.particleWidth).linkDirectionalParticleSpeed(this.particleSpeed);
    this.syncMotion();
  }

  // ---------- flashes ----------

  /** Send a synapse along a link: a small flash where it leaves, a brighter one where it lands. */
  private fire(l: GLink, peak = 1) {
    if (!this.g) return;
    this.g.emitParticle(l);
    if (!this.settings?.animations) return;
    const src = l.source as GNode, dst = l.target as GNode;
    if (typeof src !== "object" || typeof dst !== "object") return;
    this.flash(src, 0.45 * peak, 240, 0.7);
    // Particles move `speed` of the link per rendered frame, so they land after 1/speed frames.
    this.arrivals.push({ n: dst, frames: Math.ceil(1 / this.particleSpeed(l)), peak });
    this.startFx();
  }

  private flash(n: GNode, peak: number, dur = 380, grow = 1.5) {
    if (!this.visible(n) || !this.g) return;
    if (this.calm) { peak = Math.min(1, peak * 1.5); grow *= 1.5; }
    const f: (typeof this.flashes)[number] = { n, start: performance.now(), dur, grow, peak };
    if (this.settings.view === "3d") {
      const mat = new MeshBasicMaterial({ color: new Color(this.flashColor(n)), transparent: true, opacity: peak, depthWrite: false, blending: this.pal.dark ? AdditiveBlending : NormalBlending });
      f.mesh = new Mesh(BrainGraph.ball, mat);
      f.mesh.renderOrder = 10;
      this.g.scene().add(f.mesh);
    }
    this.flashes.push(f);
    this.startFx();
  }
  private flashColor(n: GNode) {
    const h = this.hue(n);
    return this.pal.dark ? `hsl(${h}, 100%, 82%)` : `hsl(${h}, 90%, 45%)`;
  }
  /** On-screen radius of a node, as the graph libraries draw it (nodeRelSize 4). */
  private radius(n: GNode) {
    const v = this.size(n);
    return this.settings.view === "3d" ? Math.cbrt(v) * 4 : Math.sqrt(v) * 4;
  }

  private startFx() {
    if (this.fxRaf) return;
    const step = () => {
      for (const a of this.arrivals) a.frames--;
      const landed = this.arrivals.filter((a) => a.frames <= 0);
      this.arrivals = this.arrivals.filter((a) => a.frames > 0);
      for (const a of landed) this.flash(a.n, 0.85 * a.peak);
      const now = performance.now();
      this.flashes = this.flashes.filter((f) => {
        const p = (now - f.start) / f.dur;
        if (p >= 1) { if (f.mesh) { f.mesh.removeFromParent(); f.mesh.material.dispose(); } return false; }
        if (f.mesh) {
          const ease = 1 - (1 - p) * (1 - p);
          f.mesh.position.set(f.n.x ?? 0, f.n.y ?? 0, f.n.z ?? 0);
          f.mesh.scale.setScalar(this.radius(f.n) * (1.05 + f.grow * ease));
          f.mesh.material.opacity = f.peak * (1 - p) * (1 - p);
        }
        return true;
      });
      this.fxRaf = this.flashes.length || this.arrivals.length ? requestAnimationFrame(step) : 0;
    };
    this.fxRaf = requestAnimationFrame(step);
  }

  /** 2D: draw the flashes on top of the canvas each frame. */
  private drawFlashes = (ctx: CanvasRenderingContext2D) => {
    const now = performance.now();
    for (const f of this.flashes) {
      const p = Math.min(1, (now - f.start) / f.dur);
      const ease = 1 - (1 - p) * (1 - p);
      const r = this.radius(f.n) * (1.05 + f.grow * ease);
      ctx.save();
      ctx.globalAlpha = f.peak * (1 - p) * (1 - p);
      ctx.fillStyle = this.flashColor(f.n);
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = r;
      ctx.beginPath();
      ctx.arc(f.n.x ?? 0, f.n.y ?? 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // ---------- look ----------

  /**
   * Colour by root: a person's notes take that person's colour, shared notes the neutral one. A note that links
   * into other roots sits between them in colour too: the more of its links cross over, the further it blends
   * (up to 40%, keeping its own saturation so blends don't turn grey). Branches below a root differ by a few
   * degrees of hue, so neighbours can be told apart.
   */
  private retint() {
    this.tints = new Map();
    if (!this.pal) return;
    const own = new Map(this.data.nodes.map((n) => [n.id, whoOf(n.root)]));
    for (const n of this.data.nodes) {
      const mine = own.get(n.id)!;
      const links = this.adj.get(n.id) ?? [];
      const other: RGB[] = [];
      for (const l of links) {
        const b = own.get(nid(l.source) === n.id ? nid(l.target) : nid(l.source));
        if (b !== undefined && b !== mine) other.push(this.pal.tint[b]);
      }
      let c = this.pal.tint[mine];
      if (other.length) {
        const avg = other.reduce((a, x) => ({ r: a.r + x.r / other.length, g: a.g + x.g / other.length, b: a.b + x.b / other.length }), { r: 0, g: 0, b: 0 });
        c = mix(c, avg, Math.min(0.4, (other.length / links.length) * 0.7));
      }
      const t = hsl(c);
      // Mixing two far-apart colours (red and blue) greys them out; keep most of the branch's own saturation.
      t.s = Math.max(t.s, hsl(this.pal.tint[mine]).s * 0.85);
      t.h = (t.h + ((hash(n.path.split("/")[1] ?? "") % 5) - 2) * 4 + 360) % 360;
      this.tints.set(n.id, t);
    }
  }
  private tint(n: GNode) { return this.tints.get(n.id) ?? { h: 0, s: 0, l: 50 }; }
  private hue(n: GNode) { return this.tint(n).h; }
  private color = (n: GNode) => {
    const p = this.pal, dark = p.dark;
    if (n.__flash && n.__flash > performance.now()) return rgba(p.ink, 1);
    const a = this.fade(n.id);
    if (n.id === this.focusId) return dark ? `hsl(${this.hue(n)}, 100%, 88%)` : `hsl(${this.hue(n)}, 90%, 42%)`;
    if (n.archived) return rgba(p.muted, (dark ? 0.32 : 0.35) * a);
    // The branch colour, a little lighter near the root and deeper further down; sensitive notes are muted.
    const t = this.tint(n);
    const depth = Math.min(n.path.split("/").length - 1, 4);
    const light = Math.max(18, Math.min(86, t.l + (2 - depth) * (dark ? 3 : 2.5)));
    const sat = n.sensitivity === "sensitive" ? t.s * 0.55 : t.s;
    return `hsla(${t.h}, ${sat}%, ${light}%, ${a})`;
  };
  private size = (n: GNode) => {
    const base = n.parent_id === null ? 14 : 1 + Math.sqrt(n.degree) * (n.kind === "hub" ? 1.6 : 1.1);
    if (n.id !== this.focusId) return base;
    return this.settings?.view === "2d" ? base * 1.3 + 2 : base * 1.8 + 4;
  };
  private linkColor = (l: GLink) => {
    const p = this.pal, dark = p.dark;
    if (this.touchesFocus(l)) {
      const f = this.byId.get(this.focusId!)!;
      return dark ? `hsla(${this.hue(f)}, 95%, 78%, 0.85)` : `hsla(${this.hue(f)}, 85%, 45%, 0.85)`;
    }
    const a = Math.min(this.fade(nid(l.source)), this.fade(nid(l.target)));
    switch (l.kind) {
      // Same alphas as the original map; the brand keeps tree and plain links neutral (ink), typed links in colour.
      case "tree": return rgba(p.ink, 0.16 * a);
      case "followed": return rgba(p.followed, 0.55 * a);
      case "caused_by": return rgba(p.causedBy, 0.55 * a);
      case "about": return rgba(p.about, 0.55 * a);
      default: return rgba(p.ink, (dark ? 0.32 : 0.3) * a);
    }
  };
  private linkWidth = (l: GLink) => {
    const d3 = this.settings?.view !== "2d";
    if (this.touchesFocus(l)) return d3 ? 1.2 : 2;
    return d3 ? (l.kind === "tree" ? 0 : 0.5) : (l.kind === "tree" ? 0.6 : 1);
  };
  private particleColor = (l: GLink) => {
    const dark = this.pal.dark;
    if (this.touchesFocus(l)) return dark ? `hsl(${this.hue(this.byId.get(this.focusId!)!)}, 100%, 90%)` : `hsl(${this.hue(this.byId.get(this.focusId!)!)}, 90%, 38%)`;
    return rgba(this.pal.ink, 1);
  };
  private particleWidth = (l: GLink) => (this.touchesFocus(l) ? (this.settings?.view === "2d" ? 3.5 : 3.2) : this.settings?.view === "2d" ? 3 : 2.4);
  private particleSpeed = (l: GLink) => (this.touchesFocus(l) ? 0.0045 : 0.007);
  private label = (n: GNode) => `<div class="bm-tip"><b>${esc(n.title)}</b><span>${esc(n.path)}</span></div>`;
  private visible = (n: GNode) => this.settings.showArchived || !n.archived;

  /** Archived notes drift to an outer shell: long-distance memory. */
  private archiveForce(radius: number) {
    let nodes: any[] = [];
    const f = (alpha: number) => {
      for (const n of nodes) {
        if (!n.archived) continue;
        const r = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) || 1;
        const k = ((radius - r) / r) * alpha * 0.12;
        n.vx += (n.x ?? 0) * k; n.vy += (n.y ?? 0) * k; if (n.z !== undefined) n.vz += n.z * k;
      }
    };
    f.initialize = (ns: any[]) => { nodes = ns; };
    return f;
  }

  // ---------- mount ----------

  mount(s: Settings, pal: Palette) {
    this.settings = s;
    this.pal = pal;
    this.retint();
    for (const f of this.flashes) f.mesh?.removeFromParent();
    this.flashes = [];
    this.arrivals = [];
    this.g?._destructor?.();
    this.el.replaceChildren();
    this.fitted = false;
    this.paused = false;
    this.orbitAt = performance.now() + ORBIT_AFTER_MS;

    if (s.view === "3d") {
      const g = new ForceGraph3D(this.el, { controlType: "orbit" });
      // No node dragging: after a drag the library fakes a touch "pointerup" that crashes OrbitControls
      // (camera resets and the click is lost). Nodes don't need to be dragged here.
      g.enableNodeDrag(false);
      g.backgroundColor(pal.bg).showNavInfo(false)
        .nodeOpacity(1).nodeResolution(16)
        .linkOpacity(0.5);
      g.d3Force("charge").strength(-140).distanceMax(600);
      g.d3Force("link").distance((l: GLink) => (l.kind === "tree" ? 38 : 90)).strength((l: GLink) => (l.kind === "tree" ? 0.7 : 0.04));
      g.d3Force("archive", this.archiveForce(520));
      const c = g.controls();
      c.addEventListener("start", () => { this.orbitAt = Infinity; });
      c.addEventListener("end", () => { this.orbitAt = performance.now() + ORBIT_AFTER_MS; });
      this.g = g;
    } else {
      const g = new ForceGraph(this.el);
      g.enableNodeDrag(false).autoPauseRedraw(false).onRenderFramePost(this.drawFlashes);
      g.backgroundColor(pal.bg).nodeRelSize(4)
        .nodeCanvasObjectMode(() => "after")
        .nodeCanvasObject((n: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
          if (!this.visible(n)) return;
          if (this.labelled.some((x) => x.n === n)) return;
          // While a note is focused only its (capped) overlay labels show, so a busy note doesn't clutter.
          const show = !this.focusId && (n.parent_id === null || (n.kind === "hub" && scale > 1.2) || scale > 3.2);
          if (!show) return;
          const fs = (n.parent_id === null ? 15 : 11) / scale;
          ctx.font = `${n.parent_id === null ? 600 : 400} ${fs}px ${pal.font}`;
          ctx.textAlign = "center";
          ctx.fillStyle = rgba(pal.ink, 0.85 * this.fade(n.id));
          ctx.fillText(n.title, n.x ?? 0, (n.y ?? 0) + Math.sqrt(this.size(n)) * 4 + fs + 1);
        });
      g.d3Force("charge").strength(-90).distanceMax(500);
      g.d3Force("link").distance((l: GLink) => (l.kind === "tree" ? 30 : 80)).strength((l: GLink) => (l.kind === "tree" ? 0.7 : 0.04));
      g.d3Force("archive", this.archiveForce(600));
      this.g = g;
    }

    this.resize();
    this.g
      .nodeId("id").nodeLabel(this.label)
      .nodeVisibility(this.visible)
      .linkVisibility((l: GLink) => {
        const a = typeof l.source === "string" ? this.byId.get(l.source) : l.source;
        const b = typeof l.target === "string" ? this.byId.get(l.target) : l.target;
        return !!a && !!b && this.visible(a) && this.visible(b);
      })
      .onBackgroundClick(() => this.h.onBackgroundClick())
      .onNodeClick((n: GNode) => {
        // Some pointers fire a click twice; a repeat on the same node within 450 ms is the same click.
        const now = performance.now();
        if (this.lastClick.id === n.id && now - this.lastClick.at < 450) return;
        this.lastClick = { id: n.id, at: now };
        this.h.onNodeClick(n);
      })
      .onEngineStop(() => { if (!this.fitted) { this.fitted = true; this.frame(); } })
      // With motion off, settle the layout before the first frame instead of letting it drift into place.
      .warmupTicks(s.animations ? 160 : 300).cooldownTime(s.animations ? 5000 : 0)
      .graphData(this.data);
    this.restyle();
    this.applyControls(s);
    // A rebuild with a layout we already have (view or theme switch): frame it right away.
    if (this.data.nodes.some((n) => n.x !== undefined)) this.later(() => { this.fitted = true; this.frame(); }, 60);
    else this.fitFirst();
  }

  /** A first load: frame the map the moment the layout has its first positions, with no glide. It settles for a few
   *  seconds more; onEngineStop then eases to the final fit. */
  private fitFirst(tries = 120) {
    const step = () => {
      if (this.fitted || !this.g) return;
      if (this.data.nodes.some((n) => n.x !== undefined)) { if (!this.focusId) this.overview(0); return; }
      if (--tries > 0) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  applyControls(s: Settings) {
    this.settings = s;
    if (!this.g) return;
    if (s.view === "3d") {
      const c = this.g.controls();
      c.enableRotate = s.orbit;
      c.enablePan = s.orbit;
      c.enableZoom = s.wheelZoom;
    } else {
      this.g.enableZoomInteraction(s.wheelZoom).enablePanInteraction(s.orbit);
    }
    this.g.nodeVisibility(this.visible);
    this.restyle();
  }

  // ---------- camera ----------

  private ms(n: number) { return this.settings.animations ? n : 0; }

  /**
   * Centre the focused note and pull back just far enough to show its direct connections.
   * The camera looks at the note itself, so the auto-orbit circles it. Moving from one note to another glides.
   */
  frame() {
    if (!this.g) return;
    if (!this.focusId) return this.overview();
    const f = this.byId.get(this.focusId);
    if (!f) return this.overview();
    const d = this.ms(1200);
    const near = [...this.hops].filter(([, h]) => h === 1).map(([id]) => this.byId.get(id)!).filter((n) => n && this.visible(n));
    const fx = f.x ?? 0, fy = f.y ?? 0, fz = f.z ?? 0;
    const R = Math.max(this.radius(f) * 3, ...near.map((n) => Math.hypot((n.x ?? 0) - fx, (n.y ?? 0) - fy, (n.z ?? 0) - fz) + this.radius(n)));
    const w = this.W - this.inset.right, h = this.H - this.inset.bottom;
    if (this.settings.view === "3d") {
      const cam = this.g.camera();
      const half = Math.min((cam.fov * Math.PI) / 360, Math.atan(Math.tan((cam.fov * Math.PI) / 360) * (w / h)));
      const dist = (R / Math.sin(half)) * 1.08;
      // Keep the current viewing direction, just re-aimed at the note.
      let dx = cam.position.x - fx, dy = cam.position.y - fy, dz = cam.position.z - fz;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      this.g.cameraPosition({ x: fx + dx * dist, y: fy + dy * dist, z: fz + dz * dist }, { x: fx, y: fy, z: fz }, d);
    } else {
      this.g.centerAt(fx, fy, d);
      this.g.zoom(Math.max(0.3, Math.min(8, (Math.min(w, h) / 2 - 30) / R)), d);
    }
    this.orbitAt = performance.now() + d + 400;
  }

  /** The whole map, filling the view. In 3D the camera keeps its direction and stands just far enough for the body
   *  of the map (nine notes in ten; a few stragglers may sit at the edge), which reads closer than a strict fit. */
  overview(d = this.ms(1100)) {
    if (!this.g) return;
    const nodes = this.data.nodes.filter((n) => n.x !== undefined && this.visible(n));
    if (this.settings.view === "3d" && nodes.length) {
      const c = [0, 0, 0];
      for (const n of nodes) { c[0] += n.x! / nodes.length; c[1] += n.y! / nodes.length; c[2] += (n.z ?? 0) / nodes.length; }
      const far = nodes.map((n) => Math.hypot(n.x! - c[0], n.y! - c[1], (n.z ?? 0) - c[2]) + this.radius(n)).sort((a, b) => a - b);
      const R = Math.max(40, far[Math.min(far.length - 1, Math.floor(far.length * 0.9))]);
      const w = Math.max(1, this.W - this.inset.right), h = Math.max(1, this.H - this.inset.bottom);
      const cam = this.g.camera();
      const half = Math.min((cam.fov * Math.PI) / 360, Math.atan(Math.tan((cam.fov * Math.PI) / 360) * (w / h)));
      const dist = (R / Math.sin(half)) * FIT;
      let dx = cam.position.x - c[0], dy = cam.position.y - c[1], dz = cam.position.z - c[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      if (len < 1e-3) { dx = 0; dy = 0; dz = 1; }
      this.g.cameraPosition({ x: c[0] + (dx / len) * dist, y: c[1] + (dy / len) * dist, z: c[2] + (dz / len) * dist }, { x: c[0], y: c[1], z: c[2] }, d);
    } else this.g.zoomToFit(d, 28, (n: GNode) => this.visible(n));
    this.orbitAt = Math.max(this.orbitAt === Infinity ? 0 : this.orbitAt, performance.now() + d + 400);
  }

  // ---------- synapses ----------

  /** Fire the nodes at these paths: they flash and particles run along their connections. */
  pulse(paths: string[], label?: string) {
    const now = performance.now();
    const fired: GNode[] = [];
    if (!this.g) return fired;
    for (const p of paths) {
      const n = this.byPath.get(p);
      if (!n) continue;
      fired.push(n);
      if (!this.settings.animations) continue;
      n.__flash = now + 1400;
      const links = this.adj.get(n.id) ?? [];
      // Spread out at random over ~1.5 s rather than all at once.
      for (const l of links.slice(0, 24)) this.later(() => this.fire(l, 0.75), Math.random() * 1500);
    }
    if (fired.length && this.settings.animations) {
      this.g.nodeColor(this.color);
      this.later(() => this.g?.nodeColor(this.color), 1500);
      if (label) this.tag(fired[0], label);
    }
    return fired;
  }

  private tag(n: GNode, text: string) {
    if (this.paused) return;
    const c = this.settings.view === "3d" ? this.g.graph2ScreenCoords(n.x, n.y, n.z) : this.g.graph2ScreenCoords(n.x, n.y);
    if (!c || c.x < 0 || c.y < 0 || c.x > this.W - this.inset.right || c.y > this.H - this.inset.bottom) return;
    const el = document.createElement("div");
    el.className = "bm-pulse-tag";
    el.textContent = text;
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    this.host.append(el);
    this.later(() => el.remove(), 2700);
  }
}
