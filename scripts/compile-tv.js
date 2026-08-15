#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TVEngine, seededShuffle, timeToSeconds } = require("./lib/tv-engine.js");

const TARGET_COVERAGE_DAYS = Number(process.env.TV_TARGET_COVERAGE_DAYS || 7);
const HORIZON_DAYS = Number(process.env.TV_SCHEDULE_DAYS || 7);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isoLocal(ms) {
  const d = new Date(ms);
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return [
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  ].join("");
}

function localMidnight(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayStartFromDate(dateText) {
  if (!dateText) return localMidnight();
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("--date debe ser YYYY-MM-DD");
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime();
}

function addLocalDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function durationOf(media) {
  const n = Number(media && media.duration_seconds);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function hashObject(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isRowForDay(engine, row, dayStartMs) {
  const startSec = timeToSeconds(row.start);
  if (startSec === null) return false;
  const probeMs = dayStartMs + Math.min(startSec + 1, 86399) * 1000;
  return engine.isScheduleRowActive(row, engine.canaryParts(probeMs));
}

function globalSlotsForDay(engine, dayStartMs) {
  const parts = engine.canaryParts(dayStartMs + 1000);
  const slots = [];

  const rows = engine.schedule
    .filter(row => row.is_global && isRowForDay(engine, row, dayStartMs))
    .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));

  for (const row of rows) {
    const startSec = timeToSeconds(row.start);
    const rowEnd = (() => {
      const raw = timeToSeconds(row.end);
      if (raw === 0 && startSec > 0) return 86400;
      return raw;
    })();
    if (startSec === null || rowEnd === null || rowEnd <= startSec) continue;

    const probeParts = { ...parts, secondsOfDay: startSec };
    const probeMs = dayStartMs + startSec * 1000;
    const plan = engine.getGlobalPlan(row, probeParts, probeMs);
    const sequence = plan && Array.isArray(plan.media) ? plan.media : [];
    if (!sequence.length) continue;

    const maxDuration = row.max_duration_minutes
      ? Number(row.max_duration_minutes) * 60
      : Infinity;
    const sequenceDuration = sequence.reduce((sum, item) => sum + durationOf(item), 0);
    const actualDuration = Math.min(maxDuration, sequenceDuration, rowEnd - startSec);
    if (!(actualDuration > 0)) continue;

    let elapsed = 0;
    while (elapsed < actualDuration - 0.001) {
      const resolved = engine.resolveSequence(sequence, elapsed, `${parts.dateKey}|${row.schedule_id}`);
      if (!resolved || !resolved.media) break;
      const media = resolved.media;
      const remaining = Math.max(0.001, durationOf(media) - Number(resolved.media_offset_seconds || 0));
      const segment = Math.min(remaining, actualDuration - elapsed);
      const startMs = dayStartMs + (startSec + elapsed) * 1000;
      const endMs = startMs + segment * 1000;
      slots.push({
        kind: "global_entity",
        is_global: true,
        is_global_entity_block: true,
        start: isoLocal(startMs),
        end: isoLocal(endMs),
        start_ms: startMs,
        end_ms: endMs,
        duration_seconds: segment,
        schedule_id: row.schedule_id,
        program_id: row.program_id,
        media_id: media.media_id,
        youtube_id: media.youtube_id || "",
        media_offset_seconds: Number(resolved.media_offset_seconds || 0),
        airing_id: `${parts.dateKey}|global|${row.schedule_id}|${Math.round(elapsed)}|${media.media_id}`
      });
      elapsed += segment;
    }
  }

  return slots.sort((a, b) => a.start_ms - b.start_ms);
}

function intervalOverlapSeconds(start, end, intervals) {
  return intervals.reduce((sum, slot) => {
    return sum + Math.max(0, Math.min(end, slot.end_ms) - Math.max(start, slot.start_ms)) / 1000;
  }, 0);
}

function activeGlobalAt(ms, globalSlots) {
  return globalSlots.find(slot => ms >= slot.start_ms && ms < slot.end_ms) || null;
}

function nextGlobalStartAfter(ms, beforeMs, globalSlots) {
  for (const slot of globalSlots) {
    if (slot.start_ms > ms && slot.start_ms < beforeMs) return slot.start_ms;
  }
  return null;
}

function thematicSlotsForRow(engine, channel, row, dayStartMs, globalSlots) {
  const parts = engine.canaryParts(dayStartMs + 1000);
  const startSec = timeToSeconds(row.start);
  let endSec = timeToSeconds(row.end);
  if (endSec === 0 && startSec > 0) endSec = 86400;
  if (startSec === null || endSec === null || endSec <= startSec) return [];

  const candidates = engine.thematicCandidates(channel.channel_id, row);
  const rowStartMs = dayStartMs + startSec * 1000;
  const rowEndMs = dayStartMs + endSec * 1000;

  if (!candidates.length) {
    return [{
      kind: "standby",
      is_global: false,
      is_global_entity_block: false,
      start: isoLocal(rowStartMs),
      end: isoLocal(rowEndMs),
      start_ms: rowStartMs,
      end_ms: rowEndMs,
      duration_seconds: (rowEndMs - rowStartMs) / 1000,
      schedule_id: row.schedule_id,
      program_id: row.program_id,
      media_id: "",
      youtube_id: "",
      media_offset_seconds: 0,
      airing_id: ""
    }];
  }

  const ordered = seededShuffle(
    candidates,
    `${parts.dateKey}|${channel.channel_id}|${row.schedule_id}|0`
  );

  const slots = [];
  let wallMs = rowStartMs;
  let guard = 0;

  while (wallMs < rowEndMs - 500 && guard < 100000) {
    guard += 1;
    const global = activeGlobalAt(wallMs, globalSlots);
    if (global) {
      wallMs = Math.min(rowEndMs, global.end_ms);
      continue;
    }

    const rawElapsed = (wallMs - rowStartMs) / 1000;
    const interruptions = intervalOverlapSeconds(rowStartMs, wallMs, globalSlots);
    const thematicElapsed = Math.max(0, rawElapsed - interruptions);
    const resolved = engine.resolveSequence(
      ordered,
      thematicElapsed,
      `${parts.dateKey}|${channel.channel_id}|${row.schedule_id}`
    );
    if (!resolved || !resolved.media) break;

    const media = resolved.media;
    const offset = Number(resolved.media_offset_seconds || 0);
    const logicalStart = Math.max(0, thematicElapsed - offset);
    const remaining = Math.max(0.001, durationOf(media) - offset);
    let segmentEndMs = Math.min(rowEndMs, wallMs + remaining * 1000);
    const nextGlobal = nextGlobalStartAfter(wallMs, segmentEndMs, globalSlots);
    if (nextGlobal !== null) segmentEndMs = nextGlobal;

    if (segmentEndMs <= wallMs) {
      wallMs += 1000;
      continue;
    }

    slots.push({
      kind: "media",
      is_global: false,
      is_global_entity_block: false,
      start: isoLocal(wallMs),
      end: isoLocal(segmentEndMs),
      start_ms: wallMs,
      end_ms: segmentEndMs,
      duration_seconds: (segmentEndMs - wallMs) / 1000,
      schedule_id: row.schedule_id,
      program_id: row.program_id,
      media_id: media.media_id,
      youtube_id: media.youtube_id || "",
      media_offset_seconds: offset,
      airing_id: `${parts.dateKey}|${channel.channel_id}|${row.schedule_id}|${Math.round(logicalStart)}|${media.media_id}`
    });

    wallMs = segmentEndMs;
  }

  if (guard >= 100000) throw new Error(`Guard agotado en ${channel.channel_id}/${row.schedule_id}`);
  return slots;
}

function programBoundariesForDay(engine, channel, dayStartMs) {
  const rows = engine.schedule
    .filter(row => !row.is_global && row.channel_id === channel.channel_id && isRowForDay(engine, row, dayStartMs))
    .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));

  const boundaries = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const startSec = timeToSeconds(row.start);
    if (startSec === null) continue;
    const previous = rows[i - 1] || null;
    if (previous && previous.program_id === row.program_id) continue;
    const startMs = dayStartMs + startSec * 1000;
    boundaries.push({
      start: isoLocal(startMs),
      start_ms: startMs,
      schedule_id: row.schedule_id,
      program_id: row.program_id
    });
  }
  return boundaries;
}

