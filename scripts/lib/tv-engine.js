(() => {
  "use strict";

  const DAY_CODES = {
    Mon: "mon",
    Tue: "tue",
    Wed: "wed",
    Thu: "thu",
    Fri: "fri",
    Sat: "sat",
    Sun: "sun"
  };

  function hash32(input) {
    let h = 0x811c9dc5;
    const text = String(input || "");
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    return function random() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(input, seedText) {
    const output = [...input];
    const random = mulberry32(hash32(seedText));
    for (let i = output.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [output[i], output[j]] = [output[j], output[i]];
    }
    return output;
  }

  function timeToSeconds(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    if (hour === 24 && minute === 0 && second === 0) return 86400;
    if (hour < 0 || hour > 23 || minute > 59 || second > 59) return null;
    return hour * 3600 + minute * 60 + second;
  }

  function asDuration(item) {
    const value = Number(item && item.duration_seconds);
    return Number.isFinite(value) && value > 0 ? value : 60;
  }

  function scheduleEndToSeconds(startValue, endValue) {
    const start = timeToSeconds(startValue);
    const end = timeToSeconds(endValue);

    if (start === null || end === null) return null;

    // En una franja diaria, "00:00" como hora de FIN significa
    // el cierre del día (24:00), no el comienzo del mismo día.
    // Ejemplo: 22:00 -> 00:00 debe equivaler a 22:00 -> 24:00.
    if (end === 0 && start > 0) return 86400;

    return end;
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter(item => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function formatDateKey(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  class TVEngine {
    constructor(data) {
      this.data = data || {};
      this.timezone =
        (this.data.tv_config && this.data.tv_config.timezone) ||
        this.data.timezone ||
        "Atlantic/Canary";

      this.channels = (this.data.channels || []).filter(item => item.active !== false && String(item.status || "").toLowerCase() !== "inactivo");
      this.programs = (this.data.programs || []).filter(item => item.active !== false && String(item.status || "").toLowerCase() !== "inactivo");
      this.media = (this.data.media || []).filter(Boolean);
      this.schedule = (this.data.schedule || []).filter(item => item && item.active !== false && item.valid !== false);

      this.channelIndex = new Map();
      this.channelSlugIndex = new Map();
      this.channels.forEach(channel => {
        this.channelIndex.set(channel.channel_id, channel);
        if (channel.slug) this.channelSlugIndex.set(channel.slug, channel);
      });

      this.programIndex = new Map(this.programs.map(program => [program.program_id, program]));
      this.mediaIndex = new Map(this.media.map(item => [item.media_id, item]));
      this.entityIndex = new Map(Object.entries(this.data.entities || {}));

      this.playableMedia = this.media.filter(item => item.playable === true || (item.playable !== false && item.embeddable === true));
      this.playableEntityMedia = this.playableMedia.filter(item => String(item.type || "").toLowerCase() === "entity");
      this.externalMedia = this.playableMedia.filter(item => String(item.type || "").toLowerCase() !== "entity");

      this._formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      });

      this.rotationRows = this.schedule
        .filter(row => row.is_global && row.selection_rule === "entity_rotation")
        .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));

      this.newRows = this.schedule
        .filter(row => row.is_global && row.selection_rule === "entity_new")
        .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));
    }

    defaultChannel() {
      const id =
        (this.data.tv_config && this.data.tv_config.default_channel_id) ||
        (this.channels[0] && this.channels[0].channel_id);
      return this.channelIndex.get(id) || this.channels[0] || null;
    }

    resolveChannel(value) {
      if (!value) return this.defaultChannel();
      return this.channelIndex.get(value) || this.channelSlugIndex.get(value) || this.defaultChannel();
    }

    canaryParts(timestampMs = Date.now()) {
      const pieces = {};
      this._formatter.formatToParts(new Date(timestampMs)).forEach(part => {
        if (part.type !== "literal") pieces[part.type] = part.value;
      });

      const weekdayRaw = String(pieces.weekday || "").slice(0, 3);
      const parts = {
        year: Number(pieces.year),
        month: Number(pieces.month),
        day: Number(pieces.day),
        hour: Number(pieces.hour),
        minute: Number(pieces.minute),
        second: Number(pieces.second),
        weekday: DAY_CODES[weekdayRaw] || weekdayRaw.toLowerCase()
      };

      parts.dateKey = formatDateKey(parts);
      parts.secondsOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
      parts.dayNumber = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
      return parts;
    }

    isScheduleRowActive(row, parts) {
      if (!row || row.active === false || row.valid === false) return false;
      if (Array.isArray(row.days) && row.days.length && !row.days.includes(parts.weekday)) return false;

      const start = timeToSeconds(row.start);
      const end = scheduleEndToSeconds(row.start, row.end);
      if (start === null || end === null) return false;
      if (parts.secondsOfDay < start || parts.secondsOfDay >= end) return false;

      const nowMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      if (row.valid_from) {
        const from = Date.parse(row.valid_from);
        if (Number.isFinite(from) && nowMs < from) return false;
      }
      if (row.valid_to) {
        const to = Date.parse(row.valid_to);
        if (Number.isFinite(to) && nowMs > to + 86400000) return false;
      }
      return true;
    }

    getProgram(programId) {
      return this.programIndex.get(programId) || {
        program_id: programId || "",
        name: programId || "Programación"
      };
    }

    getEntityBundles({ newOnly = false, timestampMs = Date.now() } = {}) {
      const newHours =
        Number(this.data.policy && this.data.policy.entity_new && this.data.policy.entity_new.new_for_hours) || 72;
      const now = timestampMs;

      const groups = new Map();
      this.playableEntityMedia.forEach(item => {
        const entityId = item.entity_id || `media:${item.media_id}`;
        const createdMs = item.entity_created_at ? Date.parse(item.entity_created_at) : NaN;
        const isNew = Number.isFinite(createdMs) && now >= createdMs && now - createdMs <= newHours * 3600000;
        if (newOnly && !isNew) return;

        if (!groups.has(entityId)) {
          groups.set(entityId, {
            entity_id: entityId,
            created_at: Number.isFinite(createdMs) ? createdMs : null,
            media: [],
            duration_seconds: 0
          });
        }

        const bundle = groups.get(entityId);
        bundle.media.push(item);
        bundle.duration_seconds += asDuration(item);
        if (Number.isFinite(createdMs) && (!bundle.created_at || createdMs < bundle.created_at)) {
          bundle.created_at = createdMs;
        }
      });

      return [...groups.values()].map(bundle => {
        bundle.media.sort((a, b) => String(a.media_id).localeCompare(String(b.media_id)));
        return bundle;
      });
    }

    flattenBundles(bundles) {
      return bundles.flatMap(bundle => bundle.media);
    }

    packBundlesIntoWindows(bundles, windowCount, capSeconds) {
      const windows = Array.from({ length: Math.max(1, windowCount) }, () => []);
      const overflow = [];
      let windowIndex = 0;
      let used = 0;

      bundles.forEach(bundle => {
        const duration = Number(bundle.duration_seconds || 0);

        if (windowIndex >= windows.length) {
          overflow.push(bundle);
          return;
        }

        if (used > 0 && used + duration > capSeconds) {
          windowIndex += 1;
          used = 0;
        }

        if (windowIndex >= windows.length) {
          overflow.push(bundle);
          return;
        }

        windows[windowIndex].push(bundle);
        used += duration;

        // Una cápsula individual no se corta aunque supere el máximo de ventana.
        if (used >= capSeconds) {
          windowIndex += 1;
          used = 0;
        }
      });

      return { windows, overflow };
    }

    splitBalanced(bundles, groupCount) {
      const groups = Array.from({ length: Math.max(1, groupCount) }, () => ({ bundles: [], duration: 0 }));
      [...bundles]
        .sort((a, b) => b.duration_seconds - a.duration_seconds)
        .forEach(bundle => {
          groups.sort((a, b) => a.duration - b.duration);
          groups[0].bundles.push(bundle);
          groups[0].duration += bundle.duration_seconds;
        });
      return groups.map(group => group.bundles);
    }

    getRotationPlan(row, parts, timestampMs) {
      const bundles = this.getEntityBundles({ timestampMs });
      if (!bundles.length || !this.rotationRows.length) return { media: [], overflow: [] };

      const fullCycleHours =
        Number(this.data.policy && this.data.policy.entity_rotation && this.data.policy.entity_rotation.current_full_cycle_hours) || 2;
      const windowsPerDay = this.rotationRows.length;
      const windowsPerCycle = Math.max(1, Math.ceil(fullCycleHours * windowsPerDay / 24));
      const rowIndex = Math.max(0, this.rotationRows.findIndex(item => item.schedule_id === row.schedule_id));
      const ordinal = parts.dayNumber * windowsPerDay + rowIndex;
      const cycleIndex = Math.floor(ordinal / windowsPerCycle);
      const indexInCycle = ((ordinal % windowsPerCycle) + windowsPerCycle) % windowsPerCycle;

      const shuffled = seededShuffle(bundles, `entity-rotation|${cycleIndex}`);
      const capSeconds = Math.max(1, Number(row.max_duration_minutes || 15) * 60);
      const packed = this.packBundlesIntoWindows(shuffled, windowsPerCycle, capSeconds);
      const selected = packed.windows[indexInCycle] || [];

      return {
        media: this.flattenBundles(selected),
        overflow: packed.overflow,
        cycleIndex,
        indexInCycle,
        windowsPerCycle
      };
    }

    getNewPlan(row, parts, timestampMs) {
      const bundles = this.getEntityBundles({ newOnly: true, timestampMs });
      if (!bundles.length || !this.newRows.length) return { media: [] };

      const total = bundles.reduce((sum, bundle) => sum + bundle.duration_seconds, 0);
      const rowIndex = Math.max(0, this.newRows.findIndex(item => item.schedule_id === row.schedule_id));
      let groups;

      if (total <= 20 * 60) {
        groups = [bundles, bundles, bundles, bundles];
      } else if (total <= 40 * 60) {
        const halves = this.splitBalanced(bundles, 2);
        groups = [halves[0], halves[1], halves[0], halves[1]];
      } else if (total <= 80 * 60) {
        groups = this.splitBalanced(bundles, 4);
      } else {
        // Máximo editorial: 80 minutos de novedades al día.
        // Se crean lotes estables y se rota por día para evitar que una
        // selección aleatoria diaria deje perfiles sin exposición premium.
        const stable = [...bundles].sort((a, b) =>
          hash32(a.entity_id) - hash32(b.entity_id) ||
          String(a.entity_id).localeCompare(String(b.entity_id))
        );

        const dailyChunks = [];
        let chunk = [];
        let used = 0;

        stable.forEach(bundle => {
          if (chunk.length && used + bundle.duration_seconds > 80 * 60) {
            dailyChunks.push(chunk);
            chunk = [];
            used = 0;
          }
          chunk.push(bundle);
          used += bundle.duration_seconds;
        });

        if (chunk.length) dailyChunks.push(chunk);

        const selectedDay =
          dailyChunks[((parts.dayNumber % dailyChunks.length) + dailyChunks.length) % dailyChunks.length] ||
          [];

        groups = this.splitBalanced(selectedDay, 4);
      }

      const selected = groups[rowIndex % groups.length] || [];
      return { media: this.flattenBundles(selected) };
    }

    getDeadlinePlan(row, parts, timestampMs) {
      if (!this.rotationRows.length) return { media: [] };

      // El motor determinista normalmente garantiza la vuelta completa.
      // Este bloque solo rescata un hipotético overflow de capacidad.
      const referenceRow =
        [...this.rotationRows]
          .reverse()
          .find(item => timeToSeconds(item.start) <= timeToSeconds(row.start)) ||
        this.rotationRows[0];

      const plan = this.getRotationPlan(referenceRow, parts, timestampMs);
      if (!plan.overflow || !plan.overflow.length) return { media: [] };

      const cap = Math.max(1, Number(row.max_duration_minutes || 30) * 60);
      const selected = [];
      let used = 0;
      for (const bundle of plan.overflow) {
        if (used > 0 && used + bundle.duration_seconds > cap) break;
        selected.push(bundle);
        used += bundle.duration_seconds;
      }
      return { media: this.flattenBundles(selected) };
    }

    getGlobalPlan(row, parts, timestampMs) {
      if (row.selection_rule === "entity_rotation") return this.getRotationPlan(row, parts, timestampMs);
      if (row.selection_rule === "entity_new") return this.getNewPlan(row, parts, timestampMs);
      if (row.selection_rule === "entity_deadline") return this.getDeadlinePlan(row, parts, timestampMs);
      return { media: [] };
    }

    resolveSequence(sequence, elapsedSeconds, seedText = "") {
      // Un mismo vídeo puede llegar al feed con registros distintos.
      // Para continuidad editorial deduplicamos por youtube_id, no sólo media_id.
      const valid = uniqueBy(
        sequence.filter(item =>
          item &&
          item.youtube_id &&
          asDuration(item) > 0
        ),
        item => String(item.youtube_id)
      );

      if (!valid.length) return null;

      const total = valid.reduce(
        (sum, item) => sum + asDuration(item),
        0
      );

      if (total <= 0) return null;

      let elapsed = Math.max(0, elapsedSeconds);
      const cycle = Math.floor(elapsed / total);
      elapsed %= total;

      const orderForCycle = cycleNumber => {
        if (cycleNumber <= 0) {
          return [...valid];
        }

        const ordered = seededShuffle(
          valid,
          `${seedText}|loop:${cycleNumber}`
        );

        // Evita la repetición justo en el límite entre dos vueltas:
        //
        // vuelta N:     A B C
        // vuelta N + 1: C A B   <- antes podía ocurrir C -> C
        //
        // Si hay alternativas, intercambiamos determinísticamente el
        // primer elemento por el primer vídeo distinto.
        if (ordered.length > 1) {
          const previous = cycleNumber === 1
            ? [...valid]
            : seededShuffle(
                valid,
                `${seedText}|loop:${cycleNumber - 1}`
              );

          // La vuelta anterior también pudo ser corregida. Reproducimos
          // recursivamente sólo la corrección de borde para conocer su final.
          const previousOrdered = (() => {
            if (cycleNumber - 1 <= 0) {
              return previous;
            }

            const result = [...previous];
            const prevPrev = cycleNumber - 1 === 1
              ? [...valid]
              : seededShuffle(
                  valid,
                  `${seedText}|loop:${cycleNumber - 2}`
                );

            if (
              result.length > 1 &&
              prevPrev.length &&
              result[0].youtube_id ===
                prevPrev[prevPrev.length - 1].youtube_id
            ) {
              const swapIndex = result.findIndex(
                (item, index) =>
                  index > 0 &&
                  item.youtube_id !==
                    prevPrev[prevPrev.length - 1].youtube_id
              );

              if (swapIndex > 0) {
                [result[0], result[swapIndex]] =
                  [result[swapIndex], result[0]];
              }
            }

            return result;
          })();

          const previousLast =
            previousOrdered[previousOrdered.length - 1];

          if (
            previousLast &&
            ordered[0].youtube_id === previousLast.youtube_id
          ) {
            const swapIndex = ordered.findIndex(
              (item, index) =>
                index > 0 &&
                item.youtube_id !== previousLast.youtube_id
            );

            if (swapIndex > 0) {
              [ordered[0], ordered[swapIndex]] =
                [ordered[swapIndex], ordered[0]];
            }
          }
        }

        return ordered;
      };

      const ordered = orderForCycle(cycle);

      for (const item of ordered) {
        const duration = asDuration(item);

        if (elapsed < duration) {
          return {
            media: item,
            media_offset_seconds: elapsed,
            cycle
          };
        }

        elapsed -= duration;
      }

      return {
        media: ordered[0],
        media_offset_seconds: 0,
        cycle
      };
    }

    resolveGlobal(timestampMs = Date.now()) {
      const parts = this.canaryParts(timestampMs);
      const candidates = this.schedule
        .filter(row => row.is_global && this.isScheduleRowActive(row, parts))
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

      for (const row of candidates) {
        const plan = this.getGlobalPlan(row, parts, timestampMs);
        const sequence = plan.media || [];
        if (!sequence.length) continue;

        const start = timeToSeconds(row.start);
        const elapsed = Math.max(0, parts.secondsOfDay - start);
        const maxDuration = row.max_duration_minutes ? Number(row.max_duration_minutes) * 60 : Infinity;
        const sequenceDuration = sequence.reduce((sum, item) => sum + asDuration(item), 0);
        const actualDuration = Math.min(maxDuration, sequenceDuration);

        if (elapsed >= actualDuration) continue;

        const resolved = this.resolveSequence(sequence, elapsed, `${parts.dateKey}|${row.schedule_id}`);
        if (!resolved) continue;

        return {
          kind: "media",
          is_global: true,
          is_global_entity_block: true,
          schedule: row,
          program: this.getProgram(row.program_id),
          media: resolved.media,
          media_offset_seconds: resolved.media_offset_seconds,
          block_elapsed_seconds: elapsed,
          block_duration_seconds: actualDuration
        };
      }

      return null;
    }

    globalIntervalsForDay(parts, timestampMs) {
      const intervals = [];
      const globalRows = this.schedule.filter(row =>
        row.is_global &&
        row.active !== false &&
        row.valid !== false &&
        (!Array.isArray(row.days) || !row.days.length || row.days.includes(parts.weekday))
      );

      globalRows.forEach(row => {
        const start = timeToSeconds(row.start);
        const end = scheduleEndToSeconds(row.start, row.end);
        if (start === null || end === null) return;

        const probeParts = { ...parts, secondsOfDay: start };
        const plan = this.getGlobalPlan(row, probeParts, timestampMs);
        const sequence = plan.media || [];
        if (!sequence.length) return;

        const maxDuration = row.max_duration_minutes ? Number(row.max_duration_minutes) * 60 : Infinity;
        const sequenceDuration = sequence.reduce((sum, item) => sum + asDuration(item), 0);
        const duration = Math.min(maxDuration, sequenceDuration, end - start);
        if (duration > 0) intervals.push([start, start + duration]);
      });

      intervals.sort((a, b) => a[0] - b[0]);
      const merged = [];
      intervals.forEach(interval => {
        const last = merged[merged.length - 1];
        if (!last || interval[0] > last[1]) {
          merged.push([...interval]);
        } else {
          last[1] = Math.max(last[1], interval[1]);
        }
      });
      return merged;
    }

    interruptedSecondsBetween(startSeconds, endSeconds, parts, timestampMs) {
      if (endSeconds <= startSeconds) return 0;
      return this.globalIntervalsForDay(parts, timestampMs).reduce((sum, [a, b]) => {
        const overlap = Math.max(0, Math.min(endSeconds, b) - Math.max(startSeconds, a));
        return sum + overlap;
      }, 0);
    }

    getThematicRow(channelId, parts) {
      return this.schedule
        .filter(row =>
          !row.is_global &&
          row.channel_id === channelId &&
          this.isScheduleRowActive(row, parts)
        )
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;
    }

    thematicCandidates(channelId, row) {
      if (row.media_id) {
        const exact = this.mediaIndex.get(row.media_id);
        return exact && exact.playable !== false ? [exact] : [];
      }

      return this.externalMedia.filter(item =>
        item.program_id === row.program_id &&
        Array.isArray(item.channels) &&
        item.channels.includes(channelId) &&
        item.schedulable !== false
      );
    }

    resolveThematic(channelId, timestampMs = Date.now()) {
      const parts = this.canaryParts(timestampMs);
      const row = this.getThematicRow(channelId, parts);
      if (!row) {
        return {
          kind: "standby",
          is_global: false,
          is_global_entity_block: false,
          schedule: null,
          program: null,
          media: null,
          media_offset_seconds: 0
        };
      }

      const program = this.getProgram(row.program_id);
      const candidates = this.thematicCandidates(channelId, row);
      if (!candidates.length) {
        return {
          kind: "standby",
          is_global: false,
          is_global_entity_block: false,
          schedule: row,
          program,
          media: null,
          media_offset_seconds: 0
        };
      }

      const start = timeToSeconds(row.start);
      const rawElapsed = Math.max(0, parts.secondsOfDay - start);
      const interruptions = this.interruptedSecondsBetween(start, parts.secondsOfDay, parts, timestampMs);
      const elapsed = Math.max(0, rawElapsed - interruptions);
      const ordered = seededShuffle(candidates, `${parts.dateKey}|${channelId}|${row.schedule_id}|0`);
      const resolved = this.resolveSequence(ordered, elapsed, `${parts.dateKey}|${channelId}|${row.schedule_id}`);

      return {
        kind: "media",
        is_global: false,
        is_global_entity_block: false,
        schedule: row,
        program,
        media: resolved && resolved.media,
        media_offset_seconds: resolved ? resolved.media_offset_seconds : 0,
        thematic_elapsed_seconds: elapsed
      };
    }

    resolve(channelValue, timestampMs = Date.now()) {
      const channel = this.resolveChannel(channelValue);
      if (!channel) {
        return {
          kind: "standby",
          channel: null,
          program: null,
          media: null,
          is_global: false,
          is_global_entity_block: false
        };
      }

      const global = this.resolveGlobal(timestampMs);
      if (global) return { ...global, channel };
      return { ...this.resolveThematic(channel.channel_id, timestampMs), channel };
    }

    nextProgramChanges(timestampMs = Date.now(), leadSeconds = 30) {
      /*
       * Continuidad de TV.
       *
       * La versión anterior dependía exclusivamente del "end" de la franja
       * actualmente activa. Eso podía perder avisos cuando las franjas no
       * encajaban exactamente, había huecos o se cruzaba medianoche.
       *
       * Aquí buscamos los próximos START reales del schedule de cada canal y
       * comprobamos la emisión efectiva justo después de ese instante.
       */
      if (this.resolveGlobal(timestampMs)) return [];

      const nowParts = this.canaryParts(timestampMs);
      const nowSeconds = nowParts.secondsOfDay;
      const lead = Math.max(1, Number(leadSeconds || 30));
      const results = [];

      this.channels.forEach(channel => {
        const currentBroadcast = this.resolveThematic(channel.channel_id, timestampMs);
        const currentProgramId =
          currentBroadcast && currentBroadcast.program
            ? currentBroadcast.program.program_id
            : "";

        const boundaries = uniqueBy(
          this.schedule
            .filter(row =>
              !row.is_global &&
              row.channel_id === channel.channel_id &&
              row.active !== false &&
              row.valid !== false
            )
            .map(row => {
              const start = timeToSeconds(row.start);
              if (start === null) return null;

              let delta = start - nowSeconds;
              if (delta <= 0) delta += 86400;

              return {
                row,
                delta
              };
            })
            .filter(item => item && item.delta > 0 && item.delta <= lead)
            .sort((a, b) =>
              a.delta - b.delta ||
              Number(b.row.priority || 0) - Number(a.row.priority || 0)
            ),
          item => String(item.delta)
        );

        for (const boundary of boundaries) {
          const futureMs = timestampMs + boundary.delta * 1000 + 250;

          // Durante/entrando en bloques globales entity_* no mostramos continuidad.
          const futureGlobal = this.resolveGlobal(futureMs);
          if (futureGlobal && futureGlobal.is_global_entity_block) continue;

          const nextBroadcast = this.resolveThematic(channel.channel_id, futureMs);
          if (!nextBroadcast || !nextBroadcast.program || !nextBroadcast.media) continue;

          const nextProgramId = nextBroadcast.program.program_id || "";
          if (!nextProgramId || nextProgramId === currentProgramId) continue;

          results.push({
            channel,
            current_program:
              currentBroadcast && currentBroadcast.program
                ? currentBroadcast.program
                : null,
            next_program: nextBroadcast.program,
            next_media: nextBroadcast.media,
            seconds_until_change: Math.max(0, boundary.delta),
            change_at_ms: timestampMs + boundary.delta * 1000
          });

          // Solo queremos el cambio más próximo de cada canal.
          break;
        }
      });

      return results.sort((a, b) =>
        a.seconds_until_change - b.seconds_until_change ||
        Number(a.channel.channel_number || 999) - Number(b.channel.channel_number || 999)
      );
    }
  }

  const api = { TVEngine, seededShuffle, hash32, timeToSeconds };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined") window.AVTVEngine = api;
})();
