import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProject, resolveCaptions } from '../src/project.mjs';
import { bindTemplate, loadTemplate, materializeTemplate } from '../src/template.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-video-template-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templateFile = join(root, 'template.json');
  const bindingsFile = join(root, 'choices.json');
  const outputFile = join(root, 'cut.json');
  const template = {
    version: 1, title: { $slot: 'topic' }, canvas: { width: 160, height: 240, fps: 10 },
    clips: [{ id: 'opening', kind: 'video', src: { $slot: 'host' }, untilWord: 'w1', effects: { $slot: 'effect' } },
      { id: 'end', kind: 'color', color: '#123456', duration: 1 }],
    words: { $slot: 'words' },
    captions: [{ fromWord: 'w1', toWord: 'w1' }, { text: { $slot: 'topic' }, start: 1, end: 1.5 }],
  };
  const bindings = {
    host: 'assets/alex.mp4', topic: 'Safer defaults', effect: { saturation: 0.4 },
    words: [{ id: 'w1', text: 'Listen', start: 0.2, end: 0.8 }],
  };
  await mkdir(join(root, 'assets'));
  await Promise.all([
    writeFile(templateFile, JSON.stringify(template)),
    writeFile(bindingsFile, JSON.stringify(bindings)),
    writeFile(join(root, 'assets', 'alex.mp4'), 'media path fixture'),
    writeFile(join(root, 'assets', 'dev.mp4'), 'replacement media path fixture'),
  ]);
  return { root, template, bindings, templateFile, bindingsFile, outputFile };
}

test('materializes a reusable project and resolves revised speech without changing the template', async t => {
  const { template, bindings, templateFile, bindingsFile, outputFile } = await fixture(t);
  const saved = await materializeTemplate(templateFile, bindingsFile, outputFile);
  const { project } = await loadProject(saved.project);
  assert.deepEqual(saved.slots, ['effect', 'host', 'topic', 'words']);
  assert.equal(project.clips[0].src, 'assets/alex.mp4');
  assert.equal(project.clips[0].effects.saturation, 0.4);
  assert.deepEqual(resolveCaptions(project).map(caption => caption.text), ['Listen', 'Safer defaults']);

  const loaded = await loadTemplate(templateFile);
  const next = await bindTemplate(loaded, {
    ...bindings, host: 'assets/dev.mp4', topic: 'New topic', effect: { contrast: 1.2 },
    words: [{ id: 'w1', text: 'Watch', start: 0.1, end: 1 }],
  });
  assert.equal(next.clips[0].src, 'assets/dev.mp4');
  assert.equal(next.clips[0].effects.contrast, 1.2);
  assert.deepEqual(resolveCaptions(next).map(caption => [caption.text, caption.end]), [['Watch', 1], ['New topic', 1.5]]);
  assert.deepEqual(loaded.template, template);
  assert.deepEqual(JSON.parse(await readFile(templateFile, 'utf8')), template);
});

test('requires exact literal bindings and rejects malformed or reserved slot keys', async t => {
  const { template, bindings, templateFile } = await fixture(t);
  const loaded = await loadTemplate(templateFile);
  const missingHost = { ...bindings };
  delete missingHost.host;
  await assert.rejects(bindTemplate(loaded, missingHost), { code: 'INVALID_BINDINGS', details: { slot: 'host' } });
  await assert.rejects(bindTemplate(loaded, { ...bindings, unused: true }), { code: 'INVALID_BINDINGS', details: { slot: 'unused' } });
  await assert.rejects(bindTemplate(loaded, { ...bindings, topic: { $slot: 'host' } }), { code: 'INVALID_BINDINGS' });
  await assert.rejects(bindTemplate(loaded, { ...bindings, effect: JSON.parse('{"__proto__":{"polluted":true}}') }), { code: 'INVALID_BINDINGS' });
  assert.equal(Object.prototype.polluted, undefined);
  for (const malformed of [{ $slot: 'constructor' }, { $slot: 'topic', fallback: 'other' }, { $slot: [] }]) {
    await writeFile(templateFile, JSON.stringify({ ...template, title: malformed }));
    await assert.rejects(loadTemplate(templateFile), { code: 'INVALID_TEMPLATE' });
  }
});

test('applies project and asset validation before publishing a project', async t => {
  const { bindings, templateFile, bindingsFile, outputFile } = await fixture(t);
  for (const [replacement, code] of [[{ host: '../outside.mp4' }, 'INVALID_PROJECT'], [{ host: 'assets/missing.mp4' }, 'INVALID_ASSET'], [{ effect: { contrast: 999 } }, 'INVALID_PROJECT']]) {
    await writeFile(bindingsFile, JSON.stringify({ ...bindings, ...replacement }));
    await assert.rejects(materializeTemplate(templateFile, bindingsFile, outputFile), { code });
    await assert.rejects(access(outputFile), { code: 'ENOENT' });
  }
});

test('writes only a fresh JSON sibling, including when two requests choose the same filename', async t => {
  const { root, templateFile, bindingsFile, outputFile } = await fixture(t);
  await mkdir(join(root, 'nested'));
  await assert.rejects(materializeTemplate(templateFile, bindingsFile, join(root, 'nested', 'cut.json')), { code: 'INVALID_TEMPLATE_OUTPUT_PATH' });
  await assert.rejects(materializeTemplate(templateFile, bindingsFile, join(root, 'cut.mp4')), { code: 'INVALID_OUTPUT' });
  const results = await Promise.allSettled([
    materializeTemplate(templateFile, bindingsFile, outputFile),
    materializeTemplate(templateFile, bindingsFile, outputFile),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'OUTPUT_EXISTS');
  assert.equal((await loadProject(outputFile)).project.title, 'Safer defaults');
});
