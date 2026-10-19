// transcript.js — transcricoes por video (estilo "Transcription" do DaVinci
// Resolve): cada palavra tem tempo, clicar no texto leva o player ate ali.
//
// Formatos aceitos (detectados pelo conteudo):
//   - JSON do script "Export to Fframe" do Resolve (tools/) — por palavra
//   - JSON no formato do GetTranscription() do Resolve (segments/words com TC)
//   - SRT, WebVTT
//   - TXT exportado do Resolve (linhas com timecode, opcionalmente speaker)
// O JSON do script tambem traz os MARCADORES do clipe, que viram comentarios
// (ver apply() e store.syncMarkerComments).
// SRT/VTT/TXT so tem tempo por frase: as palavras recebem tempos aproximados
// (distribuidos pelo tamanho de cada palavra) e ficam marcadas `approx`.
//
// Guardado em data/transcripts/<assetId>.json. Os tempos ficam em "segundos de
// timecode" (HH:MM:SS + FF/base); a leitura converte para tempo real com
// `fps` (23.976 vs 24 da ~1,7s de diferenca em 28 min) e aplica `offset`.

const fs = require("fs");
const path = require("path");
const store = require("./store");

const DIR = path.join(store.DATA_DIR, "transcripts");
fs.mkdirSync(DIR, { recursive: true });
const fileFor = (id) => path.join(DIR, String(id).replace(/[^a-zA-Z0-9-]/g, "") + ".json");

const SILENCE = /^\s*\((\.\.\.|…|blank audio|silence|music|inaudible)\)\s*$/i;
const FPS_OK = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60];
const nominal = (fps) => Math.round(fps);

// "01:02:03:12" / "01:02:03;12" (frames), "01:02:03,450" / "00:01.500" (ms)
const TC_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:([:;.,])(\d{1,3}))?/;
function parseTC(str, base) {
  if (typeof str === "number") return str;
  const m = TC_RE.exec(String(str || ""));
  if (!m) return null;
  const h = Number(m[1] || 0), mi = Number(m[2]), s = Number(m[3]);
  let frac = 0;
  if (m[4] && m[5] != null) {
    if (m[4] === ":" || m[4] === ";") frac = Number(m[5]) / base;           // frames
    else frac = Number(m[5]) / Math.pow(10, m[5].length);                  // decimal
  }
  return h * 3600 + mi * 60 + s + frac;
}

// Palavras aproximadas: divide o tempo do segmento pelo tamanho das palavras.
function approxWords(text, t, end) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const total = parts.reduce((n, w) => n + w.length + 1, 0);
  const dur = Math.max(0.01, (end != null ? end : t + parts.length * 0.35) - t);
  let acc = 0;
  return parts.map((w) => {
    const ws = t + (acc / total) * dur;
    acc += w.length + 1;
    return { t: ws, end: t + (acc / total) * dur, text: w, approx: true };
  });
}

function cleanSegments(segs) {
  const out = [];
  for (const s of segs) {
    let words = (s.words || []).filter((w) => w.text && !SILENCE.test(w.text))
      .map((w) => ({ ...w, text: String(w.text).trim() })).filter((w) => w.text);
    const text = words.length ? words.map((w) => w.text).join(" ") : String(s.text || "").trim();
    if (!text || SILENCE.test(text)) continue;
    if (!words.length) words = approxWords(text, s.t, s.end);
    // fim = ultima palavra falada (nao o silencio que o Resolve cola no fim)
    const end = words.length && !words[0].approx ? words[words.length - 1].end : s.end;
    out.push({ t: words.length && !words[0].approx ? words[0].t : s.t, end: end != null ? end : null, speaker: s.speaker || null, text, words });
  }
  out.sort((a, b) => a.t - b.t);
  // fim ausente = inicio do proximo
  out.forEach((s, i) => { if (s.end == null) s.end = out[i + 1] ? out[i + 1].t : s.t + 4; });
  return out;
}

