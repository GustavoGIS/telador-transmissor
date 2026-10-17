(() => {
  const $ = (id) => document.getElementById(id);
  const nameEl = $("name");
  const keyEl = $("key");
  const qualityEl = $("quality");
  const customBox = $("customBox");
  const cqW = $("cqW");
  const cqH = $("cqH");
  const cqFps = $("cqFps");
  const cqBr = $("cqBr");
  const boot = $("boot");
  const bootText = $("bootText");
  const toast = $("toast");
  const toastText = $("toastText");
  const toastIco = $("toastIco");
  const toastActions = $("toastActions");
  const toastAccept = $("toastAccept");
  const toastDecline = $("toastDecline");
  const dot = $("dot");
  const hdot = $("hdot");
  const healthText = $("healthText");
  const statusText = $("statusText");
  const statsText = $("statsText");
  const ver = $("ver");
  const sourceList = $("sourceList");
  const sourceLabel = $("sourceLabel");
  const tabScreen = $("tabScreen");
  const tabWindow = $("tabWindow");
  const filterEl = $("filter");
  const audioWarn = $("audioWarn");

  const ROW_H = 62;
  const OVERSCAN = 8;

  let tab = "screen";
  let sources = [];
  let filtered = [];
  let selectedId = "";
  let selectedName = "";
  let focusIndex = 0;
  let ui = { transmitting: false, switching: false, phase: "idle", status: "Aguardando" };
  let connecting = false;
  let connectTimer = null;
  let keyVisible = false;
  let pendingUpdate = "";
  let thumbsLoading = false;
  let scrollTop = 0;
  let toastTimer = null;
  let stickyPresent = false;
  let presentResponding = false;

  const PHASE_LABEL = {
    idle: "Aguardando",
    connecting: "Conectando…",
    connected: "Conectado",
    live: "Transmitindo",
    switching: "Alterando fonte…",
    error: "Erro",
  };

  function setBoot(on, text) {
    boot.classList.toggle("is-on", !!on);
    boot.setAttribute("aria-hidden", on ? "false" : "true");
    if (text) bootText.textContent = text;
  }

  function hideToast() {
    if (stickyPresent) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.classList.remove("is-on");
    setTimeout(() => {
      if (!toast.classList.contains("is-on") && !stickyPresent) toast.hidden = true;
    }, 200);
  }

  function clearPresentToastUi() {
    stickyPresent = false;
    presentResponding = false;
    if (toastActions) toastActions.hidden = true;
    toast.classList.remove("is-action");
    if (toastAccept) toastAccept.disabled = false;
    if (toastDecline) toastDecline.disabled = false;
  }

  function showPresentToast(info) {
    const from = info && info.from ? String(info.from).trim() : "";
    const msg = from
      ? `Pedido de transmissão de ${from}. Aceitar?`
      : "Pedido de transmissão pela sala. Aceitar?";
    stickyPresent = true;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.hidden = false;
    toast.classList.remove("is-error", "is-ok", "is-warn");
    toast.classList.add("is-warn", "is-action");
    toastText.textContent = msg;
    setIcon(toastIco, "#i-broadcast");
    if (toastActions) toastActions.hidden = false;
    if (toastAccept) toastAccept.disabled = false;
    if (toastDecline) toastDecline.disabled = false;
    requestAnimationFrame(() => toast.classList.add("is-on"));
  }

  function hidePresentToast() {
    clearPresentToastUi();
    toast.classList.remove("is-on", "is-warn", "is-error", "is-ok");
    setTimeout(() => {
      if (!toast.classList.contains("is-on") && !stickyPresent) toast.hidden = true;
    }, 200);
  }

  async function respondPresent(accepted) {
    if (!stickyPresent || presentResponding) return;
    presentResponding = true;
    if (toastAccept) toastAccept.disabled = true;
    if (toastDecline) toastDecline.disabled = true;
    try {
      if (window.telador && window.telador.respondPresent) {
        await window.telador.respondPresent(!!accepted);
      }
    } catch (e) {}
    hidePresentToast();
    if (accepted) setHint("Iniciando transmissão…", "ok");
    else setHint("Pedido recusado", "warn");
  }

  function setHint(text, kind) {
    if (stickyPresent) return;
    const t = String(text || "").trim();
    if (!t) {
      hideToast();
      return;
    }
    const k = kind === "error" || kind === "warn" || kind === "ok" ? kind : "ok";
    toast.hidden = false;
    toast.classList.remove("is-error", "is-ok", "is-warn", "is-action");
    toast.classList.add("is-" + k);
    if (toastActions) toastActions.hidden = true;
    toastText.textContent = t;
    setIcon(toastIco, k === "error" ? "#i-warn" : (k === "warn" ? "#i-warn" : "#i-check"));
    requestAnimationFrame(() => toast.classList.add("is-on"));
    if (toastTimer) clearTimeout(toastTimer);
    const lines = t.split("\n").length;
    const ms = k === "error" ? 8000 : (lines > 1 ? 7000 : (k === "warn" ? 5000 : 3500));
    toastTimer = setTimeout(hideToast, ms);
  }

  function setIcon(el, href) {
    if (!el) return;
    const use = el.querySelector("use");
    if (use) use.setAttribute("href", href);
  }

  function setConnectBusy(on) {
    connecting = !!on;
    $("btnConnect").disabled = on;
    $("spinConnect").hidden = !on;
    $("icoConnect").hidden = !!on;
    $("labelConnect").textContent = on ? "Conectando…" : "Conectar";
    $("btnCancelConnect").hidden = !on;
    if (!on && connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function setTxBusy(on) {
    $("spinTx").hidden = !on;
    $("icoTx").hidden = !!on;
    $("labelTx").textContent = on ? "Aguarde…" : "Transmitir";
    const blocked = on || ui.switching || ui.phase === "switching";
    $("btnTransmit").disabled = blocked;
    $("btnStop").disabled = blocked || !ui.transmitting;
    tabScreen.disabled = blocked;
    tabWindow.disabled = blocked;
    $("btnRefresh").disabled = blocked;
  }

  function readCustom() {
    return {
      width: parseInt(cqW.value, 10) || 1920,
      height: parseInt(cqH.value, 10) || 1080,
      frameRate: parseInt(cqFps.value, 10) || 60,
      maxBitrate: Math.round((parseFloat(cqBr.value) || 14) * 1e6),
    };
  }

  function fillCustom(c) {
    const x = c || {};
    cqW.value = x.width || 1920;
    cqH.value = x.height || 1080;
    cqFps.value = x.frameRate || 60;
    cqBr.value = x.maxBitrate ? (x.maxBitrate / 1e6) : 14;
  }

  function fillPresets(presets, selected) {
    const list = Array.isArray(presets) && presets.length
      ? presets
      : [
          { id: "high", label: "Alto (1080p30)" },
          { id: "balanced", label: "Equilibrado (720p30)" },
          { id: "economy", label: "Economia (720p20)" },
          { id: "custom", label: "Personalizado" },
        ];
    const sel = selected === "ultra" ? "high" : selected;
    qualityEl.innerHTML = "";
    for (const p of list) {
      if (p.id === "ultra") continue;
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === sel) opt.selected = true;
      qualityEl.appendChild(opt);
    }
    customBox.hidden = qualityEl.value !== "custom";
  }

  let copyFlashTimer = null;

  function flashCopied(btn) {
    if (!btn) return;
    const prevTitle = btn.title;
    btn.classList.add("is-copied");
    btn.title = "Copiado.";
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.title = prevTitle || "Copiar";
    }, 1600);
  }

  async function copyCodeSilent(code, btn) {
    const value = String(code || "").trim();
    if (!value) {
      setHint("Nenhum código para copiar", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      flashCopied(btn);
      setHint("Copiado.", "ok");
    } catch {
      setHint("Não foi possível copiar", "error");
    }
  }

  function recomputeFiltered() {
    const q = (filterEl.value || "").trim().toLowerCase();
    filtered = sources.filter((s) => {
      if (s.type !== tab) return false;
      if (q && !String(s.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
    if (focusIndex >= filtered.length) focusIndex = Math.max(0, filtered.length - 1);
  }

  function renderList() {
    recomputeFiltered();
    const viewH = sourceList.clientHeight || 280;
    const total = filtered.length;
    if (!total) {
      sourceList.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = tab === "screen"
        ? (filterEl.value ? "Nenhuma tela corresponde ao filtro" : "Nenhuma tela encontrada")
        : (filterEl.value ? "Nenhum aplicativo corresponde ao filtro" : "Nenhum aplicativo encontrado");
      sourceList.appendChild(empty);
      return;
    }

    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visible = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
    const end = Math.min(total, start + visible);

    const inner = document.createElement("div");
    inner.className = "list-inner";
    inner.style.height = total * ROW_H + "px";

    for (let i = start; i < end; i++) {
      const s = filtered[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "item"
        + (s.id === selectedId ? " is-on" : "")
        + (i === focusIndex ? " is-focus" : "");
      btn.style.position = "absolute";
      btn.style.top = i * ROW_H + "px";
      btn.style.left = "0";
      btn.style.right = "0";
      btn.style.height = ROW_H + "px";

      const mark = document.createElement("i");
      mark.className = "mark";
      btn.appendChild(mark);

      if (s.thumb) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.alt = "";
        img.src = s.thumb;
        btn.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "thumb is-empty";
        ph.innerHTML = tab === "screen"
          ? '<svg class="ico"><use href="#i-monitor"></use></svg>'
          : '<svg class="ico"><use href="#i-app"></use></svg>';
        btn.appendChild(ph);
      }

      const span = document.createElement("span");
      span.textContent = s.name;
      btn.appendChild(span);

      btn.onclick = () => {
        selectedId = s.id;
        selectedName = s.name;
        focusIndex = i;
        sourceLabel.textContent = s.name;
        renderList();
      };
      inner.appendChild(btn);
    }

    sourceList.innerHTML = "";
    sourceList.appendChild(inner);
    sourceList.scrollTop = scrollTop;
  }

  function applyHealth(stats) {
    const s = stats || {};
    const health = s.health || "idle";
    hdot.className = "hdot";
    if (health === "excellent" || health === "good") hdot.classList.add("is-" + health);
    else if (health === "fair") hdot.classList.add("is-fair");
    else if (health === "bad") hdot.classList.add("is-bad");

    const labels = {
      idle: "Rede —",
      excellent: "Rede excelente",
      good: "Rede boa",
      fair: "Rede instável",
      bad: "Rede ruim",
    };
    healthText.textContent = labels[health] || "Rede —";

    if (ui.transmitting && (s.bitrate || s.rtt || s.loss != null || s.fps)) {
      const mb = s.bitrate ? (s.bitrate / 1e6).toFixed(1) + " Mb/s" : "—";
      const loss = s.loss != null ? (s.loss * 100).toFixed(1) + "%" : "—";
      const rtt = s.rtt ? Math.round(s.rtt) + " ms" : "—";
      const fps = s.fps ? Math.round(s.fps) + " fps" : "";
      statsText.textContent = [mb, fps, "perda " + loss, "RTT " + rtt]
        .concat(s.codec ? [s.codec.replace("video/", "")] : [])
        .filter(Boolean)
        .join(" · ");
    } else {
      statsText.textContent = "";
    }
  }

  function applyPhaseDot(phase, status) {
    dot.classList.remove("is-live", "is-busy", "is-err", "is-warn");
    if (phase === "error" || /erro/i.test(status)) dot.classList.add("is-err");
    else if (phase === "switching" || phase === "connecting") dot.classList.add("is-busy");
    else if (phase === "live" || ui.transmitting) dot.classList.add("is-live");
    else if (ui.audioOk === false && ui.transmitting) dot.classList.add("is-warn");
  }

  function applyUi(state) {
    if (!state) return;
    ui = Object.assign(ui, state);
    if (state.version) ver.textContent = "v" + state.version;

    const phase = String(state.phase || "idle");
    const status = String(state.status || PHASE_LABEL[phase] || "Aguardando");
    statusText.textContent = status;
    applyPhaseDot(phase, status);
    applyHealth(state.stats);

    if (state.sourceId) selectedId = state.sourceId;
    if (state.sourceName) {
      selectedName = state.sourceName;
      sourceLabel.textContent = state.sourceName;
    } else if (!selectedName) {
      sourceLabel.textContent = "Nenhuma";
    }

    if (state.sourceTab === "screen" || state.sourceTab === "window") {
      setTab(state.sourceTab, false);
    }

    if (Array.isArray(state.presets)) {
      fillPresets(state.presets, state.qualityPreset || qualityEl.value);
    } else if (state.qualityPreset) {
      qualityEl.value = state.qualityPreset;
      customBox.hidden = qualityEl.value !== "custom";
    }
    if (state.customQuality) fillCustom(state.customQuality);
    audioWarn.classList.toggle("is-on", state.audioOk === false && !!state.transmitting);

    const busy = phase === "switching" || phase === "connecting" || !!state.switching;
    $("btnStop").disabled = busy || !state.transmitting;
    $("btnTransmit").disabled = busy;
    setTxBusy(busy && (state.transmitting || state.switching || phase === "switching"));

    if (connecting && (phase === "connected" || phase === "live")) {
      setConnectBusy(false);
      setBoot(false);
      setHint(phase === "live" ? "Transmitindo" : "Conectado", "ok");
    }
    if (connecting && phase === "error") {
      setConnectBusy(false);
      setBoot(false);
      setHint(status, "error");
    }

    if (state.updateVersion) {
      pendingUpdate = state.updateVersion;
      $("lblCheckUpdate").textContent = "Atualização v" + state.updateVersion;
    } else {
      pendingUpdate = "";
      $("lblCheckUpdate").textContent = "Verificar atualizações";
    }

    if (typeof state.updateProgress === "number" && state.updateProgress > 0 && state.updateProgress < 100) {
      $("updProgress").classList.add("is-on");
      $("updBar").style.width = state.updateProgress + "%";
      setHint("Baixando atualização… " + state.updateProgress + "%", "ok");
    } else if (state.updateProgress >= 100) {
      $("updProgress").classList.add("is-on");
      $("updBar").style.width = "100%";
      setHint("Download concluído — reiniciando…", "ok");
    } else {
      $("updProgress").classList.remove("is-on");
    }

    if (state.firstRunSeen === false) {
      openModal("firstRunModal", true);
    }

    if (state.pendingPresent) {
      showPresentToast(state.pendingPresent);
    } else if (stickyPresent && !presentResponding) {
      hidePresentToast();
    }
  }

  function setTab(next, persist) {
    tab = next === "window" ? "window" : "screen";
    tabScreen.classList.toggle("is-on", tab === "screen");
    tabWindow.classList.toggle("is-on", tab === "window");
    scrollTop = 0;
    renderList();
    if (persist !== false && window.telador && window.telador.setTab) {
      window.telador.setTab(tab).catch(() => {});
    }
  }

  async function refreshSources() {
    try {
      const list = await window.telador.listSources({ thumbs: false });
      sources = Array.isArray(list) ? list : [];
      renderList();
      loadThumbsLazy();
    } catch (e) {
      setHint("Falha ao listar fontes", "error");
    }
  }

  async function loadThumbsLazy() {
    if (thumbsLoading) return;
    thumbsLoading = true;
    try {
      const withThumbs = await window.telador.listSourceThumbs();
      if (!Array.isArray(withThumbs)) return;
      const map = new Map(withThumbs.map((s) => [s.id, s.thumb]));
      for (const s of sources) {
        if (map.has(s.id)) s.thumb = map.get(s.id) || "";
      }
      renderList();
    } catch (e) {
    } finally {
      thumbsLoading = false;
    }
  }

  function openModal(id, on) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function showPreflight(result) {
    if (!result || !Array.isArray(result.checks) || !result.checks.length) {
      setHint("Não foi possível verificar", "warn");
      return;
    }
    const failed = result.checks.filter((c) => !c.ok);
    if (!failed.length) {
      setHint("Tudo certo — pronto para conectar", "ok");
      return;
    }
    const labels = {
      audio: "Áudio",
      livekit: "LiveKit",
      token: "Código da sala",
      sdk: "SDK",
    };
    const lines = failed.map((c) => {
      const title = labels[c.id] || c.id || "Item";
      let msg = String(c.message || "falhou").replace(/^✓\s*|^✗\s*/, "");
      msg = msg.replace(/wss:\/\/[^\s]+/i, (u) => u.replace(/^wss:\/\//i, ""));
      return title + ": " + msg;
    });
    setHint(
      (failed.length === 1 ? "Problema encontrado\n" : "Problemas encontrados\n") + lines.join("\n"),
      "error"
    );
  }

  async function applyQuality() {
    const id = qualityEl.value;
    const payload = id === "custom" ? { id, custom: readCustom() } : id;
    await window.telador.setQuality(payload);
    setHint(
      ui.transmitting
        ? "Qualidade aplicada na transmissão atual"
        : "Qualidade salva — vale na próxima transmissão",
      "ok"
    );
  }

  sourceList.addEventListener("scroll", () => {
    scrollTop = sourceList.scrollTop;
    renderList();
  });

  sourceList.addEventListener("keydown", (e) => {
    if (!filtered.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusIndex = Math.min(filtered.length - 1, focusIndex + 1);
      scrollTop = Math.max(scrollTop, focusIndex * ROW_H - (sourceList.clientHeight - ROW_H));
      renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusIndex = Math.max(0, focusIndex - 1);
      scrollTop = Math.min(scrollTop, focusIndex * ROW_H);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = filtered[focusIndex];
      if (!s) return;
      selectedId = s.id;
      selectedName = s.name;
      sourceLabel.textContent = s.name;
      renderList();
      $("btnTransmit").click();
    }
  });

  tabScreen.onclick = () => setTab("screen");
  tabWindow.onclick = () => setTab("window");
  filterEl.oninput = () => {
    scrollTop = 0;
    renderList();
  };
  $("btnRefresh").onclick = () => refreshSources();

  $("btnCopyKey").onclick = () => {
    copyCodeSilent(keyEl.value, $("btnCopyKey"));
  };

  $("btnToggleKey").onclick = () => {
    keyVisible = !keyVisible;
    keyEl.type = keyVisible ? "text" : "password";
    const btn = $("btnToggleKey");
    btn.title = keyVisible ? "Ocultar" : "Mostrar";
    btn.setAttribute("aria-label", btn.title);
    setIcon($("icoToggleKey"), keyVisible ? "#i-eye-off" : "#i-eye");
  };

  qualityEl.onchange = () => {
    customBox.hidden = qualityEl.value !== "custom";
    applyQuality().catch(() => setHint("Não foi possível alterar a qualidade", "error"));
  };
  [cqW, cqH, cqFps, cqBr].forEach((el) => {
    el.onchange = () => {
      if (qualityEl.value === "custom") {
        applyQuality().catch(() => {});
      }
    };
  });

  $("btnPreflight").onclick = async () => {
    setBoot(true, "Verificando…");
    try {
      const result = await window.telador.preflight({
        name: nameEl.value.trim(),
        key: keyEl.value.trim(),
      });
      showPreflight(result);
    } catch (e) {
      setHint("Falha na verificação", "error");
    } finally {
      setBoot(false);
    }
  };

  $("btnConnect").onclick = async () => {
    try {
      const name = nameEl.value.trim();
      const key = keyEl.value.trim();
      if (!name || !key) {
        setHint("Informe o nome de exibição e o código da sala", "warn");
        return;
      }
      setBoot(true, "Verificando…");
      const pf = await window.telador.preflight({ name, key });
      const token = (pf.checks || []).find((c) => c.id === "token");
      if (token && !token.ok) {
        setBoot(false);
        setHint(token.message, "error");
        return;
      }
      setConnectBusy(true);
      setBoot(true, "Conectando…");
      const payload = {
        name,
        key,
        qualityPreset: qualityEl.value,
      };
      if (qualityEl.value === "custom") payload.customQuality = readCustom();
      const ok = await window.telador.saveConfig(payload);
      if (!ok) {
        setConnectBusy(false);
        setBoot(false);
        setHint("Não foi possível salvar a configuração", "error");
        return;
      }
      connectTimer = setTimeout(() => {
        if (connecting) {
          setConnectBusy(false);
          setBoot(false);
          setHint("A conexão está demorando. Verifique o código da sala.", "warn");
        }
      }, 20000);
    } catch (e) {
      setConnectBusy(false);
      setBoot(false);
      setHint("Erro: " + (e.message || e), "error");
    }
  };

  $("btnCancelConnect").onclick = async () => {
    setConnectBusy(false);
    setBoot(false);
    setHint("Conexão cancelada", "warn");
    try { await window.telador.restartConnection(); } catch (e) {}
  };

  $("btnTransmit").onclick = async () => {
    if (!selectedId) {
      setHint("Selecione uma tela ou um aplicativo", "warn");
      return;
    }
    try {
      setBoot(true, ui.transmitting ? "Alterando fonte…" : "Iniciando transmissão…");
      setTxBusy(true);
      await window.telador.selectSourceAndShare({
        sourceId: selectedId,
        sourceName: selectedName,
        sourceType: tab,
      });
    } catch (e) {
      setHint("Erro: " + (e.message || e), "error");
    } finally {
      setBoot(false);
      setTxBusy(false);
    }
  };

  $("btnStop").onclick = async () => {
    try {
      setBoot(true, "Parando…");
      await window.telador.stopShare();
    } catch (e) {
      setHint("Não foi possível interromper a transmissão", "error");
    } finally {
      setBoot(false);
    }
  };

  $("btnRestart").onclick = async () => {
    setBoot(true, "Reiniciando conexão…");
    try { await window.telador.restartConnection(); } finally { setBoot(false); }
  };

  $("btnTestAudio").onclick = async () => {
    setBoot(true, "Testando áudio…");
    try {
      const r = await window.telador.testAudio();
      setHint(r.message, r.ok ? "ok" : "error");
    } catch (e) {
      setHint("Falha no teste de áudio", "error");
    } finally {
      setBoot(false);
    }
  };

  $("btnCheckUpdate").onclick = async () => {
    $("updProgress").classList.remove("is-on");
    setBoot(true, "Verificando atualizações…");
    let keepBoot = false;
    try {
      const result = await window.telador.checkUpdateFlow();
      if (!result) {
        setHint("Falha ao verificar atualizações", "error");
        return;
      }
      if (result.status === "uptodate") {
        setHint("Você já está na versão mais recente", "ok");
        return;
      }
      if (result.status === "declined") {
        setHint("Atualização adiada", "warn");
        return;
      }
      if (result.status === "installing") {
        pendingUpdate = result.version || "";
        keepBoot = true;
        setBoot(true, "Baixando v" + (result.version || "") + "…");
        $("updProgress").classList.add("is-on");
        return;
      }
      if (result.status === "failed") {
        setHint(result.message || "Falha ao instalar atualização", "error");
      }
    } catch (e) {
      setHint("Falha ao verificar atualizações", "error");
    } finally {
      if (!keepBoot) setBoot(false);
    }
  };

  $("btnDiag").onclick = async () => {
    try {
      await window.telador.diagnostic();
      setHint("Diagnóstico copiado para a área de transferência", "ok");
    } catch (e) {
      setHint("Falha ao copiar diagnóstico", "error");
    }
  };

  $("btnLogs").onclick = () => window.telador.openLogs();

  $("btnQuit").onclick = () => {
    if (ui.transmitting) openModal("quitModal", true);
    else window.telador.quitApp();
  };
  $("btnQuitCancel").onclick = () => openModal("quitModal", false);
  $("btnQuitConfirm").onclick = () => {
    openModal("quitModal", false);
    window.telador.quitApp();
  };
  $("btnFirstRunOk").onclick = async () => {
    openModal("firstRunModal", false);
    try { await window.telador.firstRunSeen(); } catch (e) {}
  };

  $("toastClose").onclick = () => {
    if (stickyPresent) respondPresent(false);
    else hideToast();
  };
  if (toastAccept) toastAccept.onclick = () => respondPresent(true);
  if (toastDecline) toastDecline.onclick = () => respondPresent(false);

  (async () => {
    setBoot(true, "Carregando…");
    try {
      if (!window.telador) throw new Error("preload ausente");
      const [cfg, state] = await Promise.all([
        window.telador.getConfig(),
        window.telador.getUiState(),
      ]);
      fillPresets((state && state.presets) || [], (cfg && cfg.qualityPreset) || (state && state.qualityPreset) || "balanced");
      if (cfg) {
        nameEl.value = cfg.name || "";
        keyEl.value = cfg.key || "";
        if (cfg.sourceId) selectedId = cfg.sourceId;
        if (cfg.sourceName) {
          selectedName = cfg.sourceName;
          sourceLabel.textContent = cfg.sourceName;
        }
        if (cfg.customQuality) fillCustom(cfg.customQuality);
        const t = cfg.sourceTab || cfg.sourceType;
        if (t === "window") setTab("window", false);
      }
      applyUi(state || {});
      await refreshSources();
      window.telador.onUiState(applyUi);
      if (window.telador.onConfirmQuit) {
        window.telador.onConfirmQuit(() => openModal("quitModal", true));
      }
      if (window.telador.onSound) {
        window.telador.onSound((name) => {
          try {
            if (window.teladorSounds && typeof window.teladorSounds.play === "function") {
              window.teladorSounds.play(name);
            }
          } catch (e) {}
        });
      }
    } catch (e) {
      setHint("Erro: " + (e.message || e), "error");
    } finally {
      setBoot(false);
    }
  })();
})();
