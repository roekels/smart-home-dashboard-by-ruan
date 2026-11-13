// Types for /vendor/brain-map.js (built from source/ by the UI build). Kept loose on purpose:
// the graph libraries are chainable "kapsule" objects, and the map only uses a handful of three.js classes.
/* eslint-disable @typescript-eslint/no-explicit-any */
export declare const ForceGraph3D: any;
export declare const ForceGraph: any;
export declare class Vector3 { x: number; y: number; z: number; constructor(x?: number, y?: number, z?: number); copy(v: Vector3): this; applyQuaternion(q: unknown): this; multiplyScalar(s: number): this }
export declare class Color { constructor(c?: string) }
export declare class SphereGeometry { constructor(r?: number, w?: number, h?: number) }
export declare class MeshBasicMaterial { constructor(o?: Record<string, unknown>); opacity: number; dispose(): void }
export declare class Mesh { constructor(g: SphereGeometry, m: MeshBasicMaterial); material: MeshBasicMaterial; renderOrder: number; position: Vector3 & { set(x: number, y: number, z: number): void }; scale: { setScalar(s: number): void }; removeFromParent(): void }
export declare const AdditiveBlending: number;
export declare const NormalBlending: number;
export declare const marked: { parse(md: string, o?: { async?: boolean }): string | Promise<string> };
export declare const DOMPurify: { sanitize(html: string, o?: Record<string, unknown>): string };