// ---- Parsers ----------------------------------------------------------------
function parseJSON(obj, base) {
  // Script "Export to Fframe": tempos ja em segundos reais (relativos ao clipe).
  if (obj && obj.fframe_transcript) {
    return {
      kind: "resolve-json", fps: Number(obj.fps) || null, realtime: true, language: obj.language || null,
      markers: (Array.isArray(obj.markers) ? obj.markers : []).filter((m) => Number.isFinite(Number(m.t))).map((m) => ({
        key: String(m.frame != null ? m.frame : m.t), t: Number(m.t), end: m.end != null ? Number(m.end) : null,
        color: m.color ? String(m.color).slice(0, 20) : null,
        name: String(m.name || "").slice(0, 200), note: String(m.note || "").slice(0, 2000),
      })),
      segments: (obj.segments || []).map((s) => ({
        t: Number(s.t), end: s.end != null ? Number(s.end) : null, speaker: s.speaker, text: s.text,
        words: (s.words || []).map((w) => ({ t: Number(w.t), end: Number(w.end), text: w.text })),
      })),
    };
  }
  // GetTranscription() cru: { language, segments: [{ start, end, text, speaker, words: [{start,end,text}] }] }
  const segs = Array.isArray(obj) ? obj : obj && obj.segments;
  if (!Array.isArray(segs)) return null;
  return {
    kind: "resolve-json", language: (obj && obj.language) || null,
    segments: segs.map((s) => ({
      t: parseTC(s.start, base), end: s.end != null ? parseTC(s.end, base) : null, speaker: s.speaker, text: s.text,
      words: (s.words || []).map((w) => ({ t: parseTC(w.start, base), end: parseTC(w.end, base), text: w.text })),
    })).filter((s) => s.t != null),
  };
}