function stripInternalMs(slot) {
  const copy = { ...slot };
  delete copy.start_ms;
  delete copy.end_ms;
  return copy;
}

function compactMedia(media) {
  return {
    media_id: media.media_id,
    youtube_id: media.youtube_id || "",
    type: media.type || "",
    program_id: media.program_id || "",
    title: media.title || media.name || media.media_id,
    tv_description: media.tv_description || media.display_description || media.description || "",
    description: media.description || "",
    tags: Array.isArray(media.tags) ? media.tags : [],
    channels: Array.isArray(media.channels) ? media.channels : [],
    duration_seconds: durationOf(media),
    thumbnail: media.thumbnail || "",
    channel_title: media.channel_title || "",
    published_at: media.published_at || "",
    source: media.source || "",
    rights_status: media.rights_status || "",
    entity_id: media.entity_id || "",
    active: media.active !== false,
    playable: media.playable !== false,
    schedulable: media.schedulable !== false,
    embeddable: media.embeddable !== false
  };
}

function buildCatalogStats(feed, compiled, nowMs) {
  const programsById = new Map((feed.programs || []).map(item => [item.program_id, item]));
  const mediaById = new Map((feed.media || []).map(item => [item.media_id, item]));
  const channels = (feed.channels || []).filter(item => item.active !== false);

  const eligibleMedia = (feed.media || []).filter(item =>
    item && item.active !== false && item.playable !== false && item.schedulable !== false && item.embeddable !== false
  );

  const programMap = new Map();
  for (const program of feed.programs || []) {
    if (program.active === false) continue;
    programMap.set(program.program_id, {
      program_id: program.program_id,
      name: program.name || program.program_id,
      description: program.description || "",
      media: [],
      channels: {},
      summary: {}
    });
  }

  const uniqueProgramMedia = new Map();
  const mediaIdToDedupeKey = new Map();
  for (const media of eligibleMedia) {
    if (!programMap.has(media.program_id)) continue;
    const dedupeKey = `${media.program_id}|${media.youtube_id || media.media_id}`;
    mediaIdToDedupeKey.set(media.media_id, dedupeKey);
    if (uniqueProgramMedia.has(dedupeKey)) continue;
    uniqueProgramMedia.set(dedupeKey, media);
  }

  const airingsByVideo = new Map();
  const allTimelineSlots = [];
  for (const [channelId, slots] of Object.entries(compiled.timelines || {})) {
    for (const slot of slots) {
      if (slot.kind !== "media" || !slot.media_id) continue;
      allTimelineSlots.push({ ...slot, channel_id: channelId });
    }
  }

  const airingGroups = new Map();
  for (const slot of allTimelineSlots) {
    const key = `${slot.channel_id}|${slot.airing_id}`;
    if (!airingGroups.has(key)) {
      airingGroups.set(key, {
        airing_id: slot.airing_id,
        media_id: slot.media_id,
        channel_id: slot.channel_id,
        program_id: slot.program_id,
        schedule_id: slot.schedule_id,
        start_ms: Date.parse(slot.start),
        end_ms: Date.parse(slot.end),
        air_seconds: 0,
        segments: []
      });
    }
    const airing = airingGroups.get(key);
    airing.start_ms = Math.min(airing.start_ms, Date.parse(slot.start));
    airing.end_ms = Math.max(airing.end_ms, Date.parse(slot.end));
    airing.air_seconds += Number(slot.duration_seconds || 0);
    airing.segments.push({ start: slot.start, end: slot.end });
  }

  for (const airing of airingGroups.values()) {
    const media = mediaById.get(airing.media_id);
    if (!media) continue;
    const entry = {
      airing_id: airing.airing_id,
      start: isoLocal(airing.start_ms),
      end: isoLocal(airing.end_ms),
      channel_id: airing.channel_id,
      program_id: airing.program_id,
      schedule_id: airing.schedule_id,
      air_seconds: Math.round(airing.air_seconds),
      segments: airing.segments
    };
    const dedupeKey = mediaIdToDedupeKey.get(media.media_id) || `${media.program_id}|${media.youtube_id || media.media_id}`;
    if (!airingsByVideo.has(dedupeKey)) airingsByVideo.set(dedupeKey, []);
    airingsByVideo.get(dedupeKey).push(entry);
  }

  function statsForMedia(media) {
    const dedupeKey = `${media.program_id}|${media.youtube_id || media.media_id}`;
    const airings = [...(airingsByVideo.get(dedupeKey) || [])]
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const starts = airings.map(a => Date.parse(a.start));
    const gaps = starts.slice(1).map((value, index) => (value - starts[index]) / 1000);
    const channelCounts = {};
    const hourCounts = {};
    const dayCounts = {};
    let totalAir = 0;
    for (const airing of airings) {
      channelCounts[airing.channel_id] = (channelCounts[airing.channel_id] || 0) + 1;
      totalAir += airing.air_seconds;
      const d = new Date(Date.parse(airing.start));
      const hour = pad2(d.getHours());
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }
    const next = airings.find(a => Date.parse(a.start) >= nowMs) || null;
    return {
      airs_next_24h: airings.filter(a => Date.parse(a.start) >= nowMs && Date.parse(a.start) < nowMs + 86400000).length,
      airs_next_7d: airings.length,
      total_air_seconds_7d: Math.round(totalAir),
      next_air: next ? next.start : null,
      first_air_7d: airings[0] ? airings[0].start : null,
      last_air_7d: airings.length ? airings[airings.length - 1].start : null,
      average_gap_seconds: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      min_gap_seconds: gaps.length ? Math.round(Math.min(...gaps)) : null,
      max_gap_seconds: gaps.length ? Math.round(Math.max(...gaps)) : null,
      channels: channelCounts,
      hours: hourCounts,
      days: dayCounts,
      airings
    };
  }

  for (const [dedupeKey, media] of uniqueProgramMedia.entries()) {
    const program = programMap.get(media.program_id);
    program.media.push({
      ...compactMedia(media),
      dedupe_key: dedupeKey,
      schedule_stats: statsForMedia(media)
    });
  }

  let criticalPrograms = 0;
  for (const program of programMap.values()) {
    program.media.sort((a, b) => a.title.localeCompare(b.title, "es"));
    const uniqueVideos = program.media.length;
    const durationSeconds = program.media.reduce((sum, m) => sum + Number(m.duration_seconds || 0), 0);

    for (const channel of channels) {
      const eligible = program.media.filter(m => Array.isArray(m.channels) && m.channels.includes(channel.channel_id));
      const eligibleDuration = eligible.reduce((sum, m) => sum + Number(m.duration_seconds || 0), 0);
      const slots = (compiled.timelines[channel.channel_id] || []).filter(slot => slot.kind === "media" && slot.program_id === program.program_id);
      const scheduled7d = slots.reduce((sum, slot) => sum + Number(slot.duration_seconds || 0), 0);
      const daily = scheduled7d / HORIZON_DAYS;
      const coverage = daily > 0 ? eligibleDuration / daily : null;
      const missing = daily > 0 ? Math.max(0, TARGET_COVERAGE_DAYS * daily - eligibleDuration) : 0;
      let status = "unused";
      if (daily > 0) {
        if (coverage < 1) status = "critical";
        else if (coverage < 2) status = "low";
        else if (coverage < 4) status = "improvable";
        else if (coverage < 7) status = "good";
        else status = "ample";
      }
      program.channels[channel.channel_id] = {
        video_count: eligible.length,
        duration_seconds: Math.round(eligibleDuration),
        scheduled_seconds_7d: Math.round(scheduled7d),
        scheduled_seconds_per_day: Math.round(daily),
        coverage_days: coverage === null ? null : Number(coverage.toFixed(2)),
        target_days: TARGET_COVERAGE_DAYS,
        missing_seconds: Math.round(missing),
        status
      };
    }

    const usedChannels = Object.values(program.channels).filter(c => c.scheduled_seconds_per_day > 0);
    const worst = usedChannels
      .filter(c => c.coverage_days !== null)
      .sort((a, b) => a.coverage_days - b.coverage_days)[0] || null;
    if (worst && worst.status === "critical") criticalPrograms += 1;

    program.summary = {
      unique_videos: uniqueVideos,
      duration_seconds: Math.round(durationSeconds),
      scheduled_airings_7d: program.media.reduce((sum, media) => sum + media.schedule_stats.airs_next_7d, 0),
      worst_coverage_days: worst ? worst.coverage_days : null,
      worst_status: worst ? worst.status : "unused"
    };
  }

  const programList = [...programMap.values()].sort((a, b) => {
    const ac = a.summary.worst_coverage_days;
    const bc = b.summary.worst_coverage_days;
    if (ac === null && bc !== null) return 1;
    if (ac !== null && bc === null) return -1;
    if (ac !== null && bc !== null && ac !== bc) return ac - bc;
    return a.name.localeCompare(b.name, "es");
  });

  const uniqueVideos = uniqueBy(eligibleMedia, item => item.youtube_id || item.media_id);
  return {
    schema_version: 1,
    generated_at: isoLocal(nowMs),
    timezone: feed.timezone || (feed.tv_config && feed.tv_config.timezone) || "Atlantic/Canary",
    horizon_days: HORIZON_DAYS,
    target_coverage_days: TARGET_COVERAGE_DAYS,
    valid_from: compiled.valid_from,
    valid_until: compiled.valid_until,
    summary: {
      unique_videos: uniqueVideos.length,
      duration_seconds: Math.round(uniqueVideos.reduce((sum, m) => sum + durationOf(m), 0)),
      programs: programList.length,
      channels: channels.length,
      critical_programs: criticalPrograms
    },
    channels: channels.map(c => ({
      channel_id: c.channel_id,
      channel_number: c.channel_number,
      name: c.name,
      slug: c.slug || c.channel_id
    })),
    programs: programList
  };
}

