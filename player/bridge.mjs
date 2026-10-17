/**
 * MusicLib MPRIS-мост: библиотека как обычный плеер для рабочего стола.
 *
 * Смысл: пульт не нужно придумывать — встроенный виджет omarchy.media (MPRIS
 * клиент Quickshell) сам находит любой плеер на session bus и рисует обложку,
 * исполнителя и кнопки prev/play/next.
 *
 * Составные части:
 *   - mpv играет треки (spawn c --idle=yes, живёт между треками), команды
 *     ходят по JSON IPC unix-сокету;
 *   - dbus-next экспортирует org.mpris.MediaPlayer2{,.Player};
 *   - очередь: список треков с /tracks на старте, хождение по кругу
 *     (LoopStatus=Playlist), потолок сервера — 200.
 *
 * Состояние держит мост, а не mpv: Metadata/trackid и переходы — это логика
 * плеера, а не файла. Поэтому рестарт mpv не сбивает «что играет».
 */

import dbus from "dbus-next";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// В dbus-next класс Interface живёт в подпакете interface, а не в корне.
const { Interface } = dbus.interface;
const { Variant } = dbus;

const SERVER = process.env.MUSICLIB_SERVER ?? "http://127.0.0.1:3000";
const BUS_NAME = "org.mpris.MediaPlayer2.musiclib";
const MPV_PATH = `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/music-lib-player/mpv.sock`;

/** URL трека: '/'-пути сервера дополняются префиксом. */
function url(id) {
  return `${SERVER}/audio/${id}`;
}

// ── состояние ───────────────────────────────────────────────────────────────

const state = {
  tracks: [],     // /tracks целиком, как отдал сервер
  index: 0,       // позиция в очереди: какие треки решает пользователь руками
  playing: false, // mpv pause=false и файл загружен
  loaded: false,  // в плеере вообще есть трек
  desiredPause: true, // что мы сами командовали mpv; истина в первой инстанции
  positionSec: 0,
  durationSec: null,
  volume: 100,    // mpv-шкала 0..100; в MPRIS отдаётся 0..1
};

/** interface используется в обработчиках событий раньше своего создания. */
let iface = null;
let observeId = 0;
/** Живой потомок mpv: нужен shutdown'у, чтобы уйти вместе со звуком. */
let mpvProc = null;

// ── Metadata ────────────────────────────────────────────────────────────────

/** mpris:trackid обязан быть валидным object path: hex-хеш этому отвечает. */
function trackPath(item) {
  return `/org/mpris/MediaPlayer2/track/${item.id}`;
}

/**
 * Metadata отдаётся наружу тремя путями (Get, GetAll, PropertiesChanged),
 * поэтому глобальная переменная пересобирается на каждой смене трека.
 * Отсутствующие теги не кладутся вовсе: пустую обложку рисует виджет сам.
 */
let metadata = {};

function rebuildMetadata() {
  const item = state.tracks[state.index];
  if (!item) {
    metadata = {};
    return;
  }
  const m = {
    "mpris:trackid": new Variant("o", trackPath(item)),
    "mpris:length": new Variant("x", BigInt(Math.round((item.durationSec ?? 0) * 1e6))),
    "xesam:url": new Variant("s", url(item.id)),
    // Название неизвестно только у рипов без тегов: filename честнее null.
    "xesam:title": new Variant("s", item.title ?? item.filename ?? "Без названия"),
  };
  if (item.artist) m["xesam:artist"] = new Variant("as", [item.artist]);
  if (item.album) m["xesam:album"] = new Variant("s", item.album);
  if (item.genre) m["xesam:genre"] = new Variant("as", [item.genre]);
  if (item.coverUrl) m["mpris:artUrl"] = new Variant("s", `${SERVER}${item.coverUrl}`);
  metadata = m;
}

/**
 * Специфично для a{sv}: значения словаря обязаны быть Variant'ами (marshal
 * в marshall.js ожидает пару [signature, data], простые строки не завернёт).
 * Поэтому PropertiesChanged для Metadata посылается тем же словарём.
 */
