import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODE_SCHEMA_VERSION,
  RUNTIME_MODE_STATE_KEY,
  RuntimeModeStore,
  normalizePersistedRuntimeMode,
  normalizeRuntimeMode,
} from "../src/runtime-mode.js";

class MemoryMemento {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test("runtime mode normalization is strict and keeps unrelated surface values out", () => {
  assert.equal(DEFAULT_RUNTIME_MODE, "single");
  assert.equal(normalizeRuntimeMode("single"), "single");
  assert.equal(normalizeRuntimeMode("collaboration"), "collaboration");
  assert.equal(normalizeRuntimeMode("local"), undefined);
  assert.equal(normalizeRuntimeMode("remote"), undefined);
  assert.equal(normalizeRuntimeMode("public-orchestration"), undefined);
  assert.equal(normalizeRuntimeMode({ mode: "single" }), undefined);
});

test("fresh extension state stays unset so existing private config can remain authoritative", async () => {
  const memento = new MemoryMemento();
  const store = new RuntimeModeStore(memento);
  assert.equal(DEFAULT_RUNTIME_MODE, "single");
  assert.equal(store.load(), undefined);
  assert.equal(await store.migrate(), undefined);
  assert.equal(store.load(), undefined);
  assert.equal(memento.get(RUNTIME_MODE_STATE_KEY), undefined);
});

test("the selected advanced workflow remains durable", async () => {
  const memento = new MemoryMemento();
  const store = new RuntimeModeStore(memento);
  await store.set("collaboration");
  assert.equal(store.load(), "collaboration");
  assert.equal(await store.migrate(), "collaboration");

  memento.values.set(RUNTIME_MODE_STATE_KEY, { schemaVersion: 99, mode: "collaboration", updatedAt: new Date().toISOString() });
  assert.equal(store.load(), undefined);
});

test("compatible pre-release runtime state migrates without accepting old UI surface state", async () => {
  const memento = new MemoryMemento();
  memento.values.set("vspilink.operationMode", { mode: "collaboration" });
  const store = new RuntimeModeStore(memento);
  assert.equal(store.load(), "collaboration");
  assert.equal(await store.migrate(), "collaboration");
  assert.equal(store.load(), "collaboration");

  const surfaceMemento = new MemoryMemento();
  surfaceMemento.values.set("vspilink.operationMode", "local");
  const surfaceStore = new RuntimeModeStore(surfaceMemento);
  assert.equal(surfaceStore.load(), undefined);
  assert.equal(await surfaceStore.migrate(), undefined);
  assert.equal(surfaceStore.load(), undefined);
});

test("persisted runtime mode rejects malformed or secret-bearing values", () => {
  const sanitized = normalizePersistedRuntimeMode({
    schemaVersion: 1,
    mode: "single",
    updatedAt: "2026-08-14T00:00:00.000Z",
    secret: "must not cross",
  });
  assert.deepEqual(sanitized, {
    schemaVersion: 1,
    mode: "single",
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(normalizePersistedRuntimeMode({
    schemaVersion: 1,
    mode: "collaboration",
    updatedAt: "bad\nvalue",
  }), undefined);
  assert.equal(normalizePersistedRuntimeMode({
    schemaVersion: 1,
    mode: "single",
    updatedAt: "2026-08-14T00:00:00.000Z",
  })?.mode, "single");
});