function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(args.input || "tv/feed.json");
  const outDir = path.resolve(args.out || "tv");
  const feed = JSON.parse(fs.readFileSync(input, "utf8"));
  const timezone = (feed.tv_config && feed.tv_config.timezone) || feed.timezone || "Atlantic/Canary";
  process.env.TZ = timezone;

  const generatedMs = Date.now();
  const startMs = dayStartFromDate(args.date);
  const validUntilMs = addLocalDays(startMs, HORIZON_DAYS);
  const engine = new TVEngine(feed);

  const globalSlotsInternal = [];
  const timelinesInternal = Object.fromEntries(engine.channels.map(c => [c.channel_id, []]));
  const boundaries = Object.fromEntries(engine.channels.map(c => [c.channel_id, []]));

  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    const dayStartMs = addLocalDays(startMs, day);
    const dayGlobal = globalSlotsForDay(engine, dayStartMs);
    globalSlotsInternal.push(...dayGlobal);

    for (const channel of engine.channels) {
      const rows = engine.schedule
        .filter(row => !row.is_global && row.channel_id === channel.channel_id && isRowForDay(engine, row, dayStartMs))
        .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));

      for (const row of rows) {
        timelinesInternal[channel.channel_id].push(
          ...thematicSlotsForRow(engine, channel, row, dayStartMs, dayGlobal)
        );
      }
      boundaries[channel.channel_id].push(...programBoundariesForDay(engine, channel, dayStartMs));
    }
  }

  const scheduledMediaIds = new Set([
    ...globalSlotsInternal.map(s => s.media_id),
    ...Object.values(timelinesInternal).flat().map(s => s.media_id)
  ].filter(Boolean));
  const media = (feed.media || []).filter(m => scheduledMediaIds.has(m.media_id)).map(compactMedia);
  const entityIds = new Set(media.map(m => m.entity_id).filter(Boolean));
  const entities = Object.fromEntries(
    Object.entries(feed.entities || {}).filter(([id]) => entityIds.has(id))
  );

  const compiledCore = {
    schema_version: 1,
    timezone,
    valid_from: isoLocal(startMs),
    valid_until: isoLocal(validUntilMs),
    source_feed_generated_at: feed.generated_at || null,
    default_channel_id: (feed.tv_config && feed.tv_config.default_channel_id) || (engine.channels[0] && engine.channels[0].channel_id) || null,
    channels: engine.channels,
    programs: engine.programs,
    presentation: feed.presentation || {},
    entities,
    media,
    global: globalSlotsInternal.map(stripInternalMs),
    timelines: Object.fromEntries(
      Object.entries(timelinesInternal).map(([id, slots]) => [id, slots.map(stripInternalMs)])
    ),
    program_boundaries: Object.fromEntries(
      Object.entries(boundaries).map(([id, items]) => [id, items.map(item => ({
        start: item.start,
        schedule_id: item.schedule_id,
        program_id: item.program_id
      }))])
    )
  };

  const scheduleVersion = hashObject(compiledCore);
  const compiled = {
    ...compiledCore,
    generated_at: isoLocal(generatedMs),
    schedule_version: scheduleVersion
  };

  const stats = buildCatalogStats(feed, compiled, generatedMs);
  const manifest = {
    schema_version: 1,
    timezone,
    generated_at: isoLocal(generatedMs),
    feed_version: hashObject({
      schema_version: feed.schema_version,
      channels: feed.channels,
      programs: feed.programs,
      media: feed.media,
      schedule: feed.schedule,
      policy: feed.policy
    }),
    schedule_version: scheduleVersion,
    schedule_generated_at: compiled.generated_at,
    schedule_valid_from: compiled.valid_from,
    schedule_valid_until: compiled.valid_until,
    feed_url: "https://data.archipielagovivo.org/tv/feed.json",
    schedule_url: "https://data.archipielagovivo.org/tv/schedule.json",
    catalog_stats_url: "https://data.archipielagovivo.org/tv/catalog-stats.json",
    catalog_url: "https://data.archipielagovivo.org/tv/catalogo/"
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "schedule.json"), JSON.stringify(compiled, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "catalog-stats.json"), JSON.stringify(stats, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(JSON.stringify({
    ok: true,
    schedule_version: scheduleVersion,
    valid_from: compiled.valid_from,
    valid_until: compiled.valid_until,
    global_slots: compiled.global.length,
    channel_slots: Object.fromEntries(Object.entries(compiled.timelines).map(([k, v]) => [k, v.length])),
    catalog_programs: stats.programs.length,
    catalog_videos: stats.summary.unique_videos
  }, null, 2));
}

main();
