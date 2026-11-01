import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { InvalidRequestError, UnsupportedFeatureError } from "./errors.js";
import type { SessionTool } from "./contracts.js";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const MAX_CATALOG_TOOLS = 128;
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CATALOG_NODES = 10_000;
const MAX_CATALOG_DEPTH = 64;

const KNOWN_2020_12_KEYWORDS = new Set([
  "$schema", "$id", "$vocabulary", "$anchor", "$dynamicAnchor", "$ref", "$dynamicRef", "$defs", "$comment",
  "prefixItems", "items", "contains", "additionalProperties", "properties", "patternProperties",
  "dependentSchemas", "propertyNames", "if", "then", "else", "allOf", "anyOf", "oneOf", "not",
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "maxContains", "minContains",
  "maxProperties", "minProperties", "required", "dependentRequired", "unevaluatedItems", "unevaluatedProperties",
  "title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples", "format",
  "contentEncoding", "contentMediaType", "contentSchema",
]);

const UNSUPPORTED_2020_12_KEYWORDS = new Set([
  // Arbitrary regexps can have unbounded backtracking time. Formats are an
  // optional assertion vocabulary in Draft 2020-12, so treating them as
  // annotations here could silently weaken schemas that expect assertions.
  "pattern", "patternProperties", "format",
  // Only local JSON Pointer references are supported. Resource and dynamic
  // references introduce a different resolution context.
  "$id", "$vocabulary", "$anchor", "$dynamicAnchor", "$dynamicRef",
]);

const SAME_INSTANCE_SCHEMA_KEYS = new Set([
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas",
]);
const SINGLE_SCHEMA_KEYS = new Set([
  "additionalProperties", "contains", "items", "propertyNames", "unevaluatedItems", "unevaluatedProperties",
]);
const SCHEMA_MAP_KEYS = new Set(["$defs", "properties", "dependentSchemas"]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf"]);

export interface CompiledCallerTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly validate: ValidateFunction;
}

export interface CompiledCallerToolCatalog {
  readonly id: string;
  readonly tools: readonly CompiledCallerTool[];
}

function invalidCatalog(): InvalidRequestError {
  return new InvalidRequestError("The session caller-tool catalog is invalid.");
}

function unsupportedCatalog(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    "The session caller-tool catalog uses an unsupported MCP tool or JSON Schema feature.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw invalidCatalog();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
          throw invalidCatalog();
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidCatalog();
        copy.push(cloneJsonValue(descriptor.value, ancestors));
      }
      return copy;
    }
    if (!isRecord(value)) throw invalidCatalog();
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidCatalog();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidCatalog();
      Object.defineProperty(copy, key, {
        value: cloneJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  return cloneJsonValue(value, new Set()) as T;
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeJson(descriptor.value);
  }
  return Object.freeze(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function checkJsonBounds(value: unknown, maxBytes: number, maxNodes: number, maxDepth: number): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) throw invalidCatalog();
    if (typeof current.value === "object" && current.value !== null) {
      for (const key of Reflect.ownKeys(current.value)) {
        if (key === "length") continue;
        if (typeof key !== "string") throw invalidCatalog();
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor)) throw invalidCatalog();
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidCatalog();
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw invalidCatalog();
  }
}

/** Ajv deliberately omits `__proto__` from schema property maps; reject it
 * everywhere in a schema tree rather than compiling a weaker contract. */
function rejectPrototypeKeys(schema: unknown): void {
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) {
      if (key === "__proto__") throw unsupportedCatalog();
      pending.push(value[key]);
    }
  }
}