function changes(patch) {
  if (!iface) return;
  try {
    Interface.emitPropertiesChanged(iface, patch);
  } catch (err) {
    console.error("PropertiesChanged не ушёл:", patch && Object.keys(patch), err);
  }
}

// ── mpv IPC ─────────────────────────────────────────────────────────────────

class Mpv {
  #buf = "";
  #conn = null;
  #listeners = [];

  onEvent(fn) { this.#listeners.push(fn); }

  /**
   * mpv создаёт socket не мгновенно после spawn, поэтому до готовности
   * просто переподключаемся.
   */
  async waitReady() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (existsSync(MPV_PATH)) {
        try {
          this.#conn = await Bun.connect({
            unix: MPV_PATH,
            socket: {
              data: (_socket, chunk) => this.#feed(chunk.toString()),
              error: () => { this.#conn = null; },
              close: () => { this.#conn = null; },
            },
          });
          return;
        } catch {
          // Сокет существует, но mpv ещё не слушает — ретрай.
        }
      }
      await sleep(200);
    }
    throw new Error(`mpv не отвечает на ${MPV_PATH}`);
  }

  #feed(chunk) {
    this.#buf += chunk;
    let nl;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim() === "") continue;
      try {
        this.#dispatch(JSON.parse(line));
      } catch {
        // Протокол ipc по newline: мусор в стриме валиден, просто пропускаем.
      }
    }
  }

  #dispatch(msg) {
    // У сообщений команд ответа поля event нет; события всегда несут event.
    if (msg.event === undefined) return;
    for (const fn of this.#listeners) fn(msg);
  }

  command(args) {
    if (!this.#conn) return;
    try {
      this.#conn.write(JSON.stringify({ command: args }) + "\n");
    } catch (err) {
      console.error("mpv команда упала:", args, err);
    }
  }
}

const mpv = new Mpv();

const playbackStatus = () => (!state.loaded ? "Stopped" : state.playing ? "Playing" : "Paused");
const positionUs = () => BigInt(Math.round(state.positionSec * 1e6));

function setPlaying(playing) {
  if (state.playing === playing) return;
  state.playing = playing;
  changes({ PlaybackStatus: playbackStatus() });
}

/**
 * Пауза — наша, а не mpv's: mpv по умолчанию не на паузе, поэтому
 * set_property pause=false не рождает события property-change, и доверять
 * можно только своим командам. События mpv используются лишь для сверки.
 */
function setPaused(pause) {
  state.desiredPause = pause;
  setPlaying(!pause && state.loaded);
}

/** Переходы и статус меняются только вместе с рассылкой(PropertiesChanged). */
async function transition(index, pause) {
  const item = state.tracks[index];
  if (!item) return;
  state.index = index;
  state.loaded = true;
  rebuildMetadata();
  await Promise.all([
    mpv.command(["loadfile", url(item.id), "replace"]),
    mpv.command(["set_property", "pause", pause]),
  ]);
  setPaused(pause);
  changes({ Metadata: metadata, PlaybackStatus: playbackStatus() });
}

function next(auto = false) {
  const i = (state.index + 1) % state.tracks.length;
  transition(i, /* pause */ !auto && !state.playing);
}

function previous() {
  const i = (state.index + state.tracks.length - 1) % state.tracks.length;
  transition(i, !state.playing);
}

// ── события mpv = факты о воспроизведении ───────────────────────────────────