// SRT e VTT: blocos separados por linha em branco com "inicio --> fim".
function parseCues(text, base, kind) {
  const segs = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const t = parseTC(a, base), end = parseTC(b, base);
    if (t == null) continue;
    let body = lines.slice(i + 1).join(" ").trim();
    let speaker = null;
    const v = /^<v\s+([^>]+)>/.exec(body);                     // VTT: <v Fulano>
    if (v) speaker = v[1].trim();
    body = body.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
    const sp = /^([A-Z][\w .'-]{0,30}|Speaker \d+):\s+(.*)$/.exec(body);  // "Speaker 1: texto"
    if (!speaker && sp) { speaker = sp[1]; body = sp[2]; }
    segs.push({ t, end, speaker, text: body });
  }
  return { kind, segments: segs };
}

// TXT do Resolve: uma linha com timecode (ou "inicio - fim") abre um trecho;
// linhas seguintes sao o texto. Linha curta "Speaker 1" / "Nome:" vira speaker.
function parseTxt(text, base) {
  const TC_G = /(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[:;.,]\d{1,3})?/g;
  const segs = [];
  let cur = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tcs = line.match(TC_G) || [];
    const rest = line.replace(TC_G, "").replace(/^[\s\[\]()\-–—>|,]+|[\s\[\]()\-–—>|,]+$/g, "").trim();
    // Linha de timecode = comeca com o TC (aceita "[", "(" antes).
    if (tcs.length && /^[\s\[(]*\d/.test(line) && line.indexOf(tcs[0]) <= 3) {
      cur = { t: parseTC(tcs[0], base), end: tcs[1] ? parseTC(tcs[1], base) : null, speaker: null, text: "" };
      segs.push(cur);
      if (rest) {
        const sp = /^(Speaker \d+|[A-Z][\w .'-]{0,30}):\s*(.*)$/.exec(rest);
        if (sp) { cur.speaker = sp[1]; cur.text = sp[2]; }
        else if (/^Speaker \d+$/i.test(rest)) cur.speaker = rest;
        else cur.text = rest;
      }
      continue;
    }
    if (!cur) continue;
    if (!cur.text && !cur.speaker && (/^Speaker \d+:?$/i.test(line) || /^[A-Z][\w .'-]{0,30}:$/.test(line))) {
      cur.speaker = line.replace(/:$/, "");
      continue;
    }
    cur.text = (cur.text ? cur.text + " " : "") + line;
  }
  return { kind: "txt", segments: segs };
}

// Detecta o formato e devolve { kind, fps, offset, segments } ou { error }.
function parse(content, { filename, fps }) {
  const text = String(content || "").replace(/^﻿/, "");
  fps = FPS_OK.includes(Number(fps)) ? Number(fps) : 24;
  const base = nominal(fps);
  let r = null;
  const trimmed = text.trim();
  let json;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) { try { json = JSON.parse(trimmed); } catch { json = undefined; } }
  if (json !== undefined) r = parseJSON(json, base);
  else if (/^WEBVTT/.test(trimmed)) r = parseCues(text, base, "vtt");
  else if (/-->/.test(text)) r = parseCues(text, base, "srt");
  else r = parseTxt(text, base);
  if (!r) return { error: "formato nao reconhecido" };
  const segments = cleanSegments(r.segments);
  const markers = r.markers || [];
  if (!segments.length && !markers.length) return { error: "nenhum trecho com tempo encontrado" };
  // Arquivos com timecode de fonte (ex.: 01:00:00:00): tira as horas cheias.
  const min = segments.length ? segments[0].t : 0;
  const offset = min >= 3600 ? Math.floor(min / 3600) * 3600 : 0;
  return {
    kind: r.kind, language: r.language || null,
    fps: r.fps || fps,
    realtime: !!r.realtime || r.kind === "srt" || r.kind === "vtt",   // SRT/VTT ja estao em tempo real
    offset, source_name: filename ? path.basename(String(filename)) : null,
    segments, markers,
  };
}

// Aplica um arquivo ja parseado a um video: grava a transcricao (se houver
// texto) e sincroniza os marcadores do Resolve como comentarios.
// Retorna { transcript: bool, markers: n }.
function apply(id, r, extra) {
  const { markers, ...doc } = r;
  let hasText = false;
  if (doc.segments && doc.segments.length) { save(id, { ...doc, ...extra }); hasText = true; }
  const n = markers && markers.length ? store.syncMarkerComments(id, markers) : 0;
  return { transcript: hasText, markers: n };
}

// ---- Persistencia -----------------------------------------------------------
function load(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); } catch { return null; }
}
const has = (id) => fs.existsSync(fileFor(id));
function save(id, data) {
  const doc = { ...data, asset_id: id, updated_at: new Date().toISOString() };
  fs.writeFileSync(fileFor(id), JSON.stringify(doc));
  return doc;
}
function remove(id) { try { fs.unlinkSync(fileFor(id)); return true; } catch { return false; } }

// Ajustes depois do upload: fps (para TC com frames) e inicio (offset em s).
function update(id, { fps, offset }) {
  const d = load(id);
  if (!d) return null;
  if (fps != null && FPS_OK.includes(Number(fps))) d.fps = Number(fps);
  if (offset != null && Number.isFinite(Number(offset))) d.offset = Math.max(0, Number(offset));
  return save(id, d);
}

// Versao para o player: tempos reais, ja com offset aplicado.
function forPlayer(id) {
  const d = load(id);
  if (!d) return null;
  const k = d.realtime ? 1 : nominal(d.fps || 24) / (d.fps || 24);
  const off = Number(d.offset) || 0;
  const conv = (x) => Math.max(0, x * k - off * k);
  return {
    kind: d.kind, fps: d.fps, offset: off, realtime: !!d.realtime, language: d.language,
    source_name: d.source_name, source: d.source || "upload", updated_at: d.updated_at,
    approx: d.segments.some((s) => s.words.some((w) => w.approx)),
    segments: d.segments.map((s) => ({
      t: conv(s.t), end: conv(s.end), speaker: s.speaker, text: s.text,
      words: s.words.map((w) => [Number(conv(w.t).toFixed(3)), Number(conv(w.end).toFixed(3)), w.text]),
    })),
  };
}

// Nome de arquivo -> chave de comparacao com o nome do video ("A001.mov.srt",
// "A001 Transcription.txt" e "A001.srt" casam com "A001.mov").
function matchKey(name) {
  let n = path.basename(String(name || "")).toLowerCase();
  n = n.replace(/\.(json|srt|vtt|txt)$/, "").replace(/[ ._-]*(transcript|transcription|fframe)$/, "");
  n = n.replace(/\.(mp4|m4v|mov|webm|mkv|avi|mxf|mts|m2ts|wav|mp3)$/, "");
  return n.trim();
}

module.exports = { parse, apply, load, has, save, remove, update, forPlayer, matchKey, FPS_OK };
