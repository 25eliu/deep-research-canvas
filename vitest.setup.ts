// jsdom has no ResizeObserver. Recharts' ResponsiveContainer and NodeCard's
// height reporting only need the constructor to exist — observations never fire
// in tests (chart tests pass explicit width/height instead).
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
