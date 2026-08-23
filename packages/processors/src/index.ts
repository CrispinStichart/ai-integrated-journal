import type {
  ProcessorDefinitionDraft,
  ProcessorValidationIssue,
} from '@journal/contracts';

export * from './runtime.js';
export * from './provenance.js';

/** Identifies the owning workspace package without exposing implementation paths. */
export const processorsPackageName = '@journal/processors' as const;

export const PROCESSOR_SCHEMA_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 128,
  maxPropertiesPerObject: 64,
  maxEnumValues: 64,
  maxPatternLength: 256,
  maxBytes: 65_536,
});

export const UNTRUSTED_JOURNAL_INPUT_POLICY = Object.freeze({
  journalContentRole: 'untrusted_data',
  generatedOutputRole: 'validated_data',
  executableChannels: [] as readonly never[],
});

const allowedSchemaKeywords = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'allOf',
]);
const allowedSchemaTypes = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

export interface ProcessorSchemaComplexity {
  readonly depth: number;
  readonly nodes: number;
}

export interface PublishedProcessorVersion {
  readonly id: string;
  readonly processorId: string;
  readonly definition: ProcessorDefinitionDraft;
}

export interface ProcessorDefinitionValidation {
  readonly valid: boolean;
  readonly issues: readonly ProcessorValidationIssue[];
  readonly schemaComplexity: ProcessorSchemaComplexity;
}

function issue(
  path: string,
  code: string,
  message: string,
): ProcessorValidationIssue {
  return { path, code, message };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inspectSchema(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number; depth: number; issues: ProcessorValidationIssue[] },
): void {
  state.nodes += 1;
  state.depth = Math.max(state.depth, depth);
  if (
    state.nodes > PROCESSOR_SCHEMA_LIMITS.maxNodes ||
    depth > PROCESSOR_SCHEMA_LIMITS.maxDepth
  )
    return;
  const schema = objectValue(value);
  if (schema === undefined) {
    state.issues.push(
      issue(
        path,
        'schema_node_invalid',
        'Every schema node must be an object.',
      ),
    );
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!allowedSchemaKeywords.has(keyword)) {
      state.issues.push(
        issue(
          `${path}/${keyword}`,
          'schema_keyword_unsupported',
          `JSON Schema keyword ${keyword} is not supported.`,
        ),
      );
    }
  }
  if (
    '$schema' in schema &&
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
  ) {
    state.issues.push(
      issue(
        `${path}/$schema`,
        'schema_dialect_unsupported',
        'Only JSON Schema draft 2020-12 is supported.',
      ),
    );
  }
  if (
    schema.type !== undefined &&
    (typeof schema.type !== 'string' || !allowedSchemaTypes.has(schema.type))
  ) {
    state.issues.push(
      issue(
        `${path}/type`,
        'schema_type_invalid',
        'Schema type must be one supported JSON type.',
      ),
    );
  }
  if (
    'pattern' in schema &&
    String(schema.pattern).length > PROCESSOR_SCHEMA_LIMITS.maxPatternLength
  ) {
    state.issues.push(
      issue(
        `${path}/pattern`,
        'schema_pattern_too_large',
        'Schema patterns are limited to 256 characters.',
      ),
    );
  }
  if (
    typeof schema.pattern === 'string' &&
    (schema.pattern.includes('(?') || /\\[1-9]/.test(schema.pattern))
  ) {
    state.issues.push(
      issue(
        `${path}/pattern`,
        'schema_pattern_unsafe',
        'Schema patterns cannot use lookaround or backreferences.',
      ),
    );
  }
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > PROCESSOR_SCHEMA_LIMITS.maxEnumValues
  ) {
    state.issues.push(
      issue(
        `${path}/enum`,
        'schema_enum_too_large',
        'Schema enums are limited to 64 values.',
      ),
    );
  }
  const properties = objectValue(schema.properties);
  if (schema.properties !== undefined && properties === undefined) {
    state.issues.push(
      issue(
        `${path}/properties`,
        'schema_properties_invalid',
        'Schema properties must be an object.',
      ),
    );
  }
  if (properties !== undefined) {
    const entries = Object.entries(properties);
    if (entries.length > PROCESSOR_SCHEMA_LIMITS.maxPropertiesPerObject) {
      state.issues.push(
        issue(
          `${path}/properties`,
          'schema_properties_too_large',
          'Schema objects are limited to 64 properties.',
        ),
      );
    }
    for (const [key, child] of entries)
      inspectSchema(child, `${path}/properties/${key}`, depth + 1, state);
  }
  if (schema.items !== undefined)
    inspectSchema(schema.items, `${path}/items`, depth + 1, state);
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    state.issues.push(
      issue(
        `${path}/additionalProperties`,
        'schema_additional_properties_invalid',
        'additionalProperties must be a boolean.',
      ),
    );
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((entry) => typeof entry !== 'string') ||
      new Set(schema.required).size !== schema.required.length
    ) {
      state.issues.push(
        issue(
          `${path}/required`,
          'schema_required_invalid',
          'required must contain unique property names.',
        ),
      );
    } else if (
      properties !== undefined &&
      schema.required.some((entry) => !(String(entry) in properties))
    ) {
      state.issues.push(
        issue(
          `${path}/required`,
          'schema_required_missing_property',
          'Every required name must exist in properties.',
        ),
      );
    }
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      if (branches.length === 0 || branches.length > 8) {
        state.issues.push(
          issue(
            `${path}/${keyword}`,
            'schema_branch_count_invalid',
            'Schema compositions require between 1 and 8 branches.',
          ),
        );
      }
      for (const [index, branch] of branches.entries())
        inspectSchema(branch, `${path}/${keyword}/${index}`, depth + 1, state);
    }
    if (branches !== undefined && !Array.isArray(branches)) {
      state.issues.push(
        issue(
          `${path}/${keyword}`,
          'schema_branches_invalid',
          `${keyword} must be an array of schemas.`,
        ),
      );
    }
  }
}

