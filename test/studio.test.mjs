import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { ffmpegPath, runMedia } from '../src/media-process.mjs';
import { prepareStudio, reviewStudio } from '../src/studio.mjs';

async function fixture(t) {
  const temporary = tmpdir();
  const root = await mkdtemp(join(temporary, 'agent-video-studio-'));
  t.after(async () => {
    const child = relative(temporary, root);
    assert.match(child, /^agent-video-studio-/);
    assert.ok(!child.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'two-shots.mp4');
  await runMedia(ffmpegPath(), ['-v', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10:d=0.8',
    '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=10:d=0.8',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-n', file]);
  return { root, file };
}

test('prepares measured shot evidence and a standalone agent workspace without an invented transcript', async t => {
  const { root, file } = await fixture(t);
  const outDir = join(root, 'production');
  const brief = 'Use the pacing for a different host and topic.';
  const prepared = await prepareStudio(file, { outDir, brief });
  const report = JSON.parse(await readFile(prepared.report, 'utf8'));
  assert.equal(report.version, 1);
  assert.equal(report.brief, brief);
  assert.equal(report.reference.source.path, file);
  assert.equal(report.reference.pacing.shotCount, 2);
  assert.equal(report.reference.frameRequestedTimes[0], 0);
  assert.equal(report.reference.confidence.semantics, 'not-assessed');
  assert.equal(report.transcription, null);
  assert.equal(prepared.words, null);
  assert.deepEqual(await readdir(join(outDir, 'assets')), []);
  assert.ok((await readFile(prepared.contactSheet)).length > 0);
  assert.match(await readFile(prepared.request, 'utf8'), /project\.json.+FORMAT\.md/);
  const original = await readFile(prepared.report);
  await assert.rejects(prepareStudio(file, { outDir, brief: 'A second brief' }), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(prepared.report), original);
});

test('rejects malformed options or cancellation before making a workspace and requires audio for requested words', async t => {
  const { root, file } = await fixture(t);
  const outDir = join(root, 'production');
  await assert.rejects(prepareStudio(file, { outDir, brief: '\0' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(prepareStudio(file, { outDir, sceneThreshold: 2 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(prepareStudio(file, { outDir, signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.deepEqual(await readdir(root), ['two-shots.mp4']);
  await assert.rejects(prepareStudio(file, { outDir, transcribe: true }), { code: 'INVALID_MEDIA' });
  assert.deepEqual(await readdir(outDir), ['inspection']);
});

test('decodes the output and records both passing and failed project checks', async t => {
  const { root, file } = await fixture(t);
  const projectFile = join(root, 'project.json');
  const project = { version: 1, title: 'Review fixture', canvas: { width: 160, height: 120, fps: 10 },
    clips: [{ id: 'first', kind: 'color', color: '#000000', duration: 0.81 },
      { id: 'second', kind: 'color', color: '#FFFFFF', duration: 0.8 }] };
  await writeFile(projectFile, JSON.stringify(project));
  const matched = await reviewStudio(file, { outDir: join(root, 'matched'), projectFile });
  assert.equal(matched.passed, true);
  assert.equal(matched.checks.duration.expected, 1.6);
  assert.equal(matched.checks.decode.passed, true);
  assert.ok((await readFile(matched.contactSheet)).length > 0);

  project.canvas.width = 200;
  project.clips[1].duration = 0.9;
  await writeFile(projectFile, JSON.stringify(project));
  const mismatch = await reviewStudio(file, { outDir: join(root, 'mismatch'), projectFile });
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.checks.dimensions.passed, false);
  assert.equal(mismatch.checks.duration.passed, false);
  const report = JSON.parse(await readFile(mismatch.report, 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.evidence.source.path, file);
});