mpv.onEvent(function onEventMsg(msg) {
  switch (msg.event) {
    case "property-change": {
      if (msg.name === "playback-time") state.positionSec = msg.data ?? 0;
      if (msg.name === "duration") state.durationSec = msg.data ?? null;
      // Свёрка: mpv может сообщить о паузе, чего мы не командовали.
      if (msg.name === "pause") setPaused(msg.data === true);
      break;
    }
    case "file-loaded":
      state.positionSec = 0;
      state.durationSec = null;
      // Файл реально в плеере: end-file(replace) при смене трека успевает
      // сбросить loaded раньше загрузки нового.
      state.loaded = true;
      // Подтверждаем своё состояние: пауза — как командовали.
      setPlaying(!state.desiredPause);
      rebuildMetadata();
      changes({ Metadata: metadata, PlaybackStatus: playbackStatus() });
      // Переход на новый трек — нелинейный скачок позиции: по спеке клиент
      // узнаёт о нём через Seeked и перетикает время от нуля.
      iface?.Seeked(0);
      break;
    case "end-file":
      if (msg.reason === "eof") {
        next(true); // трек кончился сам
      } else {
        state.loaded = false;
        state.durationSec = null;
        changes({ PlaybackStatus: playbackStatus() });
      }
      break;
    case "idle":
      state.loaded = false;
      state.playing = false;
      state.durationSec = null;
      changes({ PlaybackStatus: playbackStatus() });
      break;
  }
});

// ── D-Bus интерфейсы ────────────────────────────────────────────────────────

class RootInterface extends Interface {
  constructor() { super("org.mpris.MediaPlayer2"); }

  get Identity() { return "MusicLib"; }
  get CanRaise() { return false; }
  get CanQuit() { return false; }
  get HasTrackList() { return false; }
  get SupportedUriSchemes() { return ["http"]; }
  get SupportedMimeTypes() { return ["audio/ogg"]; }

  Raise() { /* окна нет */ }
  Quit() { /* жизненным циклом рулит systemd */ }
}

RootInterface.configureMembers({
  properties: {
    Identity: { signature: "s", access: dbus.interface.ACCESS_READ },
    CanRaise: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanQuit: { signature: "b", access: dbus.interface.ACCESS_READ },
    HasTrackList: { signature: "b", access: dbus.interface.ACCESS_READ },
    SupportedUriSchemes: { signature: "as", access: dbus.interface.ACCESS_READ },
    SupportedMimeTypes: { signature: "as", access: dbus.interface.ACCESS_READ },
  },
  methods: { Raise: {}, Quit: {} },
});

class PlayerInterface extends Interface {
  constructor() { super("org.mpris.MediaPlayer2.Player"); }

  get PlaybackStatus() { return playbackStatus(); }
  get LoopStatus() { return "Playlist"; }
  get Shuffle() { return false; }
  get Metadata() { return metadata; }
  /** Position не шлют через PropertiesChanged: спека запрещает, читайте Get. */
  get Position() { return positionUs(); }
  get Volume() { return state.volume / 100; }
  set Volume(v) {
    state.volume = Math.min(Math.max(Number(v) * 100, 0), 100);
    mpv.command(["set_property", "volume", state.volume]);
  }
  get Rate() { return 1.0; }
  get MinimumRate() { return 1.0; }
  get MaximumRate() { return 1.0; }
  get CanControl() { return true; }
  get CanPlay() { return true; }
  get CanPause() { return true; }
  get CanSeek() { return true; }
  get CanGoNext() { return state.tracks.length > 1; }
  get CanGoPrevious() { return state.tracks.length > 1; }

  Play() {
    if (state.loaded) {
      setPaused(false);
      mpv.command(["set_property", "pause", false]);
    } else {
      void transition(state.index, false);
    }
  }

  Pause() {
    setPaused(true);
    mpv.command(["set_property", "pause", true]);
  }

  PlayPause() {
    if (state.playing) this.Pause();
    else this.Play();
  }

  Stop() {
    state.loaded = false;
    state.positionSec = 0;
    setPlaying(false);
    state.desiredPause = true;
    mpv.command(["stop"]);
    changes({ PlaybackStatus: "Stopped" });
  }

  Next() { next(false); }
  Previous() { previous(); }

  /** offsetUs — относительный сдвиг в микросекундах, может быть отрицательным. */
  Seek(offsetUs) {
    mpv.command(["seek", Number(offsetUs) / 1e6, "relative"]);
  }

  /** TrackId не совпал с текущим — спека говорит игнорировать. */
  SetPosition(trackId, positionUsArg) {
    const item = state.tracks[state.index];
    if (!item || trackId !== trackPath(item)) return;
    mpv.command(["seek", Number(positionUsArg) / 1e6, "absolute"]);
  }
}

