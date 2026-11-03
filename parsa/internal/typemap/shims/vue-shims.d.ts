
declare function defineProps<T = any>(): T;
declare function defineEmits<T = any>(): T;
declare function defineExpose<T = any>(value?: T): void;
declare function defineSlots<T = any>(): T;
declare function defineModel<T = any>(
  options?: { required?: boolean; default?: T }
): import("vue").Ref<T>;
declare function defineModel<T = any>(
  name: string,
  options?: { required?: boolean; default?: T }
): import("vue").Ref<T>;
declare function withDefaults<T, D>(props: T, defaults: D): T & D;

declare module "vue" {
  export type Ref<T = any> = { value: T };
  export type ComputedRef<T = any> = { readonly value: T };
  export type InjectionKey<T> = symbol & { __type?: T };
  export function ref<T>(value: T): Ref<T>;
  export function ref<T = any>(): Ref<T | undefined>;
  export function shallowRef<T>(value: T): Ref<T>;
  export function computed<T>(getter: () => T): ComputedRef<T>;
  export function inject<T>(key: any, defaultValue?: T): T;
  export function provide<T>(key: any, value: T): void;
  export function watch(...args: any[]): void;
  export function watchEffect(effect: () => void): void;
  export function onMounted(cb: () => void): void;
  export function onUnmounted(cb: () => void): void;
}