function schemaAcceptsSelector(
  schemaValue: Readonly<Record<string, unknown>>,
  selector: string,
): boolean {
  let current: unknown = schemaValue;
  for (const token of selector
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    const schema = objectValue(current);
    const properties =
      schema === undefined ? undefined : objectValue(schema.properties);
    if (properties === undefined || !(token in properties)) return false;
    current = properties[token];
  }
  return true;
}

export function findProcessorDependencyCycle(
  graph: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): readonly string[] | undefined => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visiting.add(id);
    path.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of [...graph.keys()].sort()) {
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

export function validateProcessorDefinition(
  definition: ProcessorDefinitionDraft,
  options: Readonly<{
    candidateVersionId?: string;
    candidateProcessorId?: string;
    publishedVersions?: readonly PublishedProcessorVersion[];
  }> = {},
): ProcessorDefinitionValidation {
  const state = {
    nodes: 0,
    depth: 0,
    issues: [] as ProcessorValidationIssue[],
  };
  inspectSchema(definition.outputSchema, '/outputSchema', 1, state);
  if (
    new TextEncoder().encode(JSON.stringify(definition.outputSchema))
      .byteLength > PROCESSOR_SCHEMA_LIMITS.maxBytes
  ) {
    state.issues.push(
      issue(
        '/outputSchema',
        'schema_too_large',
        'The output schema exceeds 65,536 UTF-8 bytes.',
      ),
    );
  }
  if (state.nodes > PROCESSOR_SCHEMA_LIMITS.maxNodes)
    state.issues.push(
      issue(
        '/outputSchema',
        'schema_too_complex',
        'The output schema exceeds 128 nodes.',
      ),
    );
  if (state.depth > PROCESSOR_SCHEMA_LIMITS.maxDepth)
    state.issues.push(
      issue(
        '/outputSchema',
        'schema_too_deep',
        'The output schema exceeds 8 levels.',
      ),
    );
  if (definition.outputSchema.type !== 'object')
    state.issues.push(
      issue(
        '/outputSchema/type',
        'schema_root_not_object',
        'The output schema root must have type object.',
      ),
    );
  if (definition.outputSchema.additionalProperties !== false)
    state.issues.push(
      issue(
        '/outputSchema/additionalProperties',
        'schema_open_object',
        'The output schema root must reject additional properties.',
      ),
    );
  if (
    definition.reconciliation.strategy === 'logical_key' &&
    definition.reconciliation.logicalKey === undefined
  ) {
    state.issues.push(
      issue(
        '/reconciliation/logicalKey',
        'logical_key_required',
        'Logical-key reconciliation requires a logical key.',
      ),
    );
  }
  if (
    definition.reconciliation.strategy === 'logical_key' &&
    definition.reconciliation.logicalKey !== undefined
  ) {
    const rootProperties = objectValue(definition.outputSchema.properties);
    const itemsSchema = objectValue(rootProperties?.items);
    const itemSchema = objectValue(itemsSchema?.items);
    const itemProperties = objectValue(itemSchema?.properties);
    const required = itemSchema?.required;
    if (
      itemProperties === undefined ||
      !(definition.reconciliation.logicalKey in itemProperties) ||
      !Array.isArray(required) ||
      !required.includes(definition.reconciliation.logicalKey)
    ) {
      state.issues.push(
        issue(
          '/outputSchema/properties/items/items',
          'logical_key_schema_missing',
          'Logical-key output items must require the configured stable key field.',
        ),
      );
    }
  }
  if (
    definition.reconciliation.strategy !== 'logical_key' &&
    definition.reconciliation.logicalKey !== undefined
  ) {
    state.issues.push(
      issue(
        '/reconciliation/logicalKey',
        'logical_key_unused',
        'A logical key is only valid for logical-key reconciliation.',
      ),
    );
  }
  if (
    definition.nudgePolicy.enabled &&
    definition.requirementMode !== 'required'
  ) {
    state.issues.push(
      issue(
        '/nudgePolicy/enabled',
        'optional_nudge_disallowed',
        'Optional definitions cannot enable missing-information nudges by default.',
      ),
    );
  }
  if (
    definition.nudgePolicy.enabled !==
    (definition.nudgePolicy.prompt !== undefined)
  ) {
    state.issues.push(
      issue(
        '/nudgePolicy/prompt',
        'nudge_prompt_inconsistent',
        'Enabled nudges require a prompt; disabled nudges must omit it.',
      ),
    );
  }
  if (
    definition.capabilityRequirements.includes('deterministic') &&
    definition.capabilityRequirements.length > 1
  ) {
    state.issues.push(
      issue(
        '/capabilityRequirements',
        'capability_conflict',
        'Deterministic processors cannot also require model capabilities.',
      ),
    );
  }
  const published = options.publishedVersions ?? [];
  const versionById = new Map(
    published.map((version) => [version.id, version]),
  );
  const dependencyKeys = new Set<string>();
  for (const [index, dependency] of definition.dependencies.entries()) {
    const dependencyKey = `${dependency.upstreamVersionId}:${dependency.outputSelector}`;
    if (dependencyKeys.has(dependencyKey)) {
      state.issues.push(
        issue(
          `/dependencies/${index}`,
          'dependency_duplicate',
          'Exact dependency selectors must be unique.',
        ),
      );
    }
    dependencyKeys.add(dependencyKey);
    const upstream = versionById.get(dependency.upstreamVersionId);
    if (upstream === undefined) {
      state.issues.push(
        issue(
          `/dependencies/${index}/upstreamVersionId`,
          'dependency_missing',
          'The exact upstream processor version does not exist.',
        ),
      );
      continue;
    }
    if (upstream.processorId === options.candidateProcessorId) {
      state.issues.push(
        issue(
          `/dependencies/${index}/upstreamVersionId`,
          'dependency_self_processor',
          'A processor cannot depend on one of its own versions.',
        ),
      );
    }
    if (
      definition.input.scope !== 'date_range' &&
      upstream.definition.input.scope === 'date_range'
    ) {
      state.issues.push(
        issue(
          `/dependencies/${index}/upstreamVersionId`,
          'dependency_scope_incompatible',
          'A narrower processor scope cannot depend on date-range output.',
        ),
      );
    }
    if (
      !schemaAcceptsSelector(
        upstream.definition.outputSchema,
        dependency.outputSelector,
      )
    ) {
      state.issues.push(
        issue(
          `/dependencies/${index}/outputSelector`,
          'dependency_selector_missing',
          'The selector is not declared by the upstream output schema.',
        ),
      );
    }
  }
  if (options.candidateVersionId !== undefined) {
    const graph = new Map<string, readonly string[]>(
      published.map((version) => [
        version.id,
        version.definition.dependencies.map(
          (dependency) => dependency.upstreamVersionId,
        ),
      ]),
    );
    graph.set(
      options.candidateVersionId,
      definition.dependencies.map((dependency) => dependency.upstreamVersionId),
    );
    if (findProcessorDependencyCycle(graph) !== undefined)
      state.issues.push(
        issue(
          '/dependencies',
          'dependency_cycle',
          'Processor-version dependencies must be acyclic.',
        ),
      );
  }
  return {
    valid: state.issues.length === 0,
    issues: state.issues,
    schemaComplexity: { depth: state.depth, nodes: state.nodes },
  };
}
