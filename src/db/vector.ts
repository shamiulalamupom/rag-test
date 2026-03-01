export function toPgVectorLiteral(vec: number[]): string {
  if (vec.length === 0) throw new Error("Empty embedding");
  for (const n of vec) {
    if (!Number.isFinite(n))
      throw new Error("Embedding contains non-finite value");
  }
  return `[${vec.join(",")}]`;
}
