import { closeSync, openSync, renameSync, rmSync, writeSync } from "fs";

// Write `value` to `path` as JSON, byte for byte what `JSON.stringify(value, replacer)` returns,
// without ever holding the whole text in one string. An AST is about 80 times the size of its
// source in JSON, so the AST of a 10 MB minified bundle is longer than V8's largest string, and on
// a small heap the attempt to build that string runs out of memory before it can fail. The text
// is written in chunks to a temporary file next to `path` and renamed into place, so a failure
// leaves no partial file and keeps any earlier one.
//
// The walk follows JSON.stringify's order exactly (`toJSON`, then the replacer with the holder as
// `this`, then the own enumerable keys, read lazily), so a replacer that remembers what it saw,
// as astgen's does, drops the same values. It uses an explicit stack, so a deep AST cannot
// overflow the call stack.

const CHUNK_CHARS = 1 << 20;

const unbox = (value) => {
  if (value instanceof Number) return Number(value);
  if (value instanceof String) return String(value);
  if (value instanceof Boolean) return value.valueOf();
  return value;
};

// The value as JSON.stringify would see it: a `{ text }` for a primitive, a `{ container }` for
// an object or array, undefined when the value is left out.
const prepare = (holder, key, value, replacer) => {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "bigint") &&
    typeof value.toJSON === "function"
  ) {
    value = value.toJSON(key);
  }
  if (replacer) {
    value = replacer.call(holder, key, value);
  }
  if (typeof value === "object" && value !== null) {
    value = unbox(value);
  }
  if (value === null) return { text: "null" };
  switch (typeof value) {
    case "string":
      return { text: JSON.stringify(value) };
    case "number":
      return { text: Number.isFinite(value) ? String(value) : "null" };
    case "boolean":
      return { text: value ? "true" : "false" };
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      return { container: value };
    default:
      return undefined;
  }
};

export function writeJsonStream(path, value, replacer) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  let buffer = "";
  const emit = (text) => {
    buffer += text;
    if (buffer.length >= CHUNK_CHARS) {
      writeSync(fd, buffer);
      buffer = "";
    }
  };
  const inProgress = new Set();
  const stack = [];
  const open = (container) => {
    if (inProgress.has(container)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    inProgress.add(container);
    if (Array.isArray(container)) {
      stack.push({ array: container, index: 0 });
      emit("[");
    } else {
      stack.push({ object: container, keys: Object.keys(container), index: 0, wrote: false });
      emit("{");
    }
  };
  try {
    const root = prepare({ "": value }, "", value, replacer);
    if (root === undefined) {
      throw new TypeError("The value has no JSON form");
    }
    if (root.text !== undefined) {
      emit(root.text);
    } else {
      open(root.container);
    }
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.array) {
        const array = frame.array;
        if (frame.index >= array.length) {
          emit("]");
          inProgress.delete(array);
          stack.pop();
          continue;
        }
        const index = frame.index++;
        if (index > 0) emit(",");
        const item = prepare(array, String(index), array[index], replacer);
        if (item === undefined) {
          emit("null");
        } else if (item.text !== undefined) {
          emit(item.text);
        } else {
          open(item.container);
        }
      } else {
        const object = frame.object;
        if (frame.index >= frame.keys.length) {
          emit("}");
          inProgress.delete(object);
          stack.pop();
          continue;
        }
        const key = frame.keys[frame.index++];
        const item = prepare(object, key, object[key], replacer);
        if (item === undefined) {
          continue;
        }
        emit(`${frame.wrote ? "," : ""}${JSON.stringify(key)}:`);
        frame.wrote = true;
        if (item.text !== undefined) {
          emit(item.text);
        } else {
          open(item.container);
        }
      }
    }
    if (buffer.length > 0) {
      writeSync(fd, buffer);
    }
    closeSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, path);
}
