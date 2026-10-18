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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// В dbus-next класс Interface живёт в подпакете interface, а не в корне.
const { Interface } = dbus.interface;
const { Variant } = dbus;

const SERVER = process.env.MUSICLIB_SERVER ?? "http://127.0.0.1:3000";
const BUS_NAME = "org.mpris.MediaPlayer2.musiclib";
const MPV_PATH = `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/music-lib-player/mpv.sock`;

/** Список треков: тот же порядок, что и в плейлисте плагина (альбом, внутри трек). */
const QUEUE_PARAMS = "limit=500&sort=album&order=asc";

/**
 * Состояние плеера переживает рестарт юнита: сюда на SIGTERM пишется
 * «кто играл и на какой секунде», на старте отсюда же восстанавливается
 * Paused-состояние. Это состояние КЛИЕНТА, в базе библиотеки его быть не
 * должно (ре решено), файл клиента — ровно то место.
 */
const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "music-lib");
const statePath = join(stateDir, "player.json");

/** Валиден только такой вид: чужой JSON не должен рушить запуск. */
function loadResumeState() {
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    if (typeof saved !== "object" || saved === null) return null;
    const { id, positionSec } = saved;
    if (typeof id !== "string" || id.length !== 64 || id.match(/^[0-9a-f]+$/) === null) return null;
    const sec = Number(positionSec);
    if (!Number.isFinite(sec) || sec < 0 || sec > 24 * 3600) return null;
    return { id, positionSec: sec };
  } catch {
    return null;  // файла нет — нормальный старт с нуля
  }
}

function persistState() {
  try {
    const item = state.tracks[state.index];
    if (!item) return;
    mkdirSync(stateDir, { recursive: true });
    // Позиция только из mpv-фактов, не из догадок: до первого property-change
    // она ноль, и после рестарта честнее начать с нуля, чем с недостоверного.
    writeFileSync(statePath, JSON.stringify({ id: item.id, positionSec: Math.floor(state.positionSec), volume: state.volume }));
  } catch (err) {
    console.error("не записал state:", err);
  }
}

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
  loop: "Playlist", // None | Track | Playlist; очередь крутится у нас самих
  shuffle: false,  // mpv перемешал очередь: album/asc вернуть может рестарт
  listenedSec: 0, // непрерывное звучание текущего трека, тикает только при play
  playedReported: false, // факт этого трека уже ушёл на сервер (живой штамп)
  announcedLengthSec: 0, // какая длина уже ушла в Metadata (чтобы не слать заново)
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
    // БД прав, но mpv-факт надёжнее: после property-change duration
    // state.durationSec уже наполнен, у дыр в базе длина честная.
    "mpris:length": new Variant("x", BigInt(Math.round((item.durationSec ?? state.durationSec ?? 0) * 1e6))),
    "xesam:url": new Variant("s", url(item.id)),
    // Название неизвестно только у рипов без тегов: filename честнее null.
    // || вместо ?? — пустая строка из формы падения тоже считается «нет».
    "xesam:title": new Variant("s", item.title || item.filename || "Без названия"),
  };
  if (item.artist) m["xesam:artist"] = new Variant("as", [item.artist]);
  if (item.album) m["xesam:album"] = new Variant("s", item.album);
  if (item.genre) m["xesam:genre"] = new Variant("as", [item.genre]);
  if (item.coverUrl) m["mpris:artUrl"] = new Variant("s", `${SERVER}${item.coverUrl}`);
  metadata = m;
  // Память о том, какая длина уже объявлена: сигнал Metadata не
  // пересылаем по кругу впустую.
  state.announcedLengthSec = Math.round(item.durationSec ?? state.durationSec ?? 0);
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

/**
 * Учёт прослушивания. Тик раз в секунду наращивает счётчик только пока
 * mpv реально играет (state.playing — «файл загружен и pause=false»),
 * и в тот же тик проверяет порог: штамп уходит на сервер сразу, пока
 * трек ещё играет, — «недавно прослушанные» поднимает его по-живому,
 * не дожидаясь перехода.
 */
