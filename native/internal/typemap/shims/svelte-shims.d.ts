
declare function $state<T>(initial?: T): T;
declare namespace $state { function raw<T>(initial?: T): T; function snapshot<T>(v: T): T; }
declare function $derived<T>(expression: T): T;
declare namespace $derived { function by<T>(fn: () => T): T; }
declare function $effect(fn: () => void | (() => void)): void;
declare namespace $effect {
  function pre(fn: () => void | (() => void)): void;
  function tracking(): boolean;
  function root(fn: () => void | (() => void)): () => void;
  function pending(): number;
}
declare function $props<T = any>(): T;
declare namespace $props { function id(): string; }
declare function $bindable<T>(fallback?: T): T;
declare function $inspect<T extends any[]>(...values: T): { with: (fn: (...args: any[]) => void) => void };
declare function $host<T = HTMLElement>(): T;

declare module "svelte" {
  export function onMount(fn: () => void | (() => void)): void;
  export function onDestroy(fn: () => void): void;
  export function tick(): Promise<void>;
  export function untrack<T>(fn: () => T): T;
  export function getContext<T>(key: any): T;
  export function setContext<T>(key: any, value: T): T;
  export function hasContext(key: any): boolean;
  export function createEventDispatcher<T = any>(): (type: string, detail?: any) => void;
  export function mount(component: any, options: any): any;
  export function unmount(component: any): Promise<void>;
  export type Component<P = any> = (...args: any[]) => any;
  export type Snippet<P extends any[] = any[]> = (...args: P) => any;
}
declare module "svelte/store" {
  export type Readable<T> = { subscribe(run: (value: T) => void): () => void };
  export type Writable<T> = Readable<T> & { set(value: T): void; update(fn: (value: T) => T): void };
  export function writable<T>(value?: T): Writable<T>;
  export function readable<T>(value?: T): Readable<T>;
  export function derived<T>(stores: any, fn: any, initial?: T): Readable<T>;
  export function get<T>(store: Readable<T>): T;
}
