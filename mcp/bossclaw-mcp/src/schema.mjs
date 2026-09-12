// src/schema.mjs —— JSON Schema 片段助手（拼 MCP 工具入参 schema 用）
export const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
export const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
export const arr = (description, items = { type: 'string' }, extra = {}) => ({
  type: 'array',
  description,
  items,
  ...extra,
});

export const obj = (properties, required = [], extra = {}) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  ...extra,
});

export const enumStr = (description, values) => str(`${description}（可选：${values.join(' / ')}）`, { enum: values });

/** 读工具注解：帮助客户端判定是否可自动批准 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE_LOCAL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