function schemaChildren(schema: Record<string, unknown>, sameInstanceOnly: boolean): unknown[] {
  const children: unknown[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (SINGLE_SCHEMA_KEYS.has(key)) {
      if (!sameInstanceOnly && (typeof value === "boolean" || isRecord(value))) children.push(value);
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (!isRecord(value)) continue;
      for (const child of Object.values(value)) {
        if (
          (typeof child === "boolean" || isRecord(child)) &&
          (!sameInstanceOnly || key === "dependentSchemas")
        ) children.push(child);
      }
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value)) continue;
      for (const child of value) {
        if (typeof child === "boolean" || isRecord(child)) children.push(child);
      }
      continue;
    }
    if (key === "prefixItems" && !sameInstanceOnly) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (typeof child === "boolean" || isRecord(child)) children.push(child);
        }
      }
      continue;
    }
    if (SAME_INSTANCE_SCHEMA_KEYS.has(key) && !SCHEMA_ARRAY_KEYS.has(key) && key !== "dependentSchemas") {
      if (isRecord(value) || typeof value === "boolean") children.push(value);
    }
  }
  return children;
}

function resolveLocalPointer(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) throw unsupportedCatalog();
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw invalidCatalog();
  }
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(raw)) throw invalidCatalog();
    const part = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (typeof current !== "object" || current === null || !hasOwn(current, part)) {
      throw invalidCatalog();
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function schemaGraph(root: unknown): void {
  const nodes = new Set<object>();
  const schemaValues: object[] = [];
  const sameInstanceEdges = new Map<object, Set<object>>();
  const unresolvedReferences: Array<{ readonly from: object; readonly reference: string }> = [];
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "boolean") continue;
    if (!isRecord(value)) throw invalidCatalog();
    if (nodes.has(value)) continue;
    nodes.add(value);
    schemaValues.push(value);
    if (nodes.size > MAX_CATALOG_NODES) throw invalidCatalog();
    const children = schemaChildren(value, false);
    const sameInstance = schemaChildren(value, true);
    sameInstanceEdges.set(value, new Set(sameInstance.filter(isRecord)));

    for (const [key, keywordValue] of Object.entries(value)) {
      if (!KNOWN_2020_12_KEYWORDS.has(key)) throw unsupportedCatalog();
      if (UNSUPPORTED_2020_12_KEYWORDS.has(key)) throw unsupportedCatalog();
      if (key === "$schema" && (value !== root || keywordValue !== JSON_SCHEMA_2020_12)) {
        throw unsupportedCatalog();
      }
      if (key === "$ref") {
        if (typeof keywordValue !== "string") throw invalidCatalog();
        if (!keywordValue.startsWith("#/") && keywordValue !== "#") throw unsupportedCatalog();
        unresolvedReferences.push({ from: value, reference: keywordValue });
      }
    }
    pending.push(...children);
  }

  for (const { from, reference } of unresolvedReferences) {
    const target = resolveLocalPointer(root, reference);
    if (typeof target === "boolean") continue;
    if (!isRecord(target) || !nodes.has(target)) throw invalidCatalog();
    const edges = sameInstanceEdges.get(from) ?? new Set<object>();
    edges.add(target);
    sameInstanceEdges.set(from, edges);
  }

  // Recursive schemas that can re-enter the same instance (e.g. `$ref: "#"`
  // or a self-referential `allOf`) can recurse forever in a synchronous
  // validator. Recursive references through properties/items are productive
  // and bounded by the call-input depth cap.
  const state = new Map<object, 1 | 2>();
  for (const rootNode of schemaValues) {
    if (state.get(rootNode) === 2) continue;
    const pending: Array<{ readonly node: object; readonly exit: boolean }> = [{ node: rootNode, exit: false }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.exit) {
        state.set(current.node, 2);
        continue;
      }
      const currentState = state.get(current.node);
      if (currentState === 1) throw unsupportedCatalog();
      if (currentState === 2) continue;
      state.set(current.node, 1);
      pending.push({ node: current.node, exit: true });
      for (const child of sameInstanceEdges.get(current.node) ?? []) {
        const childState = state.get(child);
        if (childState === 1) throw unsupportedCatalog();
        if (childState !== 2) pending.push({ node: child, exit: false });
      }
    }
  }

}

