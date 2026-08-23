export interface ProvenanceDependencyEdge {
  readonly inputResultId: string;
  readonly outputResultId: string;
}

/**
 * Returns only results reachable from the exact changed result identities.
 * Historical processor-definition graphs are intentionally not consulted.
 */
export function downstreamResultIds(
  changedResultIds: readonly string[],
  edges: readonly ProvenanceDependencyEdge[],
): readonly string[] {
  const downstream = new Map<string, string[]>();
  for (const edge of edges) {
    const outputs = downstream.get(edge.inputResultId) ?? [];
    outputs.push(edge.outputResultId);
    downstream.set(edge.inputResultId, outputs);
  }
  const visited = new Set<string>();
  const pending = [...new Set(changedResultIds)].sort();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const output of [...(downstream.get(current) ?? [])].sort()) {
      if (visited.has(output)) continue;
      visited.add(output);
      pending.push(output);
    }
  }
  return Object.freeze([...visited].sort());
}
