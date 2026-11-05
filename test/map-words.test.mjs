import assert from 'node:assert/strict';
import test from 'node:test';
import { mapSourceWords } from '../src/map-words.mjs';

const title = { id: 'title', kind: 'color', color: '#121212', duration: 0.44 };
const take = { id: 'take', kind: 'video', src: 'assets/host.mp4', in: 3, duration: 1 };
const make = (...clips) => ({ version: 1, title: 'Cut', canvas: { width: 320, height: 180, fps: 10 }, clips });
const words = { 'assets/host.mp4': [
  { id: 'old', text: 'Skipped', start: 1, end: 2 },
  { id: 'good', text: 'Kept', start: 3.25, end: 3.5 },
] };

test('projects repeated source windows onto the renderer frame grid with distinct anchors', () => {
  const project = mapSourceWords(make(title, take, { ...take, id: 'repeat' }), words);
  assert.equal(project.words.length, 2);
  assert.deepEqual(project.words.map(word => [word.id, word.text, word.start, word.end]), [
    ['w1', 'Kept', 0.65, 0.9], ['w2', 'Kept', 1.65, 1.9],
  ]);
  assert.deepEqual(project.captions.map(caption => [caption.fromWord, caption.toWord]), [['w1', 'w1'], ['w2', 'w2']]);
});

test('refuses split speech, unused transcripts and existing word-dependent clip boundaries', () => {
  assert.throws(() => mapSourceWords(make({ ...take, in: 3.4 }), words), { code: 'CUT_THROUGH_WORD' });
  assert.throws(() => mapSourceWords(make({ ...take, volume: 0 }), words), { code: 'INVALID_WORDS' });
  const { duration, ...clip } = take;
  assert.throws(() => mapSourceWords({ ...make({ ...clip, untilWord: 'w1' }), words: [{ id: 'w1', text: 'Clip', start: 0, end: 1 }] }, words), { code: 'WORD_ANCHORS_IN_USE' });
});

test('reports words in a rounded final frame instead of silently dropping them', () => {
  const clip = { ...take, in: 0, duration: 0.46 };
  const transcript = { [clip.src]: [{ id: 'last', text: 'Tail', start: 0.47, end: 0.49 }] };
  assert.throws(() => mapSourceWords(make(clip), transcript), { code: 'WORD_OUTSIDE_PROJECT' });
});