setInterval(() => {
  if (state.loaded && state.playing) {
    state.listenedSec++;
    void reportPlayed();
  }
}, 1000);

const PLAY_THRESHOLD_SEC = 30;

/** Долгий трек признаётся после 30 секунд звучания; короткий — если
 * дослушан целиком (длительность из треков URL-списка, известна раньше
 * и надёжнее, чем догадка mpv). Промотанные куски история не портят:
 * без порога отсчёт не сойдётся. */
function reportPlayed() {
  const item = state.tracks[state.index];
  if (!item || state.playedReported) return Promise.resolve();
  const dur = item.durationSec ?? state.durationSec;
  const complete =
    typeof dur === "number" && dur > 0 && dur < PLAY_THRESHOLD_SEC &&
    state.listenedSec >= Math.floor(dur);
  if (state.listenedSec < PLAY_THRESHOLD_SEC && !complete) return Promise.resolve();
  state.playedReported = true;
  console.log(`* учёт: ${item.id.slice(0, 8)} прослушан (${state.listenedSec} с)`);
  return fetch(`${SERVER}/tracks/${item.id}/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Длительность разом заполняет дыру duration_sec в строке трека:
    // следующий запуск перемотки знает длину не из тегов, а из факта.
    body: JSON.stringify({ duration: state.durationSec ?? null }),
    signal: AbortSignal.timeout(1500),
  })
    .then((res) => {
      if (!res.ok) console.warn(`* play-ping: сервер ответил ${res.status}`);
    })
    .catch(() => {
      // Сервер перезапускался или недоступен — штамп пропустим, музыка не в счёт.
    });
}

/** Переходы и статус меняются только вместе с рассылкой(PropertiesChanged). */
async function transition(index, pause) {
  const item = state.tracks[index];
  if (!item) return;
  void reportPlayed(); // признаём прослушанным то, что только что играло
  state.index = index;
  state.loaded = true;
  state.listenedSec = 0; // новый трек — новый счёт
  state.playedReported = false;
  rebuildMetadata();
  await Promise.all([
    mpv.command(["loadfile", url(item.id), "replace"]),
    mpv.command(["set_property", "pause", pause]),
  ]);
  setPaused(pause);
  changes({ Metadata: metadata, PlaybackStatus: playbackStatus() });
}

/**
 * Обновление очереди уже во время работы: новозалитый трек появлялся бы
 * только после рестарта юнита. Одна попытка без ретраев — сервер мог
 * перезапуститься или ответить временной ошибкой; провал молчит, играет
 * то, что есть. Текущий трек ищется по id: если его удалили, позиция
 * сбрасывается на голову списка.
 */
async function refreshQueue() {
  const current = state.tracks[state.index] ?? null;
  const before = state.tracks.length;
  try {
    const res = await fetch(`${SERVER}/tracks?${QUEUE_PARAMS}`);
    if (!res.ok) return;
    const body = await res.json();
    let tracks = body.items ?? [];
    if (tracks.length === 0) return;
    if (state.shuffle) tracks = shuffleTracks(tracks, current);
    state.tracks = tracks;
    const i = current ? state.tracks.findIndex((t) => t.id === current.id) : -1;
    state.index = i >= 0 ? i : 0;
  } catch {
    return;
  }

  if (state.tracks.length !== before) {
    changes({ CanGoNext: state.tracks.length > 1, CanGoPrevious: state.tracks.length > 1 });
  }
}

/**
 * Fisher–Yates по списку треков с сохранением играющего первым: переходы
 * «next» и «previous» внутри перемешанной очереди не рвут текущий трек.
 */
function shuffleTracks(list, current) {
  const rest = current ? list.filter((t) => t.id !== current.id) : [...list];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return current ? [current, ...rest] : rest;
}

async function next(auto = false) {
  // Каждая смена трека обновляет очередь: залитый трек не требует
  // рестарта юнита, удалённый исчезает из очереди сам.
  await refreshQueue();
  if (state.tracks.length === 0) return;
  if (state.index + 1 >= state.tracks.length) {
    if (!auto || state.loop !== "None") {
      // Playlist крутится по кругу; ручной Next с последнего трека
      // уводит на первый в любом режиме.
      await transition(0, !auto && !state.playing);
    }
    // None + авто-переход: ничего не грузим — mpv с --keep-open=no сам
    // уйдёт в idle, штатный обработчик выставит Stopped.
    return;
  }
  await transition(state.index + 1, !auto && !state.playing);
}

async function previous() {
  await refreshQueue();
  if (state.tracks.length === 0) return;
  const i = (state.index + state.tracks.length - 1) % state.tracks.length;
  await transition(i, !state.playing);
}

/**
 * «Играть вот этот трек» из плагина: список popup всегда в то же
 * QUEUE_PARAMS-порядке, что и очередь, поэтому id ищется по месту.
 * Неизвестный id просто игнорируется (список актуальный, so id из него).
 */
async function playById(id) {
  await refreshQueue();
  const i = state.tracks.findIndex((t) => t.id === id);
  if (i === -1) return;
  // Клик по треку в списке всегда включает звук: и из Stopped, и из Paused.
  await transition(i, false);
}

// ── события mpv = факты о воспроизведении ───────────────────────────────────

mpv.onEvent(function onEventMsg(msg) {
  switch (msg.event) {
    case "property-change": {
      if (msg.name === "playback-time") {
        const next = msg.data ?? 0;
        // Обычный тик — доли секунды; скачок больше порога — это seek
        // (наш через Seek/SetPosition или resume-offset на старте). По спеке
        // клиенту о нём сообщаем сигналом Seeked: quickshell считает позицию
        // сам и без него продолжает тикать от старого места.
        if (state.loaded && Math.abs(next - state.positionSec) > 1.5) {
          try {
            iface?.Seeked(Math.round(next * 1e6));
          } catch (err) {
            console.error("Seeked не ушёл:", err);
          }
        }
        state.positionSec = next;
      }
      if (msg.name === "duration") {
        const d = msg.data ?? null;
        state.durationSec = d;
        // Длину mpv даёт уже после загрузки файла. В метадате она из строки
        // БД, и если там дыра (трек без тегов) — длина остаётся нулём, а
        // виджет прячет полоску перемотки. Как только mpv сообщил гармонию,
        // пересобираем Metadata и рапортуем заново.
        if (state.loaded && d !== null && d > 0 && state.announcedLengthSec !== Math.round(d)) {
          rebuildMetadata();
          changes({ Metadata: metadata });
        }
      }
      // Громкость меняют не только наши руки (mpv-клавиши, если mpv-окно):
      // синхронизируем и рапортуем в PropertiesChanged, виджет не отстанет.
      if (msg.name === "volume") {
        const pct = Math.min(130, Math.max(0, Math.round(msg.data ?? 100)));
        if (pct !== state.volume) {
          state.volume = pct;
          changes({ Volume: state.volume / 100 });
        }
      }
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
        if (state.loop === "Track") {
          transition(state.index, false); // тот же трек сначала
        } else {
          next(true); // дальше по очереди; None на последнем — next решит сам
        }
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
      // idle бывает и после простоя, и после честного конца очереди (None):
      // idle бывает и после простоя, и после честного конца очереди (None):
      // счётчик либо общий ноль, либо недоигранный хвост — оба признаёт reportPlayed.
      void reportPlayed();
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
  get LoopStatus() { return state.loop; }
  set LoopStatus(v) {
    const mode = String(v);
    if (mode !== "None" && mode !== "Track" && mode !== "Playlist") return;
    state.loop = mode;
    // Track и None — решения нашего end-file обработчика; mpv сам ничего
    // не зацикливает. Рапортуем значение, чтобы виджет кнопки не болтался.
    changes({ LoopStatus: state.loop });
  }
  get Shuffle() { return state.shuffle; }
  set Shuffle(v) {
    state.shuffle = Boolean(v);
    // Очередь у нас своя (пересобирается с сервера при каждом переходе),
    // поэтому mpv-shuffle не участвует: текущий порядок живёт в state.tracks,
    // флаг решает, что fetchTracks дальше будет мешать. Выключение — просто
    // пересборка в album/asc.
    void refreshQueue();
    changes({ Shuffle: state.shuffle });
  }
  get Metadata() { return metadata; }
  /** Position не шлют через PropertiesChanged: спека запрещает, читайте Get. */
  get Position() { return positionUs(); }
  get Volume() { return state.volume / 100; }
  set Volume(v) {
    state.volume = Math.min(Math.max(Number(v) * 100, 0), 100);
    mpv.command(["set_property", "volume", state.volume]);
    // Рапортуем тем же Property: виджет слайдера и MPRIS-клиенты должны
    // увидеть значение, а не догадываться.
    changes({ Volume: state.volume / 100 });
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
    void reportPlayed(); // остановка после дослушанных порога — тоже факт
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
  /** Тело метода SetLoopMode: configureMembers оборачивает в вызов по шине.
   * Без return — у метода нет out-аргумента, лишнее тело ответа роняет вызов. */
  SetLoopMode(mode) {
    const m = String(mode);
    if (m !== "None" && m !== "Track" && m !== "Playlist") return;
    state.loop = m;
    changes({ LoopStatus: state.loop });
  }

  /** Тело сигнала Seeked: configureMembers оборачивает его в отправку по шине. */
  Seeked(positionUs) { return positionUs; }

  Seek(offsetUs) {
    // Была отладка: quickshell шлёт offset в MPRIS-единицах (мкс), как и
    // положено по спеке — конверсия не нужна, только /1e6 для mpv.
    mpv.command(["seek", Number(offsetUs) / 1e6, "relative"]);
  }
  /** TrackId не совпал с текущим — спека говорит игнорировать. */
  SetPosition(trackId, positionUsArg) {
    const item = state.tracks[state.index];
    if (!item || trackId !== trackPath(item)) return;
    mpv.command(["seek", Number(positionUsArg) / 1e6, "absolute"]);
  }

  /**
   * Опциональный метод MPRIS-спеки: URL из плагина = адрес трека нашего
   * сервера (/audio/<id>), по нему и играем. Чужие URL не стоят внимания.
   */
  OpenUri(uri) {
    const id = String(uri).split("/").filter(Boolean).pop();
    void playById(id);
  }
}

PlayerInterface.configureMembers({
  properties: {
    PlaybackStatus: { signature: "s", access: dbus.interface.ACCESS_READ },
    LoopStatus: { signature: "s", access: dbus.interface.ACCESS_READWRITE },
    Shuffle: { signature: "b", access: dbus.interface.ACCESS_READWRITE },
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
    OpenUri: { inSignature: "s" },
    SetLoopMode: { inSignature: "s" },
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
      const res = await fetch(`${SERVER}/tracks?${QUEUE_PARAMS}`);
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
  // точно один раз за жизнь процесса
  const resume = loadResumeState();
  let resumeApplied = false;
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
    // mpv экспортирует громкость точно как state.volume: проценты 0..100.
    for (const prop of ["playback-time", "pause", "duration", "volume"]) {
      mpv.command(["observe_property", ++observeId, prop]);
    }

    // Восстановление после прошлого запуска: Paused на сохранённой секунде,
    // БЕЗ автозапуска — рестарт юнита не должен сам включать громкую музыку.
    // play из виджета продолжит с этого места.
    if (resume && !resumeApplied) {
      resumeApplied = true;
      const i = state.tracks.findIndex((t) => t.id === resume.id);
      if (i !== -1) {
        state.index = i;
        state.loaded = true;
        state.desiredPause = true;
        rebuildMetadata();
        changes({ Metadata: metadata, PlaybackStatus: "Paused" });
        // Формат mpv 0.38+: опции — четвёртый аргумент (третий = -1),
        // значения — строго строки, иначе «invalid parameter».
        mpv.command(["loadfile", url(resume.id), "replace", -1, { start: String(Math.floor(resume.positionSec)) }]);
        mpv.command(["set_property", "pause", true]);
        console.log(`* резюм: ${resume.id} на ${Math.floor(resume.positionSec)} с`);
      }
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
    await reportPlayed(); // дослушанный до выхода трек тоже штампуем
    persistState();
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
