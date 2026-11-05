import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { resolveCaptions, resolveGraphics, validateProject } from '../src/project.mjs';
import { renderVideo } from '../src/render.mjs';

const exec = promisify(execFile);
const canvas = { width: 480, height: 270, fps: 20 };

function example() {
  return {
    version: 1, title: 'Visual layers test', canvas,
    clips: [{ id: 'base', kind: 'color', color: '#000000', duration: 2 }],
    words: [
      { id: 'first', text: 'A\\N{\\1c&H00FF00&}', start: 0.35, end: 0.75 },
      { id: 'last', text: 'SECOND', start: 0.95, end: 1.45 },
    ],
    captions: [{ fromWord: 'first', toWord: 'last', karaoke: true, highlightColor: '#ff0000', fontSize: 24 }],
    graphics: [
      { id: 'slide', text: '30%: %{eif:1:d}\n[Ready], {go}', start: 0.4, end: 1.3, position: 'top', fontSize: 18, background: '#005f00', motion: 'slide-up', enter: 0.4 },
      { id: 'fade', text: 'Fade', start: 1.5, end: 2, fontSize: 20, background: '#0000ff', motion: 'fade', enter: 0.35 },
    ],
  };
}

test('graphic and karaoke anchors follow retimed words, and reject invalid visual declarations', () => {
  const project = example();
  project.graphics = [{ id: 'cue', text: 'Anchor', fromWord: 'first', toWord: 'last', motion: 'fade' }];
  const normalized = validateProject(project);
  assert.equal(normalized.graphics[0].start, undefined);
  assert.equal(normalized.graphics[0].enter, undefined);
  assert.equal(resolveGraphics(project)[0].start, 0.35);
  assert.equal(resolveGraphics(project)[0].end, 1.45);
  normalized.words[0].start = 0.4;
  normalized.words[1].end = 1.7;
  assert.equal(resolveGraphics(normalized)[0].start, 0.4);
  assert.equal(resolveGraphics(normalized)[0].end, 1.7);
  assert.equal(resolveCaptions(normalized)[0].karaokeWords[1].end, 1.7);

  for (const invalid of [
    { ...project, graphics: [{ ...project.graphics[0], start: 0 }] },
    { ...project, graphics: [{ ...project.graphics[0], motion: 'ffmpeg-expression' }] },
    { ...project, graphics: [{ ...project.graphics[0], background: 'black:[x]' }] },
    { ...project, graphics: [{ ...project.graphics[0], enter: 1.5 }] },
    { ...project, captions: [{ ...project.captions[0], text: 'Unaligned replacement' }] },
    { ...project, captions: [{ karaoke: true, text: 'No word anchors', start: 0, end: 1 }] },
  ]) {
    assert.throws(() => validateProject(invalid), { code: 'INVALID_PROJECT' });
  }
});

async function frame(file, seconds) {
  const { stdout } = await exec(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v', 'error', '-nostdin', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-pix_fmt', 'rgb24', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true });
  assert.equal(stdout.length, canvas.width * canvas.height * 3);
  return stdout;
}

function region(frame, predicate, top = 0, bottom = canvas.height) {
  let count = 0;
  let x = 0;
  let y = 0;
  for (let row = top; row < bottom; row++) {
    for (let column = 0; column < canvas.width; column++) {
      const index = (row * canvas.width + column) * 3;
      if (!predicate(frame[index], frame[index + 1], frame[index + 2])) continue;
      count++;
      x += column;
      y += row;
    }
  }
  return { count, x: x / count, y: y / count };
}

test('renders literal animated graphic text and highlights the spoken word in the same caption line', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-video-graphics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const project = example();
  const { file } = await renderVideo({ project, root }, { workDir });
  const before = await frame(file, 0.2);
  const first = await frame(file, 0.45);
  const gap = await frame(file, 0.8);
  const last = await frame(file, 1.05);
  const after = await frame(file, 1.5);
  const faded = await frame(file, 1.9);
  const red = (r, g, b) => r > 120 && r > g * 1.75 && r > b * 1.75;
  const green = (r, g, b) => g > 55 && g > r * 1.6 && g > b * 1.6;
  const white = (r, g, b) => Math.min(r, g, b) > 190;
  const blue = (r, g, b) => b > 130 && b > r * 1.7 && b > g * 1.7;

  assert.equal(region(before, red).count, 0);
  assert.equal(region(gap, red).count, 0);
  assert.ok(region(gap, white, 150).count > 40, 'the caption line stays visible during the spoken gap');
  const firstWord = region(first, red, 150);
  const lastWord = region(last, red, 150);
  assert.ok(firstWord.count > 20 && lastWord.count > 20, 'both words receive actual highlight pixels');
  assert.ok(lastWord.x - firstWord.x > 50, 'highlight moves from the first word to the last');
  assert.equal(region(first, green, 150).count, 0, 'literal ASS color syntax must not change caption color');
  assert.equal(region(after, red).count, 0);

  assert.equal(region(before, green, 0, 150).count, 0);
  assert.ok(region(first, green, 0, 150).y > region(last, green, 0, 150).y + 12, 'the title card slides upward');
  assert.equal(region(after, green, 0, 150).count, 0);
  assert.equal(region(after, blue).count, 0);
  assert.ok(region(faded, blue).count > 100, 'the second card fades in with its background');
  assert.equal(await readFile(join(workDir, 'graphic-0.txt'), 'utf8'), project.graphics[0].text);
});
