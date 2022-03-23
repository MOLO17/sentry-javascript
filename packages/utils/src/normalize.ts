import { Primitive } from '@sentry/types';

import { isNaN, isSyntheticEvent } from './is';
import { memoBuilder, MemoFunc } from './memo';
import { convertToPlainObject } from './object';
import { getFunctionName } from './stacktrace';

type Prototype = { constructor: (...args: unknown[]) => unknown };

/**
 * Recursively normalizes the given object.
 *
 * - Creates a copy to prevent original input mutation
 * - Skips non-enumerable properties
 * - When stringifying, calls `toJSON` if implemented
 * - Removes circular references
 * - Translates non-serializable values (`undefined`/`NaN`/functions) to serializable format
 * - Translates known global objects/classes to a string representations
 * - Takes care of `Error` object serialization
 * - Optionally limits depth of final output
 * - Optionally limits number of properties/elements included in any single object/array
 *
 * @param input The object to be normalized.
 * @param depth The max depth to which to normalize the object. (Anything deeper stringified whole.)
 * @param maxProperties The max number of elements or properties to be included in any single array or
 * object in the normallized output..
 * @returns A normalized version of the object, or `"**non-serializable**"` if any errors are thrown during normalization.
 */
export function normalize(input: unknown, depth: number = +Infinity, maxProperties: number = +Infinity): unknown {
  try {
    // since we're at the outermost level, there is no key
    return visit('', input, depth, maxProperties);
  } catch (err) {
    return { ERROR: `**non-serializable** (${err})` };
  }
}

/** JSDoc */
export function normalizeToSize<T>(
  object: { [key: string]: unknown },
  // Default Node.js REPL depth
  depth: number = 3,
  // 100kB, as 200kB is max payload size, so half sounds reasonable
  maxSize: number = 100 * 1024,
): T {
  const serialized = normalize(object, depth);

  if (jsonSize(serialized) > maxSize) {
    return normalizeToSize(object, depth - 1, maxSize);
  }

  return serialized as T;
}

/**
 * Visits a node to perform a normalization on it
 *
 * @param key The key corresponding to the given node
 * @param value The node to be visited
 * @param depth Optional number indicating how deep should walking be performed
 * @param maxProperties Optional maximum number of properties/elements included in any single object/array
 * @param memo Optional Memo class handling decycling
 */
export function visit(
  key: string,
  value: unknown,
  depth: number = +Infinity,
  maxProperties: number = +Infinity,
  memo: MemoFunc = memoBuilder(),
): Primitive | { [key: string]: unknown } {
  const [memoize, unmemoize] = memo;

  // if the value has a `toJSON` method, bail and let it do the work
  const valueWithToJSON = value as unknown & { toJSON?: () => string };
  if (valueWithToJSON && typeof valueWithToJSON.toJSON === 'function') {
    try {
      return valueWithToJSON.toJSON();
    } catch (err) {
      return `**non-serializable** (${err})`;
    }
  }

  // get the simple cases out of the way first
  if (value === null || (['number', 'boolean', 'string'].includes(typeof value) && !isNaN(value))) {
    return value as Primitive;
  }

  const stringified = stringifyValue(key, value);

  // Anything we could potentially dig into more (objects or arrays) will have come back as `"[object XXXX]"`.
  // Everything else will have already been serialized, so if we don't see that pattern, we're done.
  if (!stringified.startsWith('[object ')) {
    return stringified;
  }

  // we're also done if we've reached the max depth
  if (depth === 0) {
    // At this point we know `serialized` is a string of the form `"[object XXXX]"`. Clean it up so it's just `"[XXXX]"`.
    return stringified.replace('object ', '');
  }

  // Create source that we will use for the next iteration. Because not all of the properties we care about on `Error`
  // and `Event` instances are ennumerable, we first convert those to plain objects. (`convertToPlainObject` is a
  // pass-through for everything else.)
  const source = convertToPlainObject(value);

  // Create an accumulator that will act as a parent for all future iterations of this branch, and keep track of the
  // number of properties/entries we add to it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc: { [key: string]: any } = Array.isArray(value) ? [] : {};
  let numAdded = 0;

  // If we've already visited this branch, bail out, as it's circular reference
  if (memoize(value)) {
    return '[Circular ~]';
  }

  // visit all keys of the source
  for (const innerKey in source) {
    // Avoid iterating over fields in the prototype if they've somehow been exposed to enumeration.
    if (!Object.prototype.hasOwnProperty.call(source, innerKey)) {
      continue;
    }

    if (numAdded >= maxProperties) {
      acc[innerKey] = '[MaxProperties ~]';
      break;
    }

    // Recursively visit all the child nodes
    const innerValue: unknown = source[innerKey];
    acc[innerKey] = visit(innerKey, innerValue, depth - 1, maxProperties, memo);

    numAdded += 1;
  }

  // Once we've visited all the branches, remove the parent from memo storage
  unmemoize(value);

  // Return accumulated values
  return acc;
}

