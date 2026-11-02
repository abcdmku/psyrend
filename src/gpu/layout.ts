/**
 * Single source of truth for uniform blocks: one field list produces both the
 * WGSL struct text and the float offsets the CPU writes to, so they can't drift.
 */
export type FieldType = 'f32' | 'vec2f' | 'vec4f' | { array: 'vec4f'; length: number };

export interface UniformLayout<K extends string> {
  /** Size in bytes, padded to 16. */
  size: number;
  /** Offsets in floats. */
  offset: Record<K, number>;
  wgsl(structName: string): string;
}

const sizeOf = (t: FieldType) => (typeof t === 'string' ? { f32: 4, vec2f: 8, vec4f: 16 }[t] : 16 * t.length);
const alignOf = (t: FieldType) => (typeof t === 'string' ? { f32: 4, vec2f: 8, vec4f: 16 }[t] : 16);
const typeName = (t: FieldType) => (typeof t === 'string' ? t : `array<${t.array}, ${t.length}>`);

export function defineLayout<const F extends readonly (readonly [string, FieldType])[]>(fields: F): UniformLayout<F[number][0]> {
  let at = 0;
  const offset: Record<string, number> = {};
  for (const [name, type] of fields) {
    const a = alignOf(type);
    at = Math.ceil(at / a) * a;
    offset[name] = at / 4;
    at += sizeOf(type);
  }
  const size = Math.ceil(at / 16) * 16;
  return {
    size,
    offset: offset as Record<F[number][0], number>,
    wgsl: (structName) => `struct ${structName} {\n${fields.map(([n, t]) => `  ${n}: ${typeName(t)},`).join('\n')}\n};\n`,
  };
}