PlayerInterface.configureMembers({
  properties: {
    PlaybackStatus: { signature: "s", access: dbus.interface.ACCESS_READ },
    LoopStatus: { signature: "s", access: dbus.interface.ACCESS_READ },
    Shuffle: { signature: "b", access: dbus.interface.ACCESS_READ },
    Metadata: { signature: "a{sv}", access: dbus.interface.ACCESS_READ },
    Position: { signature: "x", access: dbus.interface.ACCESS_READ },
    Volume: { signature: "d", access: dbus.interface.ACCESS_READWRITE },
    Rate: { signature: "d", access: dbus.interface.ACCESS_READ },
    MinimumRate: { signature: "d", access: dbus.interface.ACCESS_READ },
    MaximumRate: { signature: "d", access: dbus.interface.ACCESS_READ },
    CanControl: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanPlay: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanPause: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanSeek: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanGoNext: { signature: "b", access: dbus.interface.ACCESS_READ },
    CanGoPrevious: { signature: "b", access: dbus.interface.ACCESS_READ },
  },
  methods: {
    Play: {}, Pause: {}, PlayPause: {}, Stop: {},
    Next: {}, Previous: {}, Seek: { inSignature: "x" },
    SetPosition: { inSignature: "ox" },
  },
  signals: { Seeked: { signature: "x" } },
});

// ── main ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сервер может подниматься вместе со стартом юнита: подождать. */
async function fetchTracks() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${SERVER}/tracks?limit=200&sort=created&order=desc`);
      if (res.ok) {
        const body = await res.json();
        state.tracks = body.items ?? [];
        rebuildMetadata();
        return;
      }
    } catch {
      // сеть не готова (или сервер) — попробуем позже
    }
    await sleep(1000);
  }
  console.error("сервер /tracks не отвечает — очередь пустая");
}

/** mpv умер — пересоздать и переподключиться. */
async function superviseMpv() {
  while (true) {
    state.loaded = false;
    setPlaying(false);
    await rm(MPV_PATH, { force: true });
    await mkdir(MPV_PATH.replace("/mpv.sock", ""), { recursive: true });

    mpvProc = Bun.spawn(
      [
        "mpv",
        "--no-terminal",
        "--idle=yes",
        "--no-video",
        "--audio-display=no",
        "--keep-open=no",
        // Локальный пакет mpv-mpris подкладывает /etc/mpv/scripts/mpris.so —
        // mpv сам регистрирует очередной org.mpris.MediaPlayer2.mpv без
        // треклиста (CanGoNext=false, без обложки), и omarchy.media выбирает
        // его активным вместо нас: он же процесс с playback stream в
        // PipeWire. Скрипты (только скрипты, не конфиг) отключаем для
        // нашего экземпляра; отдельный mpv пользователя остаётся с MPRIS.
        "--load-scripts=no",
        `--input-ipc-server=${MPV_PATH}`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    await mpv.waitReady();
    for (const prop of ["playback-time", "pause", "duration"]) {
      mpv.command(["observe_property", ++observeId, prop]);
    }

    const code = await mpvProc.exited;
    console.error(`mpv завершился с кодом ${code}, перезапуск через 2 с`);
    await sleep(2000);
  }
}

await fetchTracks();

const bus = dbus.sessionBus();
await bus.requestName(BUS_NAME);
await bus.export("/org/mpris/MediaPlayer2", new RootInterface());
iface = new PlayerInterface();
await bus.export("/org/mpris/MediaPlayer2", iface);

console.log(`* MusicLib MPRIS-мост: ${BUS_NAME}, ${state.tracks.length} треков из ${SERVER}`);
void superviseMpv();

function shutdown() {
  void (async () => {
    console.log("* закрываюсь");
    try {
      await bus.close();
    } catch {
      // Шина могла отвалиться сама — не важно, мы же выходим.
    }
    if (mpvProc) mpvProc.kill();
    process.exit(0);
  })();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
