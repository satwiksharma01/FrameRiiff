import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ProjectError, validateAssets, validateProject } from './project.mjs';

const maxBytes = 2 * 1024 * 1024;
const slotName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

async function readDocument(file, code) {
  try {
    if (typeof file !== 'string' || !file.trim()) throw new Error('expected a JSON file path');
    const path = await realpath(resolve(file));
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error('expected a regular JSON file of at most 2 MiB');
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new Error('JSON exceeds the 2 MiB limit');
    return { path, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw new ProjectError(code, `Cannot read ${String(file)}: ${error.message}`);
  }
}

function transform(value, code, bindSlot, depth = 0) {
  if (depth > 64) throw new ProjectError(code, 'JSON nesting exceeds 64 levels');
  if (Array.isArray(value)) return Array.from(value, item => transform(item, code, bindSlot, depth + 1));
  if (record(value)) {
    const keys = Object.keys(value);
    if (Object.hasOwn(value, '$slot')) {
      if (!bindSlot) throw new ProjectError(code, 'Bindings must contain literal JSON values');
      if (keys.length !== 1 || typeof value.$slot !== 'string' || !slotName.test(value.$slot) || reserved.has(value.$slot)) {
        throw new ProjectError(code, 'A slot must be an object containing only a valid $slot name');
      }
      return bindSlot(value.$slot);
    }
    if (keys.some(key => reserved.has(key))) throw new ProjectError(code, 'JSON contains a reserved object key');
    return Object.fromEntries(keys.map(key => [key, transform(value[key], code, bindSlot, depth + 1)]));
  }
  if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) return value;
  throw new ProjectError(code, 'Expected literal JSON values and finite numbers');
}

export async function loadTemplate(templateFile) {
  const { path: projectPath, value } = await readDocument(templateFile, 'INVALID_TEMPLATE');
  if (!record(value) || Object.hasOwn(value, '$slot')) throw new ProjectError('INVALID_TEMPLATE', 'The template must be a project object');
  const slots = new Set();
  const template = transform(value, 'INVALID_TEMPLATE', name => {
    slots.add(name);
    return { $slot: name };
  });
  if (slots.size === 0) throw new ProjectError('INVALID_TEMPLATE', 'Declare at least one $slot in the project template');
  return { root: dirname(projectPath), projectPath, template, slots: [...slots].sort() };
}

export async function bindTemplate(loaded, rawBindings) {
  if (!record(rawBindings) || Object.keys(rawBindings).some(name => !slotName.test(name) || reserved.has(name))) {
    throw new ProjectError('INVALID_BINDINGS', 'Bindings must be an object with valid slot names');
  }
  const bindings = transform(rawBindings, 'INVALID_BINDINGS');
  const slots = new Set(loaded.slots);
  for (const name of Object.keys(bindings)) {
    if (!slots.has(name)) throw new ProjectError('INVALID_BINDINGS', `No slot named ${name} exists in the template`, { slot: name });
  }
  const value = transform(loaded.template, 'INVALID_TEMPLATE', name => {
    if (!Object.hasOwn(bindings, name)) throw new ProjectError('INVALID_BINDINGS', `Missing binding for slot ${name}`, { slot: name });
    return bindings[name];
  });
  const project = validateProject(value);
  if (Buffer.byteLength(JSON.stringify(project, null, 2) + '\n') > maxBytes) {
    throw new ProjectError('INVALID_PROJECT', 'Materialized project JSON exceeds the 2 MiB limit');
  }
  await validateAssets(project, loaded.root);
  return project;
}

export async function materializeTemplate(templateFile, bindingsFile, outputFile) {
  const [loaded, { value: bindings }] = await Promise.all([
    loadTemplate(templateFile),
    readDocument(bindingsFile, 'INVALID_BINDINGS'),
  ]);
  if (typeof outputFile !== 'string' || !outputFile.trim()) throw new ProjectError('INVALID_OUTPUT', 'Supply a new project output filename');
  const requested = resolve(outputFile);
  const name = basename(requested);
  if (extname(name).toLowerCase() !== '.json' || /[<>:"\\|?*\u0000-\u001f]/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new ProjectError('INVALID_OUTPUT', 'Use a regular .json filename');
  }
  const parent = await realpath(dirname(requested)).catch(error => {
    throw new ProjectError('INVALID_TEMPLATE_OUTPUT_PATH', `Cannot use the output directory: ${error.message}`);
  });
  if (parent !== loaded.root) throw new ProjectError('INVALID_TEMPLATE_OUTPUT_PATH', 'Save the new project beside its template so media references keep their meaning');
  const project = await bindTemplate(loaded, bindings);
  const content = JSON.stringify(project, null, 2) + '\n';
  const output = join(loaded.root, name);
  try { await writeFile(output, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ProjectError('OUTPUT_EXISTS', `File already exists: ${output}`);
    throw error;
  }
  return { project: output, title: project.title, slots: loaded.slots };
}
