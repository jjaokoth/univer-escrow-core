declare module "vitest" {
  export function describe(x: string, fn: () => void): void;
  export function it(x: string, fn: () => void | Promise<void>): void;
  export function expect<T>(x: T): {
    toBe(y: T): void;
    toThrow(): { new(): void };
    toBeDefined(): T | undefined;
    rejects: { toThrow(): void };
  };
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}
