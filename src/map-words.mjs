import { groupWordCaptions, validateTimedWords } from './captions.mjs';
import { ProjectError, validateProject } from './project.mjs';

const tolerance = 1e-9;

export function mapSourceWords(project, transcripts, { groupSize = 4, karaoke = false } = {}) {
  const base = validateProject(project);
  if (base.clips.some(clip => clip.untilWord !== undefined)
    || base.overlays.some(overlay => overlay.fromWord !== undefined)
    || base.graphics?.some(graphic => graphic.fromWord !== undefined)) {
    throw new ProjectError('WORD_ANCHORS_IN_USE', 'Map words before adding word-linked cuts, overlays, or graphics. Existing anchors need explicit retiming.');
  }
  if (!transcripts || ![Object.prototype, null].includes(Object.getPrototypeOf(transcripts)) || !Object.keys(transcripts).length) {
    throw new ProjectError('INVALID_WORDS', 'Supply an object mapping video asset paths to source-clock word arrays.');
  }
  const spokenAssets = new Set(base.clips.filter(clip => clip.kind === 'video' && clip.volume > 0).map(clip => clip.src));
  for (const [path, words] of Object.entries(transcripts)) {
    if (!spokenAssets.has(path)) throw new ProjectError('INVALID_WORDS', `No audible video clip uses ${path}.`);
    validateTimedWords(words);
  }
  const total = base.clips.reduce((sum, clip) => sum + clip.duration, 0);
  const { fps } = base.canvas;
  const words = [];
  const captions = base.captions.filter(caption => caption.fromWord === undefined);
  let elapsed = 0;
  for (const clip of base.clips) {
    const outputStart = Math.round(elapsed * fps) / fps;
    elapsed += clip.duration;
    if (clip.kind !== 'video' || clip.volume === 0 || !Object.hasOwn(transcripts, clip.src)) continue;
    const outputEnd = Math.round(elapsed * fps) / fps;
    const sourceEnd = clip.in + (outputEnd - outputStart);
    const clipWords = [];
    for (const word of transcripts[clip.src]) {
      if (word.end <= clip.in + tolerance || word.start >= sourceEnd - tolerance) continue;
      if (word.start < clip.in - tolerance || word.end > sourceEnd + tolerance) {
        throw new ProjectError('CUT_THROUGH_WORD', `Clip ${clip.id} cuts through ${JSON.stringify(word.text)} in ${clip.src}. Move the cut to a speech gap.`);
      }
      const mapped = { id: `w${words.length + 1}`, text: word.text,
        start: Math.max(outputStart, outputStart + (word.start - clip.in)),
        end: Math.min(outputEnd, outputStart + (word.end - clip.in)) };
      if (mapped.end > total + tolerance) {
        throw new ProjectError('WORD_OUTSIDE_PROJECT', `The rendered final frame overlaps ${JSON.stringify(word.text)} beyond the declared duration. Set the last clip boundary on a frame in a speech gap.`);
      }
      clipWords.push(mapped);
      words.push(mapped);
    }
    captions.push(...groupWordCaptions(clipWords, groupSize, { karaoke }));
  }
  if (!words.length) throw new ProjectError('INVALID_WORDS', 'None of the supplied words fall inside the selected video windows.');
  return validateProject({ ...base, words, captions });
}
