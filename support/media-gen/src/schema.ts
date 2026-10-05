/** Bounded provider schemas, local references, and complete request validation. */

import type { ValidateFunction } from 'ajv'
import Ajv from 'ajv'
import type { MediaSchema } from './media.ts'

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
  addUsedSchema: false,
})
const validators = new WeakMap<MediaSchema, ValidateFunction>()
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Accept only bounded JSON schemas whose references remain inside this document. */
export function mediaSchema(value: unknown): MediaSchema {
  if (!object(value) || JSON.stringify(value).length > 262144)
    throw new Error('Provider schema exceeds its 256 KiB limit')
  let nodes = 0
  const check = (value: unknown, depth: number): void => {
    if (++nodes > 16384 || depth > 64)
      throw new Error('Provider schema exceeds its structural limit')
    if (Array.isArray(value)) for (const child of value) check(child, depth + 1)
    else if (object(value))
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/')))
          throw new Error('Provider schemas cannot load external references')
        check(child, depth + 1)
      }
    else if (value !== null && !['string', 'boolean', 'number'].includes(typeof value))
      throw new Error('Provider schemas must contain JSON values')
  }
  check(value, 0)
  return value
}

/** Import an OpenAPI request or response schema with its local component definitions. */
export function openApiSchema(document: unknown, response = false): MediaSchema | undefined {
  if (!object(document) || !object(document.paths))
    throw new Error('The provider returned an invalid OpenAPI document')
  for (const [modelPath, path] of Object.entries(document.paths)) {
    if (!object(path) || !object(path.post)) continue
    const operation = path.post
    if (!object(operation.requestBody)) continue
    const resultOperation = response
      ? Object.entries(document.paths).find(
          ([name, path]) =>
            name === `${modelPath.replace(/\/$/, '')}/requests/{request_id}` &&
            object(path) &&
            object(path.get),
        )?.[1]
      : undefined
    const resultGet =
      object(resultOperation) && object(resultOperation.get) ? resultOperation.get : undefined
    const owner = response
      ? object(resultGet?.responses)
        ? resultGet.responses['200']
        : object(operation.responses)
          ? operation.responses['200']
          : undefined
      : operation.requestBody
    if (!object(owner) || !object(owner.content)) continue
    const content = owner.content['application/json']
    if (!object(content) || !object(content.schema)) continue
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalize)
      if (!object(value)) return value
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (key === 'nullable') continue
        result[key] =
          key === '$ref' && typeof child === 'string'
            ? child.replace('#/components/schemas/', '#/definitions/')
            : normalize(child)
      }
      if (value.nullable === true && typeof result.type === 'string')
        result.type = [result.type, 'null']
      return result
    }
    const normalized = normalize(content.schema)
    if (!object(normalized)) throw new Error('Invalid provider schema')
    const components =
      object(document.components) && object(document.components.schemas)
        ? document.components.schemas
        : undefined
    return mediaSchema({
      ...normalized,
      ...(components ? { definitions: normalize(components) } : {}),
    })
  }
  return undefined
}

/** Validate the complete body; AJV never loads schemas or mutates supplied values. */
export function validateMediaBody(schema: MediaSchema, body: unknown): void {
  let validate = validators.get(schema)
  if (!validate) {
    validate = ajv.compile(mediaSchema(schema))
    validators.set(schema, validate)
  }
  if (!validate(body))
    throw new Error(
      `Invalid model input: ${ajv.errorsText(validate.errors, { separator: '; ' }).slice(0, 2048)}`,
    )
}

/** Resolve a local root reference for UI fields and conventional source mapping. */
export function mediaProperties(schema: MediaSchema): Record<string, unknown> {
  let node: Record<string, unknown> = schema
  const seen = new Set<string>()
  while (typeof node.$ref === 'string') {
    const ref = node.$ref
    if (seen.has(ref) || seen.size >= 16)
      throw new Error('Recursive model input root is unsupported')
    seen.add(ref)
    let value: unknown = schema
    for (const key of ref.slice(2).split('/'))
      value = object(value) ? value[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
    if (!object(value)) throw new Error('Model input reference is unavailable')
    node = value
  }
  return object(node.properties) ? node.properties : {}
}

/** Insert an asset at an explicit, bounded model-schema path without prototype mutation. */
export function assignMediaAsset(
  body: Record<string, unknown>,
  path: readonly (string | number)[],
  url: string,
): void {
  if (
    !path.length ||
    path.length > 16 ||
    path.some((key) =>
      typeof key === 'string'
        ? !key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)
        : !Number.isSafeInteger(key) || key < 0 || key > 63,
    )
  )
    throw new Error('Invalid media asset path')
  let current: Record<string, unknown> | unknown[] = body
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      if (Object.hasOwn(current, key))
        throw new Error('A source asset cannot overwrite an existing model input')
      Reflect.set(current, key, url)
      return
    }
    let child: unknown = Reflect.get(current, key)
    if (child === undefined) {
      child = typeof path[index + 1] === 'number' ? [] : {}
      Reflect.set(current, key, child)
    }
    if (!object(child) && !Array.isArray(child))
      throw new Error('A source asset path conflicts with a model input')
    current = child
  }
}