/**
 * Compile the immutable caller tool catalog using JSON Schema Draft 2020-12.
 * The root must be an object schema. Ajv strict mode rejects unknown dialect
 * keywords; this adapter additionally rejects regex/format/resource features
 * that cannot be given a bounded, local-only interpretation.
 */
export function compileCallerToolCatalog(input: readonly SessionTool[] | undefined): CompiledCallerToolCatalog {
  const source = input ?? [];
  if (!Array.isArray(source) || source.length > MAX_CATALOG_TOOLS) throw invalidCatalog();
  const copied = cloneJson(source);
  checkJsonBounds(copied, MAX_CATALOG_BYTES, MAX_CATALOG_NODES, MAX_CATALOG_DEPTH);

  const names = new Set<string>();
  const validator = new Ajv2020({
    allErrors: false,
    strict: true,
    strictNumbers: true,
    validateFormats: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    ownProperties: true,
    messages: false,
  });
  const tools: CompiledCallerTool[] = [];
  for (const item of copied) {
    if (!isRecord(item)) throw invalidCatalog();
    const allowedKeys = new Set(["name", "description", "input_schema", "type"]);
    if (Object.keys(item).some((key) => !allowedKeys.has(key))) throw unsupportedCatalog();
    if (
      typeof item.name !== "string" || item.name.length === 0 ||
      Buffer.byteLength(item.name, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(item.name) ||
      names.has(item.name)
    ) throw invalidCatalog();
    if (hasOwn(item, "description") && typeof item.description !== "string") throw invalidCatalog();
    if (hasOwn(item, "type") && item.type !== "custom" && item.type !== null) throw unsupportedCatalog();
    names.add(item.name);

    const schemaInput = item.input_schema;
    if (!isRecord(schemaInput) || schemaInput.type !== "object") throw invalidCatalog();
    // Catalog schemas all share one Ajv instance so `$ref` stays rooted in the
    // individual schema and no catalog definition can resolve into another.
    const normalizedSchema = cloneJson(schemaInput) as Record<string, unknown>;
    checkJsonBounds(normalizedSchema, MAX_CATALOG_BYTES, MAX_CATALOG_NODES, MAX_CATALOG_DEPTH);
    rejectPrototypeKeys(normalizedSchema);
    schemaGraph(normalizedSchema);
    let validate: ValidateFunction;
    try {
      validate = validator.compile(normalizedSchema);
    } catch {
      throw invalidCatalog();
    }
    const frozenSchema = freezeJson(normalizedSchema);
    const entry: {
      name: string;
      inputSchema: Readonly<Record<string, unknown>>;
      validate: ValidateFunction;
      description?: string;
    } = { name: item.name, inputSchema: frozenSchema, validate };
    if (typeof item.description === "string") entry.description = item.description;
    tools.push(Object.freeze(entry));
  }

  const frozenTools = Object.freeze(tools);
  let canonical: string;
  try {
    canonical = stableJson(copied);
  } catch {
    throw invalidCatalog();
  }
  const id = `sha256-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  return Object.freeze({ id, tools: frozenTools });
}

/** Validate caller-supplied JSON values without coercion or removal. */
export function validateCallerToolArguments(tool: CompiledCallerTool, value: unknown): boolean {
  return tool.validate(value) as boolean;
}

/** Deep copy and freeze parsed JSON before placing it on the S8 handoff seam. */
export function copyToolCallArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw invalidCatalog();
  checkJsonBounds(value, 1024 * 1024, 100_000, 64);
  return freezeJson(cloneJson(value));
}

/** Safe JSON copy for bounded MCP handler results and protocol values. */
export function copyToolJson(value: unknown, maxBytes: number, maxDepth = 64): unknown {
  checkJsonBounds(value, maxBytes, 100_000, maxDepth);
  const copy = cloneJson(value);
  return copy;
}
