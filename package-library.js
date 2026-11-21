#!/usr/bin/env node
'use strict';

/**
 * Quiver Library Packager -> .qpack (QPK1 Binary Format)
 *
 * Zero npm dependencies (uses Node.js built-ins + optional ffmpeg for image/audio compaction).
 * Packs an entire Steam Quaver Songs/ directory into a single hyper-compact .qpack file that
 * Quiver (quaver-browser.html) opens in ~40ms using lazy File.slice() byte-offset streaming.
 *
 * Usage:
 *   node package-library.js                                  (default: lossless MP3 copy + 1280px HD JPEG BGs)
 *   node package-library.js --audio ogg --bitrate 96k        (ultra-compact ~120 MB, zero-delay Vorbis audio)
 *   node package-library.js --no-bg                          (omit backgrounds — saves ~114 MB, 0% gameplay BG anyway)
 *   node package-library.js --mode 4k                        (pack only 4K charts)
 *   node package-library.js --songs "D:\Quaver\Songs" --out "my-pack.qpack"
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RATE_COLS = [
  'Difficulty05X','Difficulty055X','Difficulty06X','Difficulty065X','Difficulty07X','Difficulty075X',
  'Difficulty08X','Difficulty085X','Difficulty09X','Difficulty095X','Difficulty10X','Difficulty105X',
  'Difficulty11X','Difficulty115X','Difficulty12X','Difficulty125X','Difficulty13X','Difficulty135X',
  'Difficulty14X','Difficulty145X','Difficulty15X','Difficulty155X','Difficulty16X','Difficulty165X',
  'Difficulty17X','Difficulty175X','Difficulty18X','Difficulty185X','Difficulty19X','Difficulty195X',
  'Difficulty20X'
];

function loadQuaverDbMap(songsDir) {
  const dbPath = path.join(path.dirname(songsDir), 'quaver.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const sql = `SELECT Directory, Path, Md5Checksum, SongLength, LocalOffset, ${RATE_COLS.join(', ')} FROM Map`;
    const rows = db.prepare(sql).all();
    db.close();
    const byRel = new Map();
    const byMd5 = new Map();
    for (const r of rows) {
      const rates = RATE_COLS.map(c => Math.round((Number(r[c]) || 0) * 100) / 100);
      const rec = {
        rates,
        dr10: rates[10], // 1.00x
        songLength: Math.round(Number(r.SongLength) || 0),
        localOffset: Math.round(Number(r.LocalOffset) || 0)
      };
      if (r.Directory && r.Path) byRel.set((r.Directory + '/' + r.Path).toLowerCase(), rec);
      if (r.Md5Checksum) byMd5.set(String(r.Md5Checksum).toLowerCase(), rec);
    }
    return { dbPath, byRel, byMd5 };
  } catch {
    return null;
  }
}

/* -------------------- CLI ARGUMENTS -------------------- */
function parseArgs(argv) {
  const opts = {
    songsDir: null,
    outPath: path.resolve(__dirname, 'quaver-library.qpack'),
    audioMode: 'copy',   // 'copy' (0ms timing drift) | 'ogg' (zero-delay Vorbis, tiny) | 'mp3'
    bitrate: '96k',
    bgWidth: 1280,       // HD crisp full-screen Song Select BGs (0 = omit backgrounds)
    bgQuality: 5,        // ffmpeg JPEG q:v (2=best .. 10=smallest)
    modeFilter: 'all',   // 'all' | '4k' | '7k'
    includeSfx: true
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--songs' && argv[i + 1]) opts.songsDir = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) opts.outPath = path.resolve(argv[++i]);
    else if (a === '--audio' && argv[i + 1]) opts.audioMode = argv[++i].toLowerCase();
    else if (a === '--bitrate' && argv[i + 1]) opts.bitrate = argv[++i];
    else if (a === '--bg-width' && argv[i + 1]) opts.bgWidth = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--no-bg') opts.bgWidth = 0;
    else if (a === '--no-sfx') opts.includeSfx = false;
    else if (a === '--mode' && argv[i + 1]) opts.modeFilter = argv[++i].toLowerCase();
    else if (a === '--help' || a === '-h') {
      console.log([
        'Quiver Library Packager (.qpack)',
        '',
        'Options:',
        '  --songs <dir>       Path to Quaver/Songs folder (auto-detected from Steam by default)',
        '  --out <file>        Output .qpack path (default: ./quaver-library.qpack)',
        '  --audio <mode>      copy (default, 0ms drift) | ogg (tiny Vorbis) | mp3',
        '  --bitrate <rate>    Audio bitrate when re-encoding (default: 96k)',
        '  --bg-width <px>     Resize backgrounds to width px JPEG (default: 1280, 0 = skip)',
        '  --no-bg             Omit background images completely',
        '  --no-sfx            Omit custom map WAV keysounds',
        '  --mode <filter>     all (default) | 4k | 7k'
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

function detectQuaverSongsDir() {
  const candidates = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Quaver\\Songs',
    'C:\\Program Files\\Steam\\steamapps\\common\\Quaver\\Songs',
    'D:\\SteamLibrary\\steamapps\\common\\Quaver\\Songs',
    'E:\\SteamLibrary\\steamapps\\common\\Quaver\\Songs'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/* -------------------- SHARED HASH & .QUA PARSER -------------------- */
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function fnv1aHash(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'));
}

function unquoteYaml(val) {
  const s = val.trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return s;
}

function parseScalar(val) {
  const t = val.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"')) return unquoteYaml(t);
  const n = Number(t);
  if (!Number.isNaN(n) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return n;
  return t;
}

function splitKeyVal(line) {
  const idx = line.indexOf(':');
  return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function parseQua(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const chart = {
    hash: fnv1aHash(text),
    audioFile: 'audio.mp3',
    songPreviewTime: 0,
    backgroundFile: '',
    keyCount: 4,
    title: 'Untitled',
    artist: 'Unknown',
    source: '',
    tags: '',
    creator: 'Unknown',
    difficultyName: 'Normal',
    bpmDoesNotAffectScrollVelocity: false,
    initialScrollVelocity: 1.0,
    customAudioSamples: [],
    soundEffects: [],
    timingPoints: [],
    sliderVelocities: [],
    scrollSpeedFactors: [],
    timingGroups: {},
    hitObjects: []
  };

  let section = null, curItem = null, subArray = null, curSubItem = null, curGroupId = null, curGroupSub = null;
  let sectionListIndent = -1, subListIndent = -1;

  function applyField(sec, item, key, rawVal) {
    const v = parseScalar(rawVal);
    if (sec === 'TimingPoints') {
      if (key === 'StartTime') item.startTime = Number(v) || 0;
      else if (key === 'Bpm') item.bpm = Number(v) || 120;
      else if (key === 'Signature') item.signature = Number(v) || 4;
      else if (key === 'Hidden') item.hidden = Boolean(v);
    } else if (sec === 'SliderVelocities' || sec === 'ScrollSpeedFactors') {
      if (key === 'StartTime') item.startTime = Number(v) || 0;
      else if (key === 'Multiplier') { const n = Number(v); item.multiplier = Number.isFinite(n) ? n : 1; }
    } else if (sec === 'CustomAudioSamples') {
      if (key === 'Path') item.path = String(v || '');
    } else if (sec === 'SoundEffects') {
      if (key === 'StartTime') item.startTime = Number(v) || 0;
      else if (key === 'Sample') item.sample = Number(v) || 1;
      else if (key === 'Volume') item.volume = Number(v) || 100;
    } else if (sec === 'HitObjects') {
      if (key === 'StartTime') item.startTime = Number(v) || 0;
      else if (key === 'Lane') item.lane = Number(v) || 1;
      else if (key === 'EndTime') item.endTime = Number(v) || 0;
      else if (key === 'HitSound') item.hitSound = String(v || 'Normal');
      else if (key === 'TimingGroup') item.timingGroup = v ? String(v) : null;
      else if (key === 'Type') item.type = String(v || 'Normal');
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.trim() === '' || raw.trim().startsWith('#')) continue;
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    const trimmed = raw.slice(indent);

    if (indent === 0 && !trimmed.startsWith('-')) {
      const kv = splitKeyVal(trimmed);
      if (!kv) continue;
      const [key, rawVal] = kv;
      curItem = null; subArray = null; curSubItem = null; curGroupId = null; curGroupSub = null;
      sectionListIndent = -1; subListIndent = -1;
      if (rawVal === '' || rawVal === '[]' || rawVal === '{}') { section = key; continue; }
      section = null;
      const v = parseScalar(rawVal);
      if (key === 'AudioFile') chart.audioFile = String(v || 'audio.mp3');
      else if (key === 'SongPreviewTime') chart.songPreviewTime = Number(v) || 0;
      else if (key === 'BackgroundFile') chart.backgroundFile = String(v || '');
      else if (key === 'Mode') { const m = /Keys(\d+)/i.exec(String(v)); chart.keyCount = m ? clamp(parseInt(m[1], 10), 1, 10) : 4; }
      else if (key === 'Title') chart.title = String(v || 'Untitled');
      else if (key === 'Artist') chart.artist = String(v || 'Unknown');
      else if (key === 'Source') chart.source = String(v || '');
      else if (key === 'Tags') chart.tags = String(v || '');
      else if (key === 'Creator') chart.creator = String(v || 'Unknown');
      else if (key === 'DifficultyName') chart.difficultyName = String(v || 'Normal');
      else if (key === 'BPMDoesNotAffectScrollVelocity') chart.bpmDoesNotAffectScrollVelocity = Boolean(v);
      else if (key === 'InitialScrollVelocity') { const n = Number(v); chart.initialScrollVelocity = Number.isFinite(n) ? n : 1.0; }
      continue;
    }

    if (section === 'TimingGroups') {
      if (indent === 2 && !trimmed.startsWith('-')) {
        const kv = splitKeyVal(trimmed);
        if (kv) { curGroupId = unquoteYaml(kv[0]); chart.timingGroups[curGroupId] = { initialScrollVelocity: 1.0, scrollVelocities: [], scrollSpeedFactors: [] }; curGroupSub = null; curItem = null; }
        continue;
      }
      if (!curGroupId) continue;
      const grp = chart.timingGroups[curGroupId];
      if (indent === 4 && !trimmed.startsWith('-')) {
        const kv = splitKeyVal(trimmed);
        if (kv) {
          if (kv[0] === 'InitialScrollVelocity') grp.initialScrollVelocity = Number(parseScalar(kv[1])) || 1.0;
          else if (kv[0] === 'ScrollVelocities' || kv[0] === 'ScrollSpeedFactors') { curGroupSub = kv[0]; curItem = null; }
        }
        continue;
      }
      if (trimmed.startsWith('-')) {
        curItem = { startTime: 0, multiplier: 1 };
        if (curGroupSub === 'ScrollVelocities') grp.scrollVelocities.push(curItem);
        else if (curGroupSub === 'ScrollSpeedFactors') grp.scrollSpeedFactors.push(curItem);
        const kv = splitKeyVal(trimmed.slice(1).trim());
        if (kv) {
          if (kv[0] === 'StartTime') curItem.startTime = Number(parseScalar(kv[1])) || 0;
          else if (kv[0] === 'Multiplier') curItem.multiplier = Number(parseScalar(kv[1]));
        }
      } else if (curItem) {
        const kv = splitKeyVal(trimmed);
        if (kv) {
          if (kv[0] === 'StartTime') curItem.startTime = Number(parseScalar(kv[1])) || 0;
          else if (kv[0] === 'Multiplier') curItem.multiplier = Number(parseScalar(kv[1]));
        }
      }
      continue;
    }

    if (trimmed.startsWith('-')) {
      if (sectionListIndent === -1) sectionListIndent = indent;
      if (indent === sectionListIndent) {
        subArray = null; curSubItem = null; subListIndent = -1;
        const kv = splitKeyVal(trimmed.slice(1).trim());
        if (section === 'TimingPoints') { curItem = { startTime: 0, bpm: 120, signature: 4, hidden: false }; chart.timingPoints.push(curItem); }
        else if (section === 'SliderVelocities') { curItem = { startTime: 0, multiplier: 1 }; chart.sliderVelocities.push(curItem); }
        else if (section === 'ScrollSpeedFactors') { curItem = { startTime: 0, multiplier: 1 }; chart.scrollSpeedFactors.push(curItem); }
        else if (section === 'CustomAudioSamples') { curItem = { path: '' }; chart.customAudioSamples.push(curItem); }
        else if (section === 'SoundEffects') { curItem = { startTime: 0, sample: 1, volume: 100 }; chart.soundEffects.push(curItem); }
        else if (section === 'HitObjects') { curItem = { startTime: 0, lane: 1, endTime: 0, hitSound: 'Normal', keySounds: null, timingGroup: null, type: 'Normal' }; chart.hitObjects.push(curItem); }
        else curItem = null;
        if (curItem && kv) applyField(section, curItem, kv[0], kv[1]);
        continue;
      }
      if (indent > sectionListIndent && section === 'HitObjects' && curItem && subArray === 'KeySounds') {
        subListIndent = indent;
        curSubItem = { sample: 1, volume: 100 };
        if (!curItem.keySounds) curItem.keySounds = [];
        curItem.keySounds.push(curSubItem);
        const kv = splitKeyVal(trimmed.slice(1).trim());
        if (kv) {
          if (kv[0] === 'Sample') curSubItem.sample = Number(parseScalar(kv[1])) || 1;
          else if (kv[0] === 'Volume') curSubItem.volume = Number(parseScalar(kv[1])) || 100;
        }
        continue;
      }
      continue;
    }

    if (curSubItem && subListIndent >= 0 && indent > subListIndent) {
      const kv = splitKeyVal(trimmed);
      if (kv) {
        if (kv[0] === 'Sample') curSubItem.sample = Number(parseScalar(kv[1])) || 1;
        else if (kv[0] === 'Volume') curSubItem.volume = Number(parseScalar(kv[1])) || 100;
      }
      continue;
    }
    if (curItem) {
      const kv = splitKeyVal(trimmed);
      if (kv) {
        if (section === 'HitObjects' && kv[0] === 'KeySounds') { subArray = kv[1] === '' ? 'KeySounds' : null; curSubItem = null; subListIndent = -1; }
        else { subArray = null; curSubItem = null; subListIndent = -1; applyField(section, curItem, kv[0], kv[1]); }
      }
    }
  }

  if (chart.timingPoints.length === 0) chart.timingPoints.push({ startTime: 0, bpm: 120, signature: 4, hidden: false });
  chart.timingPoints.sort((a, b) => a.startTime - b.startTime);
  chart.sliderVelocities.sort((a, b) => a.startTime - b.startTime);
  chart.scrollSpeedFactors = chart.scrollSpeedFactors.map((s, i) => ({ ...s, _i: i })).sort((a, b) => a.startTime - b.startTime || a._i - b._i).map(({ startTime, multiplier }) => ({ startTime, multiplier }));
  chart.hitObjects.sort((a, b) => a.startTime - b.startTime || a.lane - b.lane);
  chart.soundEffects.sort((a, b) => a.startTime - b.startTime);

  return chart;
}

function estimateDR(chart) {
  const notes = chart.hitObjects.filter(o => o.type !== 'Mine');
  if (!notes.length) return { dr: 0, peakNps: 0, avgNps: 0 };
  const k = chart.keyCount;
  const firstT = notes[0].startTime;
  const lastT = notes.reduce((m, o) => Math.max(m, o.endTime > o.startTime ? o.endTime : o.startTime), firstT);
  const durSec = Math.max(1, (lastT - firstT) / 1000);
  const avgNps = notes.length / durSec;

  let peakNps = 0, wStart = 0, prevT = -1e9, chordCount = 0;
  const laneLast = new Float64Array(k + 1).fill(-1e9);
  const handLast = [-1e9, -1e9];
  const splitLane = Math.ceil(k / 2);
  const numBuckets = Math.max(1, Math.ceil((lastT - firstT + 1) / 500));
  const buckets = new Float64Array(numBuckets);

  for (let i = 0; i < notes.length; i++) {
    const o = notes[i];
    const t = o.startTime;
    while (wStart < i && notes[wStart].startTime < t - 1000) wStart++;
    if (i - wStart + 1 > peakNps) peakNps = i - wStart + 1;
    const lane = clamp(o.lane, 1, k);
    const hand = lane <= splitLane ? 0 : 1;
    const dtLane = Math.max(25, t - laneLast[lane]);
    const dtHand = Math.max(20, t - handLast[hand]);
    if (Math.abs(t - prevT) < 12) chordCount++; else chordCount = 1;
    const strain = (145 / Math.pow(dtLane, 0.78) * 0.55 + 95 / Math.pow(dtHand, 0.72) * 0.45) * (1 + 0.22 * (chordCount - 1)) * (o.endTime > o.startTime ? 1.24 : 1.0);
    buckets[clamp(Math.floor((t - firstT) / 500), 0, numBuckets - 1)] += strain;
    laneLast[lane] = t; handLast[hand] = t; prevT = t;
  }
  const sorted = Array.from(buckets).sort((a, b) => b - a);
  let weighted = 0, wSum = 0, decay = 1.0;
  for (let i = 0; i < Math.min(sorted.length, 48); i++) { weighted += sorted[i] * decay; wSum += decay; decay *= 0.935; }
  const base = wSum > 0 ? weighted / wSum : 0;
  const keyFactor = k === 4 ? 1.0 : (k === 7 ? 1.05 : 0.94 + k * 0.015);
  return {
    dr: Math.round(Math.pow(base, 0.66) * 1.48 * keyFactor * 100) / 100,
    peakNps: Math.round(peakNps * 10) / 10,
    avgNps: Math.round(avgNps * 10) / 10
  };
}

function compactChart(ch, dbRec) {
  let lnCount = 0, mineCount = 0, lastTime = 0;
  for (const o of ch.hitObjects) {
    o.lane = clamp(o.lane, 1, ch.keyCount);
    if (o.type === 'Mine') mineCount++;
    else if (o.endTime > o.startTime) lnCount++;
    const end = o.endTime > o.startTime ? o.endTime : o.startTime;
    if (end > lastTime) lastTime = end;
  }

  // Dominant BPM
  let domBpm = ch.timingPoints[0].bpm || 120;
  if (ch.timingPoints.length > 1) {
    const map = new Map();
    for (let i = 0; i < ch.timingPoints.length; i++) {
      const tp = ch.timingPoints[i];
      const nxt = i + 1 < ch.timingPoints.length ? ch.timingPoints[i + 1].startTime : Math.max(lastTime, tp.startTime + 1000);
      const key = Math.round(tp.bpm * 100) / 100;
      map.set(key, (map.get(key) || 0) + Math.max(0, nxt - tp.startTime));
    }
    let best = -1;
    for (const [b, d] of map.entries()) if (d > best) { best = d; domBpm = b; }
  }

  const totalNormal = ch.hitObjects.length - mineCount;
  const stats = estimateDR(ch);
  const officialDR = (dbRec && dbRec.dr10 > 0) ? dbRec.dr10 : stats.dr;
  const lengthMs = Math.max(Math.round(lastTime), (dbRec && dbRec.songLength) ? dbRec.songLength : 0);
  const meta = {
    dominantBpm: Math.round(domBpm * 10) / 10,
    lengthMs,
    objectCount: totalNormal,
    lnCount,
    lnRatio: totalNormal > 0 ? Math.round((lnCount / totalNormal) * 100) : 0,
    mineCount,
    hasSV: ch.sliderVelocities.some(s => Math.abs(s.multiplier - 1) > 0.001) || ch.scrollSpeedFactors.length > 0 || ch.timingPoints.length > 1,
    dr: officialDR,
    peakNps: stats.peakNps,
    avgNps: stats.avgNps
  };

  // Delta-encode hit objects for ultra-tight deflate compression
  let prevT = 0;
  const ho = [];
  for (const o of ch.hitObjects) {
    const t = Math.round(o.startTime * 10) / 10;
    const dt = Math.round((t - prevT) * 10) / 10;
    prevT = t;
    const dur = o.endTime > o.startTime ? Math.round((o.endTime - o.startTime) * 10) / 10 : 0;
    const hasExtra = (o.hitSound && o.hitSound !== 'Normal') || (o.keySounds && o.keySounds.length) || o.timingGroup || o.type === 'Mine';
    if (hasExtra) {
      const ex = {};
      if (o.hitSound && o.hitSound !== 'Normal') ex.hs = o.hitSound;
      if (o.keySounds && o.keySounds.length) ex.ks = o.keySounds.map(k => [k.sample, k.volume]);
      if (o.timingGroup) ex.tg = o.timingGroup;
      if (o.type === 'Mine') ex.m = 1;
      ho.push([dt, o.lane, dur, ex]);
    } else if (dur > 0) {
      ho.push([dt, o.lane, dur]);
    } else {
      ho.push([dt, o.lane]);
    }
  }

  const out = {
    h: ch.hash,
    m: ch.keyCount,
    d: ch.difficultyName,
    p: Math.round(ch.songPreviewTime || 0),
    meta,
    tp: ch.timingPoints.map(tp => {
      const a = [tp.startTime, tp.bpm];
      if (tp.signature !== 4 || tp.hidden) a.push(tp.signature || 4);
      if (tp.hidden) a.push(1);
      return a;
    }),
    ho
  };
  if (dbRec && dbRec.rates) out.drR = dbRec.rates;
  if (dbRec && dbRec.localOffset) out.lo = dbRec.localOffset;
  if (ch.source) out.s = ch.source;
  if (ch.tags) out.g = ch.tags;
  if (ch.bpmDoesNotAffectScrollVelocity) out.bna = 1;
  if (ch.initialScrollVelocity !== 1) out.isv = ch.initialScrollVelocity;
  if (ch.sliderVelocities.length) out.sv = ch.sliderVelocities.map(s => [s.startTime, s.multiplier]);
  if (ch.scrollSpeedFactors.length) out.ssf = ch.scrollSpeedFactors.map(s => [s.startTime, s.multiplier]);
  if (Object.keys(ch.timingGroups).length) out.tg = ch.timingGroups;
  if (ch.customAudioSamples.length) out.cs = ch.customAudioSamples.map(c => c.path);
  if (ch.soundEffects.length) out.se = ch.soundEffects.map(s => [s.startTime, s.sample, s.volume]);
  return out;
}

/* -------------------- MEDIA HELPERS (FFMPEG OPTIONAL) -------------------- */
function mimeFromExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
  })[ext] || 'application/octet-stream';
}

function processBackground(filePath, bgWidth, bgQuality, useFfmpeg) {
  if (!bgWidth) return null;
  if (!useFfmpeg) return { buf: fs.readFileSync(filePath), mime: mimeFromExt(filePath), name: path.basename(filePath) };
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', filePath,
    '-vf', `scale='min(${bgWidth},iw)':-2:flags=lanczos`,
    '-frames:v', '1', '-f', 'mjpeg', '-q:v', String(bgQuality), 'pipe:1'
  ], { maxBuffer: 16 * 1024 * 1024 });
  if (r.status === 0 && r.stdout && r.stdout.length > 200) {
    return { buf: r.stdout, mime: 'image/jpeg', name: path.parse(filePath).name + '.jpg' };
  }
  return { buf: fs.readFileSync(filePath), mime: mimeFromExt(filePath), name: path.basename(filePath) };
}

function processAudio(filePath, audioMode, bitrate, useFfmpeg) {
  if (audioMode === 'copy' || !useFfmpeg) {
    return { buf: fs.readFileSync(filePath), mime: mimeFromExt(filePath), name: path.basename(filePath) };
  }
  if (audioMode === 'ogg') {
    const r = spawnSync('ffmpeg', [
      '-v', 'error', '-i', filePath, '-vn',
      '-c:a', 'libvorbis', '-b:a', bitrate, '-f', 'ogg', 'pipe:1'
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 1000) {
      return { buf: r.stdout, mime: 'audio/ogg', name: path.parse(filePath).name + '.ogg' };
    }
  } else if (audioMode === 'mp3') {
    const r = spawnSync('ffmpeg', [
      '-v', 'error', '-i', filePath, '-vn',
      '-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 1000) {
      return { buf: r.stdout, mime: 'audio/mpeg', name: path.parse(filePath).name + '.mp3' };
    }
  }
  return { buf: fs.readFileSync(filePath), mime: mimeFromExt(filePath), name: path.basename(filePath) };
}

/* -------------------- MAIN PACKAGER -------------------- */
function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv);
  const songsDir = opts.songsDir || detectQuaverSongsDir();
  if (!songsDir || !fs.existsSync(songsDir)) {
    console.error('Could not locate Quaver Songs folder. Pass --songs "C:\\path\\to\\Quaver\\Songs"');
    process.exit(1);
  }
  const ffmpegOk = hasFfmpeg();
  const dbMap = loadQuaverDbMap(songsDir);
  console.log(`Source:   ${songsDir}`);
  console.log(`Output:   ${opts.outPath}`);
  console.log(`Options:  audio=${opts.audioMode}${opts.audioMode !== 'copy' ? ' (' + opts.bitrate + ')' : ' (0ms drift)'} | bg=${opts.bgWidth ? opts.bgWidth + 'px JPEG' : 'omitted'} | mode=${opts.modeFilter} | ffmpeg=${ffmpegOk ? 'yes' : 'no'} | quaver.db=${dbMap ? 'matched (' + dbMap.byRel.size + ' entries)' : 'not found'}`);
  console.log('');

  const subdirs = fs.readdirSync(songsDir, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  // Stats
  let origQuaBytes = 0, origAudioBytes = 0, origBgBytes = 0, origSfxBytes = 0;
  let packAudioBytes = 0, packBgBytes = 0, packSfxBytes = 0;
  let totalCharts = 0, officialDrMatched = 0;

  const mapsets = [];
  const dataChunks = [];
  let dataCursor = 0;

  function pushBlob(buf) {
    const off = dataCursor;
    dataChunks.push(buf);
    dataCursor += buf.length;
    return [off, buf.length];
  }

  for (let i = 0; i < subdirs.length; i++) {
    const dirName = subdirs[i].name;
    const dirPath = path.join(songsDir, dirName);
    const files = fs.readdirSync(dirPath, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name);
    const byLower = new Map();
    for (const f of files) byLower.set(f.toLowerCase(), path.join(dirPath, f));

    const quaNames = files.filter(f => f.toLowerCase().endsWith('.qua'));
    if (!quaNames.length) continue;

    const parsed = [];
    for (const qn of quaNames) {
      const full = path.join(dirPath, qn);
      const rawBuf = fs.readFileSync(full);
      origQuaBytes += rawBuf.length;
      try {
        const ch = parseQua(rawBuf.toString('utf8'));
        if (!ch.hitObjects.length) continue;
        if (opts.modeFilter === '4k' && ch.keyCount !== 4) continue;
        if (opts.modeFilter === '7k' && ch.keyCount !== 7) continue;
        let dbRec = null;
        if (dbMap) {
          dbRec = dbMap.byRel.get((dirName + '/' + qn).toLowerCase()) || null;
          if (!dbRec) {
            const md5 = crypto.createHash('md5').update(rawBuf).digest('hex');
            dbRec = dbMap.byMd5.get(md5) || null;
          }
          if (dbRec) officialDrMatched++;
        }
        parsed.push({ ch, dbRec });
      } catch (err) {
        console.warn(`  [warn] failed to parse ${dirName}/${qn}: ${err.message}`);
      }
    }
    if (!parsed.length) continue;

    const compactCharts = parsed.map(({ ch, dbRec }) => compactChart(ch, dbRec)).sort((a, b) => a.m - b.m || a.meta.dr - b.meta.dr);
    const first = parsed[0].ch;

    // Match audio
    const findFile = (wanted, regex) => {
      if (wanted) {
        const clean = wanted.replace(/\\/g, '/').split('/').pop().toLowerCase();
        if (byLower.has(clean)) return byLower.get(clean);
      }
      if (regex) {
        for (const [k, p] of byLower.entries()) if (regex.test(k)) return p;
      }
      return null;
    };

    const audioPath = findFile(first.audioFile, /\.(mp3|ogg|wav|flac|m4a)$/);
    if (!audioPath) {
      console.warn(`  [skip] ${dirName}: missing audio (${first.audioFile})`);
      continue;
    }

    origAudioBytes += fs.statSync(audioPath).size;
    const audioRes = processAudio(audioPath, opts.audioMode, opts.bitrate, ffmpegOk);
    packAudioBytes += audioRes.buf.length;
    const [auOff, auLen] = pushBlob(audioRes.buf);

    let bgRef = null;
    const bgPath = findFile(first.backgroundFile, /\.(jpg|jpeg|png|webp)$/);
    if (bgPath) {
      origBgBytes += fs.statSync(bgPath).size;
      if (opts.bgWidth > 0) {
        const bgRes = processBackground(bgPath, opts.bgWidth, opts.bgQuality, ffmpegOk);
        if (bgRes) {
          packBgBytes += bgRes.buf.length;
          const [bgOff, bgLen] = pushBlob(bgRes.buf);
          bgRef = [bgOff, bgLen, bgRes.mime, bgRes.name];
        }
      }
    }

    // Referenced custom audio samples
    let sxMap = null;
    if (opts.includeSfx) {
      const wantedSfx = new Set();
      for (const { ch } of parsed) {
        for (const cs of ch.customAudioSamples) {
          if (cs.path) wantedSfx.add(cs.path.replace(/\\/g, '/').split('/').pop().toLowerCase());
        }
      }
      for (const base of wantedSfx) {
        if (byLower.has(base)) {
          const sp = byLower.get(base);
          const sBuf = fs.readFileSync(sp);
          origSfxBytes += sBuf.length;
          packSfxBytes += sBuf.length;
          const [sOff, sLen] = pushBlob(sBuf);
          if (!sxMap) sxMap = {};
          sxMap[base] = [sOff, sLen, mimeFromExt(base)];
        }
      }
    }

    const setId = fnv1aHash((first.title + '|' + first.artist + '|' + first.creator + '|' + dirName).toLowerCase());
    const entry = {
      id: setId,
      t: first.title,
      a: first.artist,
      c: first.creator,
      au: [auOff, auLen, audioRes.mime, audioRes.name],
      ch: compactCharts
    };
    if (bgRef) entry.bg = bgRef;
    if (sxMap) entry.sx = sxMap;
    mapsets.push(entry);
    totalCharts += compactCharts.length;

    if ((i + 1) % 15 === 0 || i === subdirs.length - 1) {
      process.stdout.write(`\rPacking mapsets: ${i + 1}/${subdirs.length} (${totalCharts} charts)...`);
    }
  }
  console.log('\n');

  // Build & deflate compact JSON index
  const indexObj = { v: 1, created: Date.now(), mapsets };
  const indexRaw = Buffer.from(JSON.stringify(indexObj), 'utf8');
  const indexComp = zlib.deflateRawSync(indexRaw, { level: 9 });

  // 16-byte QPK1 header
  const header = Buffer.alloc(16);
  header.write('QPK1', 0, 'ascii');
  header.writeUInt32LE(indexComp.length, 4);
  header.writeUInt32LE(indexRaw.length, 8);
  header.writeUInt32LE(1, 12); // bit 0 = deflate-raw index

  // Write single .qpack file cleanly via streaming write
  const ws = fs.openSync(opts.outPath, 'w');
  try {
    fs.writeSync(ws, header);
    fs.writeSync(ws, indexComp);
    for (const chunk of dataChunks) fs.writeSync(ws, chunk);
  } finally {
    fs.closeSync(ws);
  }

  const finalSize = header.length + indexComp.length + dataCursor;
  const origTotal = origQuaBytes + origAudioBytes + origBgBytes + origSfxBytes;
  const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
  const pct = (a, b) => a > 0 ? ((1 - b / a) * 100).toFixed(1) + '%' : '0%';

  console.log('=== QPACK PACKAGING COMPLETE ===');
  console.log(`Mapsets:     ${mapsets.length} (${totalCharts} charts, ${officialDrMatched}/${totalCharts} exact official Quaver DRs from quaver.db)`);
  console.log(`Charts:      ${mb(origQuaBytes)} raw .qua  ->  ${mb(indexComp.length)} deflated QPK1 index (-${pct(origQuaBytes, indexComp.length)})`);
  console.log(`Backgrounds: ${mb(origBgBytes)} raw       ->  ${mb(packBgBytes)} packed (-${pct(origBgBytes, packBgBytes)})`);
  console.log(`Audio:       ${mb(origAudioBytes)} raw       ->  ${mb(packAudioBytes)} packed (-${pct(origAudioBytes, packAudioBytes)})`);
  console.log(`Custom SFX:  ${mb(origSfxBytes)} raw       ->  ${mb(packSfxBytes)} packed`);
  console.log(`TOTAL:       ${mb(origTotal)}           ->  ${mb(finalSize)} (-${pct(origTotal, finalSize)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\nDrop "${path.basename(opts.outPath)}" into quaver-browser.html (or click Import Mapsets) for instant <50ms loading!`);
}

main();
