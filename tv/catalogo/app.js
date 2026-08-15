(() => {
  "use strict";

  const DATA_URL = "../catalog-stats.json";
  const $ = id => document.getElementById(id);
  let data = null;

  const statusLabels = {
    critical: "Urgente",
    low: "Bajo",
    improvable: "Mejorable",
    good: "Correcto",
    ample: "Amplio",
    unused: "Sin uso"
  };

  function hms(seconds) {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
    return `${m} min`;
  }

  function shortDuration(seconds) {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
  }

  function fmtDate(value, withDate = true) {
    if (!value) return "—";
    const d = new Date(value);
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: data.timezone || "Atlantic/Canary",
      weekday: withDate ? "short" : undefined,
      day: withDate ? "2-digit" : undefined,
      month: withDate ? "2-digit" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  }

  function num(value, digits = 1) {
    return Number(value || 0).toLocaleString("es-ES", { maximumFractionDigits: digits });
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function activeChannelMetric(program) {
    const selected = $("channelFilter").value;
    if (selected) return program.channels[selected] || null;
    return Object.values(program.channels || {})
      .filter(x => x.scheduled_seconds_per_day > 0 && x.coverage_days !== null)
      .sort((a,b) => a.coverage_days - b.coverage_days)[0] || null;
  }

  function renderSummary() {
    const s = data.summary;
    $("summary").innerHTML = [
      [s.unique_videos, "vídeos únicos"],
      [hms(s.duration_seconds), "catálogo disponible"],
      [s.programs, "programas"],
      [s.channels, "canales"],
      [s.critical_programs, "programas urgentes"]
    ].map(([value,label]) => `<div class="summary-card"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("");
  }

  function renderChannels() {
    $("channelFilter").insertAdjacentHTML("beforeend", data.channels.map(c =>
      `<option value="${esc(c.channel_id)}">${c.channel_number ? `${esc(c.channel_number)} · ` : ""}${esc(c.name)}</option>`
    ).join(""));
  }

  function programMatches(program) {
    const q = $("search").value.trim().toLowerCase();
    const status = $("statusFilter").value;
    const metric = activeChannelMetric(program);
    if (status && (!metric || metric.status !== status)) return false;
    if (!q) return true;
    const haystack = [
      program.name,
      program.description,
      ...program.media.flatMap(m => [m.title, m.channel_title, m.tv_description, ...(m.tags || [])])
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  }

  function sortPrograms(programs) {
    const mode = $("sortBy").value;
    return [...programs].sort((a,b) => {
      if (mode === "name") return a.name.localeCompare(b.name,"es");
      if (mode === "hours") return b.summary.duration_seconds - a.summary.duration_seconds;
      if (mode === "videos") return b.summary.unique_videos - a.summary.unique_videos;
      const am = activeChannelMetric(a), bm = activeChannelMetric(b);
      const av = am && am.coverage_days !== null ? am.coverage_days : Infinity;
      const bv = bm && bm.coverage_days !== null ? bm.coverage_days : Infinity;
      return av - bv || a.name.localeCompare(b.name,"es");
    });
  }

  function coverageCard(channel, metric) {
    if (!metric || metric.scheduled_seconds_per_day <= 0) return "";
    return `<div class="coverage-card">
      <h3>${channel.channel_number ? `${esc(channel.channel_number)} · ` : ""}${esc(channel.name)}</h3>
      <dl>
        <dt>Vídeos elegibles</dt><dd>${metric.video_count}</dd>
        <dt>Horas disponibles</dt><dd>${hms(metric.duration_seconds)}</dd>
        <dt>Uso medio/día</dt><dd>${hms(metric.scheduled_seconds_per_day)}</dd>
        <dt>Cobertura</dt><dd>${metric.coverage_days === null ? "—" : `${num(metric.coverage_days,2)} días`}</dd>
        <dt>Faltan para ${data.target_coverage_days} días</dt><dd>${metric.missing_seconds ? hms(metric.missing_seconds) : "0"}</dd>
        <dt>Estado</dt><dd>${statusLabels[metric.status] || metric.status}</dd>
      </dl>
    </div>`;
  }

  function videoRow(media) {
    const st = media.schedule_stats || {};
    return `<button class="video-row" type="button" data-media="${esc(media.media_id)}">
      <img src="${esc(media.thumbnail || "https://tv.archipielagovivo.org/logo.svg")}" alt="" loading="lazy">
      <div class="video-main"><strong>${esc(media.title)}</strong><span>${esc(media.channel_title || media.source || "Sin fuente")}</span></div>
      <div class="video-cell"><strong>${shortDuration(media.duration_seconds)}</strong><span>duración</span></div>
      <div class="video-cell hide-mobile"><strong>${st.airs_next_7d || 0}</strong><span>emisiones / 7d</span></div>
      <div class="video-cell hide-mobile"><strong>${fmtDate(st.next_air)}</strong><span>próxima</span></div>
      <div class="video-cell hide-mobile"><strong>${st.min_gap_seconds ? hms(st.min_gap_seconds) : "—"}</strong><span>separación mínima</span></div>
    </button>`;
  }

  function sortedMedia(media, mode) {
    return [...media].sort((a,b) => {
      if (mode === "title") return a.title.localeCompare(b.title,"es");
      if (mode === "duration") return b.duration_seconds - a.duration_seconds;
      if (mode === "next") return (Date.parse(a.schedule_stats.next_air || "9999") || Infinity) - (Date.parse(b.schedule_stats.next_air || "9999") || Infinity);
      return (b.schedule_stats.airs_next_7d || 0) - (a.schedule_stats.airs_next_7d || 0);
    });
  }

  function attachProgram(program, node) {
    const head = node.querySelector(".program-head");
    const body = node.querySelector(".program-body");
    const metric = activeChannelMetric(program);
    const status = metric ? metric.status : program.summary.worst_status;
    node.querySelector(".status-pill").className = `status-pill ${status || "unused"}`;
    node.querySelector("h2").textContent = program.name;
    node.querySelector(".program-description").textContent = program.description || "";
    node.querySelector(".program-metrics").innerHTML = [
      [program.summary.unique_videos, "vídeos"],
      [hms(program.summary.duration_seconds), "disponibles"],
      [program.summary.scheduled_airings_7d, "emisiones/7d"],
      [metric && metric.coverage_days !== null ? `${num(metric.coverage_days,2)} d` : "—", "cobertura mínima"]
    ].map(([v,l]) => `<div class="metric"><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join("");

    node.querySelector(".coverage-grid").innerHTML = data.channels
      .map(channel => coverageCard(channel, program.channels[channel.channel_id]))
      .join("") || `<div class="empty">Este programa no tiene horas asignadas en la parrilla compilada.</div>`;

    const count = node.querySelector(".video-count");
    const videos = node.querySelector(".videos");
    const sorter = node.querySelector(".video-sort");
    const renderVideos = () => {
      const channel = $("channelFilter").value;
      let media = program.media;
      if (channel) media = media.filter(m => (m.channels || []).includes(channel));
      count.textContent = `${media.length} vídeos`;
      videos.innerHTML = sortedMedia(media, sorter.value).map(videoRow).join("") || `<div class="empty">No hay vídeos elegibles con este filtro.</div>`;
      videos.querySelectorAll("[data-media]").forEach(btn => btn.addEventListener("click", () => openVideo(program, btn.dataset.media)));
    };
    renderVideos();
    sorter.addEventListener("change", renderVideos);

    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
    });
  }

  function renderPrograms() {
    const target = $("programs");
    target.replaceChildren();
    const list = sortPrograms(data.programs.filter(programMatches));
    if (!list.length) {
      target.innerHTML = `<div class="empty">No hay resultados.</div>`;
      return;
    }
    for (const program of list) {
      const node = $("programTemplate").content.firstElementChild.cloneNode(true);
      attachProgram(program, node);
      target.appendChild(node);
    }
  }

  function openVideo(program, mediaId) {
    const media = program.media.find(m => m.media_id === mediaId);
    if (!media) return;
    const st = media.schedule_stats || {};
    const channelNames = Object.entries(st.channels || {}).map(([id,count]) => {
      const c = data.channels.find(x => x.channel_id === id);
      return `${c ? c.name : id}: ${count}`;
    }).join(" · ") || "Sin emisiones";

    const alerts = [];
    if ((st.airs_next_7d || 0) >= 10) alerts.push(`Repetición alta: ${st.airs_next_7d} emisiones previstas en 7 días.`);
    if (st.min_gap_seconds && st.min_gap_seconds < 6 * 3600) alerts.push(`Separación mínima corta: ${hms(st.min_gap_seconds)}.`);
    if (!media.tv_description) alerts.push("Falta descripción editorial para TV.");

    $("videoDetail").innerHTML = `
      <div class="detail-head">
        <img src="${esc(media.thumbnail || "https://tv.archipielagovivo.org/logo.svg")}" alt="">
        <div>
          <span class="kicker">${esc(program.name)}</span>
          <h2>${esc(media.title)}</h2>
          <div class="detail-meta">${esc(media.channel_title || media.source || "Sin fuente")} · ${shortDuration(media.duration_seconds)} · ${esc(media.type || "sin tipo")}</div>
          ${alerts.length ? `<p>${alerts.map(esc).join("<br>")}</p>` : ""}
          ${media.youtube_id ? `<p><a href="https://www.youtube.com/watch?v=${encodeURIComponent(media.youtube_id)}" target="_blank" rel="noopener noreferrer">Abrir vídeo original en YouTube</a></p>` : ""}
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-card"><span>Emisiones próximas 24 h</span><strong>${st.airs_next_24h || 0}</strong></div>
        <div class="detail-card"><span>Emisiones en parrilla de 7 días</span><strong>${st.airs_next_7d || 0}</strong></div>
        <div class="detail-card"><span>Tiempo emitido / 7 días</span><strong>${hms(st.total_air_seconds_7d)}</strong></div>
        <div class="detail-card"><span>Próxima emisión</span><strong>${fmtDate(st.next_air)}</strong></div>
        <div class="detail-card"><span>Separación media</span><strong>${st.average_gap_seconds ? hms(st.average_gap_seconds) : "—"}</strong></div>
        <div class="detail-card"><span>Separación mínima</span><strong>${st.min_gap_seconds ? hms(st.min_gap_seconds) : "—"}</strong></div>
        <div class="detail-card"><span>Canales</span><strong>${esc(channelNames)}</strong></div>
        <div class="detail-card"><span>ID</span><strong>${esc(media.media_id)}</strong></div>
      </div>
      <h3 class="section-title">Descripción editorial</h3>
      <p>${esc(media.tv_description || "Sin descripción editorial.")}</p>
      <h3 class="section-title">Etiquetas</h3>
      <div class="tags">${(media.tags || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join("") || `<span class="tag">Sin etiquetas</span>`}</div>
      <h3 class="section-title">Horarios previstos · próximos ${data.horizon_days} días</h3>
      <table class="airings">
        <thead><tr><th>Fecha y hora</th><th>Canal</th><th>Programa</th><th>Tiempo emitido</th></tr></thead>
        <tbody>${(st.airings || []).map(a => {
          const c = data.channels.find(x => x.channel_id === a.channel_id);
          return `<tr><td>${esc(fmtDate(a.start))}</td><td>${esc(c ? c.name : a.channel_id)}</td><td>${esc(program.name)}</td><td>${esc(hms(a.air_seconds))}</td></tr>`;
        }).join("") || `<tr><td colspan="4">No hay emisiones previstas.</td></tr>`}</tbody>
      </table>`;
    $("videoDialog").showModal();
  }

  async function init() {
    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
      renderSummary();
      renderChannels();
      renderPrograms();
      ["search","channelFilter","statusFilter","sortBy"].forEach(id => {
        $(id).addEventListener(id === "search" ? "input" : "change", renderPrograms);
      });
      $("dialogClose").addEventListener("click", () => $("videoDialog").close());
      $("videoDialog").addEventListener("click", event => {
        if (event.target === $("videoDialog")) $("videoDialog").close();
      });
    } catch (error) {
      $("programs").innerHTML = `<div class="empty">No se pudo cargar catalog-stats.json: ${esc(error.message || error)}</div>`;
    }
  }

  init();
})();
