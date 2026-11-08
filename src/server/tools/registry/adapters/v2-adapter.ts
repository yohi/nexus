import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { classifyErrorMessage } from '../../../errors.js';
import { TOOL_DEFINITIONS } from '../definitions.js';
import type { NeutralField, NeutralSchema } from '../schemas-neutral.js';
import type { NexusToolCallResult, ToolHandler } from '../../types.js';

export interface V2ToolLimits {
  topK: number;
  maxResults: number;
}

const DEFAULT_V2_TOOL_LIMITS: V2ToolLimits = { topK: 100, maxResults: 1000 };

const limitFor = (
  fieldName: string,
  declaredMaximum: number,
  limits: V2ToolLimits,
  hardMaximum = false,
): number => {
  const configured = fieldName === 'topK' ? limits.topK : fieldName === 'maxResults' ? limits.maxResults : undefined;
  if (configured === undefined) return declaredMaximum;
  return hardMaximum ? Math.min(declaredMaximum, configured) : configured;
};

const schemaDescription = (field: NeutralField): { readonly description?: string } =>
  field.description === undefined ? {} : { description: field.description };

const toV2JsonSchemaField = (
  name: string,
  field: NeutralField,
  limits: V2ToolLimits,
): JsonSchemaType => {
  const description = schemaDescription(field);
  switch (field.kind) {
    case 'string':
      return {
        ...description,
        type: 'string',
        ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
      };
    case 'integer':
      return {
        ...description,
        type: 'integer',
        minimum: field.minimum ?? 1,
        ...(field.maximum === undefined ? {} : { maximum: limitFor(name, field.maximum, limits, field.hardMaximum) }),
      };
    case 'number':
      return { ...description, type: 'number' };
    case 'boolean':
      return {
        ...description,
        type: 'boolean',
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'stringArray':
      return { ...description, type: 'array', items: { type: 'string' } };
    case 'enum':
      return {
        ...description,
        type: 'string',
        enum: field.values,
        ...(field.default === undefined ? {} : { default: field.default }),
      };
  }
};

export const toV2JsonSchema = (
  schema: NeutralSchema,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
): JsonSchemaType => {
  const properties: Record<string, JsonSchemaType> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema)) {
    properties[name] = toV2JsonSchemaField(name, field, limits);
    if (field.optional !== true) {
      required.push(name);
    }
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) };
};

const toZodV4Field = (name: string, field: NeutralField, limits: V2ToolLimits): z.ZodType => {
  switch (field.kind) {
    case 'string': {
      let stringField = z.string();
      if (field.pattern !== undefined) {
        stringField = stringField.regex(new RegExp(field.pattern));
      }
      return stringField;
    }
    case 'integer': {
      // Default to positive (>= 1); an explicit schema minimum (e.g. 0) overrides it.
      let integer = z.number().int().min(field.minimum ?? 1);
      if (field.maximum !== undefined) {
        integer = integer.max(limitFor(name, field.maximum, limits, field.hardMaximum));
      }
      return integer;
    }
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'stringArray':
      return z.array(z.string());
    case 'enum':
      return z.enum(field.values);
  }
};

export const toZodV4Object = (
  schema: NeutralSchema,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
) => {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema)) {
    let zodField = toZodV4Field(key, field, limits);
    if (field.optional === true) {
      zodField = zodField.optional();
    }
    if ('default' in field && field.default !== undefined) {
      zodField = zodField.default(field.default);
    }
    if (field.description !== undefined) {
      zodField = zodField.describe(field.description);
    }
    shape[key] = zodField;
  }
  return z.object(shape);
};

export const withErrorCode = (result: NexusToolCallResult): NexusToolCallResult => {
  if (result.isError !== true || result.structuredContent === undefined) {
    return result;
  }
  const message = result.structuredContent['message'];
  const code = typeof message === 'string' ? classifyErrorMessage(message) : 'NEXUS_INTERNAL_ERROR';
  return { ...result, structuredContent: { ...result.structuredContent, code } };
};

export const registerV2Tools = (
  server: McpServer,
  handlers: Record<string, ToolHandler>,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
): void => {
  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.name];
    if (handler === undefined) {
      throw new Error(`missing handler for tool: ${definition.name}`);
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema(toV2JsonSchema(definition.input, limits)),
      },
      async (args, extra) => {
        const normalizedArgs = toZodV4Object(definition.input, limits).parse(args);
        return withErrorCode(await handler(normalizedArgs, { signal: extra.mcpReq.signal }));
      },
    );
  }
};
