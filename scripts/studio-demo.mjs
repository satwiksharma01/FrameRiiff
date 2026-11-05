import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/agent-video.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const requested = process.argv[2];
await mkdir(requested ? dirname(resolve(requested)) : resolve('output'), { recursive: true });
const root = requested ? resolve(requested) : await mkdtemp(resolve('output', 'studio-demo-'));
if (requested) await mkdir(root);
await mkdir(join(root, 'assets'));

async function call(...args) {
  try {
    const { stdout } = await exec(process.execPath, [cli, ...args, '--json'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    assert.equal(data.ok, true);
    return data;
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    throw error;
  }
}

async function write(name, data) {
  await writeFile(join(root, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

// These color-and-tone clips are original test fixtures for supplied footage slots.
for (const [id, color, tone] of [['host-a', '0x122845', 340], ['host-b', '0x2c1d40', 530], ['topic-b', '0x0b3431', 670]]) {
  await exec(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:size=480x270:rate=24:duration=3`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=3`,
    '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `assets/${id}.mp4`], { cwd: root, windowsHide: true });
}

const prepared = await call('prepare', 'assets/host-a.mp4', '--out-dir', 'reference', '--brief', 'Use one short clip, an opening card, and a timed two-word caption.');
const slot = name => ({ $slot: name });
const template = {
  version: 1, title: slot('topic'), canvas: { width: 480, height: 270, fps: 24 },
  clips: [{ id: 'host', kind: 'video', src: slot('host'), duration: 3, effects: slot('effect') }],
  words: slot('words'),
  captions: [{ fromWord: 'a', toWord: 'b', karaoke: true, highlightColor: '#ffd166', fontSize: 27 }],
  graphics: [{ id: 'headline', text: slot('topic'), start: 0.1, end: 2.6, position: 'top', fontSize: 30,
    color: '#ffffff', background: '#22406a', motion: slot('entrance'), enter: 0.3 }],
};
const words = (first, second) => [{ id: 'a', text: first, start: 0.85, end: 1.45 }, { id: 'b', text: second, start: 1.45, end: 2.15 }];
const base = { host: 'assets/host-a.mp4', topic: 'Edit a reference', effect: {}, words: words('Make', 'variants'), entrance: 'fade' };
const variants = [
  { id: 'baseline', bindings: base },
  { id: 'swap-host', bindings: { ...base, host: 'assets/host-b.mp4' } },
  { id: 'swap-effect', bindings: { ...base, effect: { saturation: 0.35, brightness: 0.12 }, entrance: 'slide-up' } },
  { id: 'swap-topic', bindings: { ...base, host: 'assets/topic-b.mp4', topic: 'Compare two ideas', words: words('Compare', 'ideas') } },
];
await write('template.json', template);
await write('bindings.json', base);
await write('variants.json', variants);
const authored = await call('materialize', 'template.json', '--bindings', 'bindings.json', '--out', 'project.json');
await write('sources.json', { [base.host]: base.words });
await call('map-words', 'project.json', '--words', 'sources.json', '--out', 'timed.json', '--karaoke');
const batch = (await call('template-batch', 'template.json', '--variants', 'variants.json', '--out-dir', 'cuts')).batch;
assert.equal(batch.status, 'succeeded');
assert.equal(batch.variants.length, variants.length);
const resumed = (await call('resume-batch', 'cuts')).batch;
assert.deepEqual(resumed.variants.map(cut => cut.jobId), batch.variants.map(cut => cut.jobId));

const reviews = [];
const frames = new Set();
for (const variant of variants) {
  const output = `cuts/${variant.id}.mp4`;
  const review = await call('review', output, '--project', 'project.json', '--out-dir', `reviews/${variant.id}`);
  const { stdout } = await exec(ffmpeg, ['-nostdin', '-v', 'error', '-ss', '1.2', '-i', output,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'framemd5', '-'], { cwd: root, windowsHide: true });
  const pixelHash = stdout.trim().split(/\r?\n/).at(-1)?.split(',').at(-1)?.trim();
  assert.match(pixelHash, /^[a-f0-9]{32}$/);
  frames.add(pixelHash);
  reviews.push({ id: variant.id, video: join(root, output), review: review.report, frameHash: pixelHash });
}
assert.equal(frames.size, variants.length, 'Each variant must change decoded picture content.');
assert.equal(JSON.parse(await readFile(join(root, 'timed.json'), 'utf8')).words.length, 2);
await write('demo-result.json', { fixture: 'Synthetic media and illustrative words', reference: prepared.report, project: authored.project, reviews });
process.stdout.write(`Demo finished in ${root}\n`);
