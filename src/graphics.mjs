import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const vertical = { top: 'h*0.08', center: '(h-text_h)/2', bottom: 'h*0.88-text_h' };

function drawText(cue, filename, options) {
  return `drawtext=fontfile=caption-font.ttf:textfile=${filename}:expansion=none:fontsize=${cue.fontSize}:fontcolor=${cue.color}:x=(w-text_w)/2:${options}:enable='gte(t,${cue.start})*lt(t,${cue.end})'`;
}

function graphicStyle(graphic) {
  let y = vertical[graphic.position];
  let alpha = '';
  if (graphic.motion !== 'none') {
    const progress = `clip((t-${graphic.start})/${graphic.enter},0,1)`;
    const remaining = `pow(1-${progress},2)`;
    if (graphic.motion === 'slide-up') y = `(${y})+h*0.09*${remaining}`;
    if (graphic.motion === 'fade') alpha = `:alpha='1-${remaining}'`;
  }
  return `y='${y}':box=1:boxcolor=${graphic.background}@0.88:boxborderw=12:fix_bounds=1:text_align=C${alpha}`;
}

function escapeAss(value) {
  return value.replace(/\\|\{|\}|\r\n|\r|\n/g, character => {
    // An invisible joiner prevents a literal backslash starting a subtitle escape.
    if (character === '\\') return '\\\u2060';
    if (character === '{' || character === '}') return `\\${character}`;
    return '\\N';
  });
}

function assColor(rgb) {
  return `&H${rgb.slice(5, 7)}${rgb.slice(3, 5)}${rgb.slice(1, 3)}&`;
}

function assTime(seconds, fps) {
  const frame = Math.ceil(seconds * fps - 1e-9);
  // Put the centisecond boundary between frames so ASS time rounding cannot move it across a frame.
  const ticks = frame <= 0 ? 0 : Math.round((frame - 0.5) * 100 / fps);
  const minutes = String(Math.floor(ticks / 6000) % 60).padStart(2, '0');
  const remainder = String(Math.floor(ticks / 100) % 60).padStart(2, '0');
  const hundredths = String(ticks % 100).padStart(2, '0');
  return `${Math.floor(ticks / 360000)}:${minutes}:${remainder}.${hundredths}`;
}

function karaokeTrack(captions, { width, height, fps }, fontFamily) {
  const margin = Math.max(1, Math.round(width * 0.06));
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontFamily},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,0,0,0,0,100,100,0,0,1,2,1,2,${margin},${margin},0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const [layer, caption] of captions.entries()) {
    const { anchor, fraction } = {
      top: { anchor: 8, fraction: 0.08 },
      center: { anchor: 5, fraction: 0.5 },
      bottom: { anchor: 2, fraction: 0.88 },
    }[caption.position];
    const baseColor = assColor(caption.color);
    const highlightColor = assColor(caption.highlightColor);
    const style = `{\\an${anchor}\\pos(${width / 2},${Math.round(height * fraction)})\\fs${caption.fontSize}\\1c${baseColor}}`;
    const words = caption.karaokeWords.map(word => escapeAss(word.text));
    const add = (start, end, active = -1) => {
      const from = assTime(start, fps);
      const to = assTime(end, fps);
      if (from === to) return;
      const text = words.map((word, index) => index === active ? `{\\1c${highlightColor}}${word}{\\1c${baseColor}}` : word).join(' ');
      lines.push(`Dialogue: ${layer},${from},${to},Caption,,0,0,0,,${style}${text}`);
    };
    let previousEnd = caption.start;
    for (const [index, word] of caption.karaokeWords.entries()) {
      if (word.start > previousEnd) add(previousEnd, word.start);
      add(word.start, word.end, index);
      previousEnd = word.end;
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function writeTextFilters(captions, graphics, canvas, fontFamily, workDir) {
  const filters = [];
  for (const [index, graphic] of graphics.entries()) {
    const filename = `graphic-${index}.txt`;
    await writeFile(join(workDir, filename), graphic.text, { flag: 'wx' });
    filters.push(drawText(graphic, filename, graphicStyle(graphic)));
  }
  const karaoke = [];
  for (const [index, caption] of captions.entries()) {
    if (caption.karaokeWords) {
      karaoke.push(caption);
      continue;
    }
    const filename = `caption-${index}.txt`;
    await writeFile(join(workDir, filename), caption.text, { flag: 'wx' });
    filters.push(drawText(caption, filename, `y=${vertical[caption.position]}:box=1:boxcolor=black@0.55:boxborderw=12`));
  }
  if (karaoke.length) {
    await writeFile(join(workDir, 'karaoke.ass'), karaokeTrack(karaoke, canvas, fontFamily), { flag: 'wx' });
    filters.push('ass=filename=karaoke.ass');
  }
  return filters;
}
