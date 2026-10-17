# Telador Transmissor

Cliente **Electron (Windows)** que captura tela ou janela + áudio do app e publica no **LiveKit** como broadcaster do ecossistema Telador.

Este repositório é **só o app desktop de transmissão**. O produto Telador completo também inclui:

| Peça | Onde | Papel |
|------|------|--------|
| **Site** | `telador.vercel.app` (repo `GustavoGIS/telador`) | Salas, token API, viewers, UI web |
| **Discord Activity** | mesmo ecossistema | Experiência embutida no Discord |
| **Telador Transmissor** | este repo | Broadcaster nativo Windows (tela/app + áudio) |

Use este README para alinhar contratos com a IA que mantém o site e a Activity.

---

## Papel no produto

1. O usuário abre o **painel** (janela Electron), informa **nome** e **código da sala**.
2. O app pede token em `GET https://telador.vercel.app/api/token?role=broadcaster&name=…&key=…`.
3. Conecta ao LiveKit (`wss://…`) e publica:
   - vídeo: `screen_share`
   - áudio: `screen_share_audio` (loopback WASAPI via `native/audio-exclude.exe` → PCM → `MediaStreamTrackGenerator`)
4. Viewers (site / Discord Activity) entram na **mesma sala** como assinantes e assistem.

O transmissor **não** hospeda a sala: o backend do site é a fonte da verdade do token e do nome da sala.

---

## Contratos com o site / Activity (importante)

### Token

- Endpoint: `/api/token`
- Query usada pelo app: `role=broadcaster`, `name`, `key` (código da sala)
- Resposta esperada (sucesso): JSON com pelo menos `token` e, de preferência, `room`
- Erro: JSON com `error` (string) + status HTTP ≠ 2xx  
  → o app mostra toast e, para erros “soft” (código inválido etc.), **não** fica em retry agressivo

Manter esse contrato estável evita quebrar o Conectar do desktop.

### LiveKit URL

- O app descobre o host `wss://` a partir do bundle público do site (`/transmissor.html` + assets), com fallback embutido.
- Também persiste `livekitUrl` no `config.json` local após a primeira conexão bem-sucedida.
- Site e Activity devem usar o **mesmo projeto LiveKit** (ou o discovery deve continuar apontando para o host correto).

### Tracks / sources LiveKit

| Source | Conteúdo |
|--------|----------|
| `screen_share` | Vídeo da tela ou janela escolhida |
| `screen_share_audio` | Áudio do processo/janela (não microfone misturado, na versão atual) |

Codec preferido de vídeo: **H.264** (fallback VP8 nos hooks). Áudio stereo, bitrate ~256 kbps.

### Data channel (tópico `telador`)

Mensagens JSON usadas pelo app:

- `{ "type": "present", "target": "<nome>" }` — se `target` for o broadcaster local, o painel mostra toast sticky (Aceitar/Recusar) e só inicia share se aceito; senão, outro broadcaster pode forçar stop.
- `{ "type": "source-switch", "t": <timestamp> }` — publicado ao trocar de fonte (ajuda viewers a remountar).

Metadata local pode incluir `teladorSwitch` ao trocar fonte.

### Site coupling

- Worker local (`worker/`) embute `livekit-client` (sem CDN em runtime).
- Hooks de captura (`captureHooks.js`) são injetados pelo processo main no worker.
- Existe fallback de load para `${SITE}/transmissor.html` se o worker local falhar — o HTML remoto do site não deve assumir APIs que o Electron não fornece via `window.telador` (preload).

---

## Arquitetura do app (visão rápida)

```
┌─────────────┐     IPC      ┌──────────────────┐
│ panel/      │◄────────────►│ main.js          │
│ (UI Electron)│             │ tray, config,    │
└─────────────┘             │ desktopCapturer, │
                            │ áudio nativo     │
                            └────────┬─────────┘
                                     │ inject hooks + PCM
                            ┌────────▼─────────┐
                            │ worker/ (oculto) │
                            │ LiveKit Room     │
                            │ captureHooks.js  │
                            └────────┬─────────┘
                                     │ WebRTC
                            ┌────────▼─────────┐
                            │ LiveKit Cloud    │
                            └──────────────────┘
                                     ▲
                            site / Discord Activity (viewers)
```

Arquivos-chave:

- `main.js` — Electron main, tray, IPC, updates, pré-voo
- `panel/` — UI do painel (HTML/CSS/JS)
- `preload.js` — bridge `window.telador`
- `worker/app.js` — conexão LiveKit + token
- `captureHooks.js` — share, áudio generator, troca de fonte, bitrate adaptativo
- `processAudio.js` + `native/audio-exclude.exe` — captura WASAPI
- `quality.js` / `configSchema.js` — presets e config
- `updater.js` — update portable via GitHub Releases (`GustavoGIS/telador`)

---

## UX do painel (resumo)

- Conectar / Verificar (pré-voo: áudio exe, LiveKit, token, SDK)
- Lista Telas / Aplicativos, Transmitir / Parar
- Qualidade: Muito alto (1080p60), Alto (1080p30), Equilibrado (720p30), Economia (720p20), Personalizado
- Opções: reiniciar, testar áudio, verificar updates, diagnóstico, logs, sair
- Feedback em **toast** (não embutido no formulário)
- Fechar janela → app fica na **bandeja**; atalhos Ctrl+Shift+T / S / R

---

## Build e versão

- Stack: Electron, electron-builder **portable** Windows
- Versão atual: ver `package.json` (`0.2.5` no momento deste README)
- Artefato: `Telador-Transmissor-${version}.exe`
- Releases deste app: GitHub Releases neste repo (`GustavoGIS/telador-transmissor`)
- Releases antigas (até v0.2.1) ficaram em `GustavoGIS/telador`
- Auto-update do app consulta as Releases deste repositório
- Áudio nativo: `npm run build:native` (C# → `native/audio-exclude.exe`)

Comandos:

```bash
npm install
npm start                 # desenvolvimento
npm run build             # icon + vendor LiveKit + native + portable
```

---

## O que o site / Discord Activity devem garantir

1. **Mesma sala** para broadcaster (este app) e viewers (web/Activity).
2. API de token com `role=broadcaster` (e roles de viewer/activity conforme já existirem).
3. Player de viewer assinando `screen_share` + `screen_share_audio` (não só câmera/mic).
4. Tratar `source-switch` / metadata para remount limpo ao trocar fonte no desktop.
5. Não depender de playout local do áudio no broadcaster (o app silencia media elements de propósito para evitar eco/duplo áudio).
6. Se a Activity rodar em ambiente restrito, o **broadcaster continua sendo este app Windows** — a Activity é tipicamente viewer/controle, não substituto do capturador nativo.

---

## Config local (userData)

`config.json` (normalizado por `configSchema.js`), campos principais:

- `name`, `key` — identidade e código da sala  
- `sourceId` / `sourceName` / `sourceType` / `sourceTab`  
- `qualityPreset`, `customQuality`  
- `livekitUrl`, `resumeShare`  
- `windowBounds`, `firstRunSeen`

Não commitar configs de usuário nem logs.

---

## Fora de escopo (hoje)

- Mistura de microfone com áudio do app  
- Autostart no Windows  
- Broadcaster dentro do Discord Activity (captura nativa é desktop)

---

## Contato do repositório

- App + releases do `.exe`: [GustavoGIS/telador-transmissor](https://github.com/GustavoGIS/telador-transmissor)
- Site / produto Telador: [GustavoGIS/telador](https://github.com/GustavoGIS/telador)
