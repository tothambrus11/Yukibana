/**
 * Formats a value the way Node's `util.inspect` does for assertion messages
 * (`compact: false, sorted: true`): one property or element per line, keys
 * sorted, strings in single quotes. Two values whose texts differ show where
 * they differ, which is what `node:assert`'s diffs are made of. Not a full
 * `util.inspect`: no getters, symbols as keys, typed arrays or class
 * private fields.
 */
export function inspect(value: unknown, indent = '', seen: Set<object> = new Set()): string {
	switch (typeof value) {
		case 'string':
			return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
		case 'bigint':
			return `${value}n`;
		case 'number':
			return Object.is(value, -0) ? '-0' : String(value);
		case 'function':
			return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
		case 'symbol':
		case 'boolean':
		case 'undefined':
			return String(value);
	}
	if (value === null) return 'null';
	const object = value as object;
	if (seen.has(object)) return '[Circular *1]';
	if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
	if (object instanceof RegExp) return String(object);
	if (object instanceof Error) return `[${object.name}: ${object.message}]`;
	if (object instanceof Promise) return 'Promise { <unknown> }';
	seen.add(object);
	const inner = indent + '  ';
	const wrap = (open: string, close: string, items: string[]) =>
		items.length === 0 ? `${open}${close}` : `${open}\n${items.map((i) => inner + i).join(',\n')}\n${indent}${close}`;
	try {
		if (Array.isArray(object)) return wrap('[', ']', object.map((x: unknown) => inspect(x, inner, seen)));
		if (object instanceof Map) return wrap(`Map(${object.size}) {`, '}', [...object].map(([k, x]) => `${inspect(k, inner, seen)} => ${inspect(x, inner, seen)}`));
		if (object instanceof Set) return wrap(`Set(${object.size}) {`, '}', [...object].map((x) => inspect(x, inner, seen)));
		const proto: unknown = Object.getPrototypeOf(object);
		const ctor = proto && typeof proto === 'object' && 'constructor' in proto ? (proto.constructor as { name?: string } | undefined) : undefined;
		const name = proto === null ? '[Object: null prototype] ' : proto !== Object.prototype && ctor?.name ? `${ctor.name} ` : '';
		const keys = Object.keys(object).sort();
		const record = object as Record<string, unknown>;
		return name + wrap('{', '}', keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : inspect(k)}: ${inspect(record[k], inner, seen)}`));
	} finally {
		seen.delete(object);
	}
}