// TODO remove this in v7 (we don't use it anywhere, but it's a public method)
export { visit as walk };

/**
 * Stringify the given value. Handles various known special values and types.
 *
 * Not meant to be used on simple primitives which already have a string representation, as it will, for example, turn
 * the number 1231 into "[Object Number]", nor on `null`, as it will throw.
 *
 * @param value The value to stringify
 * @returns A stringified representation of the given value
 */
function stringifyValue(
  key: unknown,
  // this type is a tiny bit of a cheat, since this function does handle NaN (which is technically a number), but for
  // our internal use, it'll do
  value: Exclude<unknown, string | number | boolean | null>,
): string {
  try {
    if (key === 'domain' && value && typeof value === 'object' && (value as { _events: unknown })._events) {
      return '[Domain]';
    }

    if (key === 'domainEmitter') {
      return '[DomainEmitter]';
    }

    // It's safe to use `global`, `window`, and `document` here in this manner, as we are asserting using `typeof` first
    // which won't throw if they are not present.

    if (typeof global !== 'undefined' && value === global) {
      return '[Global]';
    }

    // eslint-disable-next-line no-restricted-globals
    if (typeof window !== 'undefined' && value === window) {
      return '[Window]';
    }

    // eslint-disable-next-line no-restricted-globals
    if (typeof document !== 'undefined' && value === document) {
      return '[Document]';
    }

    // React's SyntheticEvent thingy
    if (isSyntheticEvent(value)) {
      return '[SyntheticEvent]';
    }

    if (typeof value === 'number' && value !== value) {
      return '[NaN]';
    }

    // this catches `undefined` (but not `null`, which is a primitive and can be serialized on its own)
    if (value === void 0) {
      return '[undefined]';
    }

    if (typeof value === 'function') {
      return `[Function: ${getFunctionName(value)}]`;
    }

    if (typeof value === 'symbol') {
      return `[${String(value)}]`;
    }

    // stringified BigInts are indistinguishable from regular numbers, so we need to label them to avoid confusion
    if (typeof value === 'bigint') {
      return `[BigInt: ${String(value)}]`;
    }

    // Now that we've knocked out all the special cases and the primitives, all we have left are objects. Simply casting
    // them to strings means that instances of classes which haven't defined their `toStringTag` will just come out as
    // `"[object Object]"`. If we instead look at the constructor's name (which is the same as the name of the class),
    // we can make sure that only plain objects come out that way.
    return `[object ${(Object.getPrototypeOf(value) as Prototype).constructor.name}]`;
  } catch (err) {
    return `**non-serializable** (${err})`;
  }
}

/** Calculates bytes size of input string */
function utf8Length(value: string): number {
  // eslint-disable-next-line no-bitwise
  return ~-encodeURI(value).split(/%..|./).length;
}

/** Calculates bytes size of input object */
function jsonSize(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}
