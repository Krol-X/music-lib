import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import qs.Ui
import qs.Commons
import qs.Commons as Commons

BarWidget {
  id: root
  moduleName: "omarchy.media"

  readonly property var mediaService: bar?.shell?.firstPartyServiceFor("omarchy.media")
  readonly property var activePlayer: mediaService ? mediaService.activePlayer : null
  readonly property var sourcePlayers: mediaService ? mediaService.sourcePlayers : []

  readonly property bool hasMedia: activePlayer !== null && (activePlayer.trackTitle || activePlayer.trackArtist)
  readonly property string playIcon: activePlayer && activePlayer.isPlaying ? "󰏤" : "󰐊"
  readonly property string title: activePlayer ? (activePlayer.trackTitle || "") : ""
  readonly property string artist: activePlayer ? (activePlayer.trackArtist || "") : ""

  property bool popupOpen: false
  // Пустая библиотека у НАШЕГО плеера: транспорт и заголовок трека глушим —
  // мост честно рапортует последний удалённый трек, верить ему уже нельзя.
  readonly property bool emptyLib: isOurPlayer && library.length === 0

  function close() { popupOpen = false }
  property real maxLabelWidth: 180

  // ── плейлист библиотеки ────────────────────────────────────────────────────
  //
  // Источник справа — HTTP сервер, тот же, что у MPRIS-моста (о нём сверяется
  // все идентификаторы треков и очередь). Адрес переопределяется как у моста.
  readonly property string server: Quickshell.env("MUSICLIB_SERVER") || "http://127.0.0.1:3000"
  // Секция плейлиста имеет смысл только когда активен наш мост.
  readonly property bool isOurPlayer: activePlayer
    ? String(activePlayer.dbusName || "").indexOf("musiclib") !== -1
    : false

  property var library: []
  property bool libraryLoading: false

  // Длина текущего трека в секундах (MPRIS length; Quickshell отдаёт их
  // уже в секундах). Ноль — перемотка не показываем вовсе.
  readonly property real trackLength: activePlayer ? (activePlayer.length ?? 0) : 0

  // Сортировка плейлиста — локальная, по уже скачанному списку. Четыре
  // режима и направление; дефолты честные: «Recent» и «Newest» смотрим
  // сверху вниз по времени (desc), текстовые поля — по алфавиту (asc).
  property int sortIndex: 0 // 0 Title, 1 Artist, 2 Recent, 3 Newest
  readonly property var sortLabels: ["Title", "Artist", "Recent", "Newest"]
  readonly property string sortLabel: sortLabels[sortIndex]
  property bool orderDesc: false
  readonly property var sortDefaultDesc: [false, false, true, true]
  // «Селект» режима: меню выбора рисуется на месте плейлиста.
  property bool sortMenuOpen: false

  function pickSort(i) {
    sortIndex = i
    orderDesc = sortDefaultDesc[i]
    sortMenuOpen = false
  }

  function mmss(sec) {
    const s = Math.max(0, Math.floor(sec || 0))
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60)
  }

  // Плейлист, каким его видит попап: фильтр по подстроке (название,
  // исполнитель, альбом) плюс сортировка в выбранном режиме и направлении.
  // Порядок очереди моста от этого независим — он всегда album/asc с
  // сервера; здесь только взгляд глазами. Направление — переворот
  // компаратора.
  readonly property var playlist: {
    const q = filterField.text.trim().toLowerCase()
    let items = root.library
    if (q !== "") {
      items = items.filter(function(t) {
        return [t.title, t.artist, t.album].some(function(s) {
          return s && s.toLowerCase().indexOf(q) !== -1
        })
      })
    }
    items = items.slice()
    // Режим «Recent» показывает только то, что играло: непрослушанные
    // треки (lastPlayed null) убраны из вида совсем.
    if (root.sortIndex === 2) {
      items = items.filter(function(t) { return !!t.lastPlayed })
    }
    const num = function(x) { return x === null || x === undefined ? 0 : Number(x) }
    const flip = function(c) { return root.orderDesc ? -c : c }
    if (root.sortIndex === 0) {
      items.sort(function(a, b) {
        return flip(String(a.title || "").localeCompare(String(b.title || "")))
      })
    } else if (root.sortIndex === 1) {
      items.sort(function(a, b) {
        return flip(String(a.artist || "").localeCompare(String(b.artist || ""))
          || String(a.album || "").localeCompare(String(b.album || ""))
          || num(a.discNo) - num(b.discNo)
          || num(a.trackNo) - num(b.trackNo))
      })
    } else if (root.sortIndex === 2) {
      items.sort(function(a, b) {
        // lastPlayed здесь есть всегда (фильтр выше), остаются только даты.
        return flip(String(a.lastPlayed).localeCompare(String(b.lastPlayed)))
      })
    } else {
      items.sort(function(a, b) {
        return flip(String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      })
    }
    return items
  }

  // Мягко показать то, что играется: при открытии попапа прокрутить список
  // к текущей строке, чтобы она была не где-то за экраном.
  property bool scrollPending: false

  function scrollToCurrent() {
    if (!root.activePlayer) return
    const title = root.activePlayer.trackTitle
    if (!title) return
    const artist = root.activePlayer.trackArtist || ""
    const list = root.playlist
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i].title === title && (list[i].artist || "") === artist) { idx = i; break }
    }
    if (idx < 0) return
    // Высоты считаем арифметикой: строки одного роста плюс отступ в колонке.
    const target = idx * (Style.space(38) + Style.space(1)) + Style.space(19) - trackFlick.height * 0.5
    trackFlick.contentY = Math.max(0, Math.min(target, Math.max(0, trackFlick.contentHeight - trackFlick.height)))
  }

  // ── CRUD библиотеки из попапа ─────────────────────────────────────────────
  //
  // Заливка (curl-процесс по цепочке путей из zenity), правка метаданных
  // (PATCH) и удаление (DELETE в два подтверждения). Правка заменяет поиск
  // и список в попапе на форму; роль моста — только очередь, ей CRUD не мешает.
  property var editingTrack: null // копия записи из library
  property bool confirmDelete: false
  property string editStatus: ""
  property bool editError: false

  property bool uploadBusy: false
  property var uploadQueue: []
  property int uploadOk: 0
  property int uploadFail: 0
  property string uploadStatus: ""
  // Попап временно закрывается перед файловым диалогом (grab держит фокус
  // у виджета, диалог уходит под него); вернуть после заливки.
  property bool reopenAfterUpload: false

  Process {
    id: pickProc
    stdout: StdioCollector { onStreamFinished: root.uploadPicked(text) }
  }

  function uploadPick() {
    // Диалог против grab'а попапа: пока попап держит клавиатуру, zenity
    // уходит под виджет. Закрываю себя, запоминаю, вернуть после заливки.
    reopenAfterUpload = popupOpen
    if (popupOpen) popupOpen = false
    pickProc.command = ["zenity", "--file-selection", "--multiple",
      "--title", "Upload to library",
      "--file-filter", "Audio | *.mp3 *.flac *.wav *.ogg *.mka",
      "--file-filter", "All files | *"]
    pickProc.running = true
  }

  function uploadPicked(text) {
    const paths = String(text).trim().split("\n").filter(Boolean)
    if (paths.length === 0) {
      // Отмена диалога: вернуть виджет как было.
      if (reopenAfterUpload) { reopenAfterUpload = false; popupOpen = true }
      return
    }
    uploadQueue = paths
    uploadOk = 0
    uploadFail = 0
    uploadBusy = true
    uploadStatus = "uploading (1/" + paths.length + ")…"
    uploadNext()
  }

  Process {
    id: uploadProc
    stdout: StdioCollector { onStreamFinished: root.uploadFinished(text) }
  }

  function uploadNext() {
    if (uploadQueue.length === 0) {
      uploadBusy = false
      loadLibrary()
      uploadStatus = uploadFail === 0
        ? "done: " + uploadOk + " track" + (uploadOk > 1 ? "s" : "")
        : uploadOk + " ок, " + uploadFail + " с ошибкой"
      if (reopenAfterUpload) {
        reopenAfterUpload = false
        popupOpen = true
      }
      return
    }
    uploadStatus = "uploading (" + (uploadOk + uploadFail + 1) + "/" + (uploadOk + uploadFail + uploadQueue.length) + ")…"
    uploadProc.command = ["curl", "-sS", "-F", "file=@" + uploadQueue[0], server + "/audio/upload"]
    uploadQueue = uploadQueue.slice(1)
    uploadProc.running = true
  }

  function uploadFinished(text) {
    let ok = false
    let msg = "server did not respond"
    try {
      const r = JSON.parse(String(text))
      if (r && (r.success || r.existed)) { ok = true; uploadOk++ }
      else msg = r.error || "server refused"
    } catch (e) {
      msg = "bad server response: " + String(text).slice(0, 60)
    }
    if (!ok) { uploadFail++; editStatus = msg; editError = true }
    uploadNext()
  }

  function patchTrack(id, payload) {
    editStatus = "saving…"
    editError = false
    const xhr = new XMLHttpRequest()
    xhr.open("PATCH", root.server + "/tracks/" + id)
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return
      if (xhr.status === 200) {
        editingTrack = null
        editStatus = ""
        loadLibrary()
      } else {
        editError = true
        try { editStatus = JSON.parse(xhr.responseText).error || ("error " + xhr.status) }
        catch (e) { editStatus = "error " + xhr.status }
      }
    }
    xhr.send(JSON.stringify(payload))
  }

  function saveEdit() {
    const t = editingTrack
    if (!t) return
    patchTrack(t.id, {
      title: editTitle.text,
      artist: editArtist.text,
      album: editAlbum.text,
      genre: editGenre.text,
    })
  }

  function deleteTrack() {
    const t = editingTrack
    if (!t) return
    // Подтверждение выражено самой кнопкой ("delete" → accent "really delete?").
    if (!confirmDelete) {
      confirmDelete = true
      return
    }
    confirmDelete = false
    editError = false
    editStatus = "deleting…"
    const xhr = new XMLHttpRequest()
    xhr.open("DELETE", root.server + "/tracks/" + t.id)
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return
      if (xhr.status === 200 || xhr.status === 404) {
        editingTrack = null
        editStatus = ""
        loadLibrary()
      } else {
        editError = true
        try { editStatus = JSON.parse(xhr.responseText).error || ("error " + xhr.status) }
        catch (e) { editStatus = "error " + xhr.status }
      }
    }
    xhr.send()
  }

  function openEditor(track) {
    editingTrack = Object.assign({}, track) // копия: не мутируем библиотечную
    confirmDelete = false
    editStatus = ""
    editError = false
  }

  function loadLibrary() {
    if (libraryLoading) return
    libraryLoading = true
    const xhr = new XMLHttpRequest()
    xhr.open("GET", `${server}/tracks?limit=200&sort=album&order=asc`)
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return
      libraryLoading = false
      if (xhr.status !== 200) return
      try {
        library = JSON.parse(xhr.responseText).items ?? []
      } catch (e) {
        console.warn("плейлист: не разобрал JSON от сервера:", e)
      }
    }
    xhr.send()
  }

  Component.onCompleted: loadLibrary()
  onPopupOpenChanged: if (popupOpen) {
    loadLibrary()
    scrollPending = true
    openScrollTimer.restart()
    // Поле поиска сразу в фокусе: попап открыт клавиатурно-занятым grab'ом,
    // первый клик по нему иногда теряется — не заставляю жалиться дважды.
    if (filterField) filterField.forceActiveFocus()
  } else {
    // Возвращение к списку — не оставить висеть открытое меню сортировки.
    sortMenuOpen = false
  }
  onLibraryChanged: if (scrollPending) { scrollPending = false; openScrollTimer.restart() }

  // Когда сменился текущий трек при открытом попапе — подтянуть список к нему.
  readonly property string currentTrackKey: activePlayer
    ? ((activePlayer.trackTitle || "") + "|" + (activePlayer.trackArtist || ""))
    : ""
  onCurrentTrackKeyChanged: if (popupOpen) openScrollTimer.restart()
  Timer {
    id: openScrollTimer
    interval: 120
    repeat: false
    onTriggered: root.scrollToCurrent()
  }

  // Push-канал «played»: сервер слушает unix-сокет в XDG_RUNTIME_DIR и шлёт
  // строку JSON за \n на каждый штамп прослушивания. «Недавно прослушанные»
  // поднимает трек по-живому, не дожидаясь (пере)открытия попапа.
  Socket {
    id: pushSock
    path: Quickshell.env("XDG_RUNTIME_DIR") + "/music-lib-push.sock"
    parser: SplitParser {
      splitMarker: "\n"
      onRead: function(data) {
        console.log("плейлист: пуш прилетел:", String(data).slice(0, 60))
        if (!root.popupOpen || root.sortIndex !== 2 || root.sortMenuOpen) return
        try {
          const ev = JSON.parse(String(data))
          if (ev && ev.event === "played") {
            console.log("плейлист: пуш 'played' получен")
            root.loadLibrary()
          }
        } catch (e) {
          // Мусорная строка не должна ронять подписку — игнорим.
          console.warn("плейлист: пуш не разобран:", e)
        }
      }
    }
    // Клиент коннектится сам при рождении; рестарт сервера закрывает
    // соединение и трогает reconnectTimer через onConnectedChanged.
    Component.onCompleted: connected = true
  }

  // Контрольный поллинг: сокет может чихнуть (рестарт сервера), редкий
  // запрос раз в 15 секунд ничего не стоит — страховкой от пропущенных
  // событий при живом попапе.
  Timer {
    id: recentPollTimer
    interval: 15000
    repeat: true
    running: root.popupOpen && root.isOurPlayer && root.sortIndex === 2 && !root.sortMenuOpen
    onTriggered: root.loadLibrary()
  }
  // Реконнект push-сокета: сервер мог рестартнуться (или файл-сокет
  // пересоздавался чьим-то упавшим биндом) — пробуем каждые 5 секунд,
  // пока сокет разъединён: пропущенная попытка не хоронит канал навсегда.
  Timer {
    id: reconnectTimer
    interval: 5000
    repeat: true
    running: pushSock !== null && !pushSock.connected
    onTriggered: pushSock.connected = true
  }

  // Quickshell не перетикает position сам: по докам заставляем его сигнал
  // руками, пока играет и попап открыт (иначе слайдер и время замирают
  // до следующего скачка позиции).
  Timer {
    interval: 500
    repeat: true
    running: root.popupOpen && root.activePlayer !== null && root.activePlayer.isPlaying && root.activePlayer.canSeek
    onTriggered: if (root.activePlayer) root.activePlayer.positionChanged()
  }

  visible: hasMedia
  implicitWidth: hasMedia ? row.implicitWidth + Style.space(14) : 0
  implicitHeight: barSize

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(6)

    Text {
      id: glyph
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      text: root.playIcon
      color: activePlayer && activePlayer.isPlaying ? root.bar.barForeground : Qt.darker(root.bar.barForeground, 1.5)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.body
      Behavior on color {
        enabled: !root.bar || root.bar.foregroundAnimationEnabled
        ColorAnimation { duration: Style.duration(160) }
      }
    }

    Item {
      id: scrollClip
      width: Math.min(root.maxLabelWidth, labelText.implicitWidth)
      height: glyph.height
      clip: true
      anchors.verticalCenter: parent.verticalCenter
      visible: !root.bar.vertical && root.title !== "" && !root.emptyLib

      Text {
        id: labelText
        textFormat: Text.PlainText
        text: root.title + (root.artist ? "  ·  " + root.artist : "")
        color: root.bar.barForeground
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.body
        anchors.verticalCenter: parent.verticalCenter

        property bool needsScroll: implicitWidth > scrollClip.width

        NumberAnimation on x {
          id: scrollAnim
          running: labelText.needsScroll && !root.popupOpen && !root.bar.vertical && !Style.reduceMotion
          // Stopped for reduced motion, the title reads from its start again.
          onRunningChanged: if (!running && Style.reduceMotion) labelText.x = 0
          loops: Animation.Infinite
          duration: Math.max(6000, labelText.implicitWidth * 25)
          from: scrollClip.width
          to: -labelText.implicitWidth
          easing.type: Easing.Linear
        }
      }
    }

    // Пустая библиотека: глиф плюс короткая подпись вместо мёртвого титула —
    // строка щедрее на ширину и честно говорит, что играть нечего.
    Text {
      textFormat: Text.PlainText
      anchors.verticalCenter: parent.verticalCenter
      visible: root.emptyLib
      text: "library is empty"
      color: Qt.darker(root.bar.barForeground, 1.5)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: root.activePlayer ? Qt.PointingHandCursor : Qt.ArrowCursor
    acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton

    onClicked: function(mouse) {
      if (!root.activePlayer) return
      if (mouse.button === Qt.MiddleButton) {
        if (root.mediaService) root.mediaService.runAction("next", false)
      } else if (mouse.button === Qt.RightButton) {
        root.popupOpen = !root.popupOpen
      } else if (root.emptyLib) {
        // Играть нечего: ЛКМ открывает попап (там же заливка «＋»),
        // а не дёргает playPause по мёртвым метаданным.
        root.popupOpen = !root.popupOpen
      } else {
        if (root.mediaService) root.mediaService.runAction("playPause", false)
      }
    }
    onWheel: function(wheel) {
      if (!root.activePlayer) return
      if (wheel.angleDelta.y > 0 && root.mediaService) root.mediaService.runAction("previous", false)
      else if (wheel.angleDelta.y < 0 && root.mediaService) root.mediaService.runAction("next", false)
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.hasMedia ? (root.title + (root.artist ? " — " + root.artist : "")) : "")
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(320))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    Column {
      id: column
      anchors.fill: parent
      spacing: Style.space(10)

      Row {
        visible: !root.emptyLib
        spacing: Style.space(10)
        width: parent.width

        BorderSurface {
          width: Style.space(64)
          height: Style.space(64)
          radius: Style.spacing.labelGap
          color: Style.normalFillFor(root.bar.foreground, Commons.Color.accent)
          borderSpec: Border.controlSpec("normal", root.bar.foreground, Commons.Color.accent)

          // Decode the art at the size it is drawn, not the size the player
          // serves it at. The popup is built on every monitor at startup.
          SizedImage {
            anchors.fill: parent
            anchors.margins: Style.space(2)
            crop: true
            url: root.activePlayer && root.activePlayer.trackArtUrl ? root.activePlayer.trackArtUrl : ""
            visible: url != ""
          }

          Text {
            anchors.centerIn: parent
            visible: !root.activePlayer || !root.activePlayer.trackArtUrl
            text: "󰝚"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
          }
        }

        Column {
          spacing: Style.space(4)
          width: parent.width - Style.space(74)

          Text {
            textFormat: Text.PlainText
            text: root.title || I18n.t("media.nothingPlaying")
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
            elide: Text.ElideRight
            width: parent.width
          }

          Text {
            textFormat: Text.PlainText
            text: root.artist
            color: Qt.darker(root.bar.foreground, 1.3)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
            width: parent.width
            visible: text !== ""
          }

          Text {
            textFormat: Text.PlainText
            text: root.activePlayer && root.activePlayer.trackAlbum ? root.activePlayer.trackAlbum : ""
            color: Qt.darker(root.bar.foreground, 1.6)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            width: parent.width
            visible: text !== ""
          }
        }
      }

      Row {
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: Style.space(6)
        // Transport controls keep previous, play, next in every language,
        // matching their glyphs; media controls are not mirrored.
        LayoutMirroring.enabled: false
        LayoutMirroring.childrenInherit: true

        // Повтор: None → Playlist → Track → None, пишем в loopState моста.
        // Внимание: loopState в Quickshell — числовой enum MprisLoopState
        // (None=0, Track=1, Playlist=2), а не строка MPRIS "None"/"Track"/...
        // Глиф свой на режим (codepoints из cmap Nerd Font): repeat,
        // repeat-once, repeat-off — путаницы с «выкл» больше нет.
        Button {
          iconText: !root.activePlayer || root.activePlayer.loopState === MprisLoopState.None
            ? String.fromCodePoint(0xF0457) // nf-md-repeat-off
            : root.activePlayer.loopState === MprisLoopState.Track
              ? String.fromCodePoint(0xF0458) // nf-md-repeat-once
              : String.fromCodePoint(0xF0456) // nf-md-repeat
          foreground: root.activePlayer && root.activePlayer.loopState !== MprisLoopState.None
            ? Commons.Color.accent : Qt.darker(root.bar.foreground, 1.6)
          tooltipText: "repeat: off / playlist / one track"
          iconSize: Style.font.iconLarge
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer !== null && !root.emptyLib
          opacity: enabled ? 1.0 : 0.4
          onClicked: {
            if (!root.activePlayer) return
            const cur = root.activePlayer.loopState
            root.activePlayer.loopState = cur === MprisLoopState.None ? MprisLoopState.Playlist
              : cur === MprisLoopState.Playlist ? MprisLoopState.Track : MprisLoopState.None
          }
        }

        Button {
          iconText: "󰒮"
          foreground: root.bar.foreground
          iconSize: Style.font.iconLarge
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && root.activePlayer.canGoPrevious && !root.emptyLib
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("previous", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: root.activePlayer && root.activePlayer.isPlaying ? "󰏤" : "󰐊"
          foreground: root.bar.foreground
          iconSize: Style.font.iconLarge
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && (root.activePlayer.canTogglePlaying || root.activePlayer.canPlay || root.activePlayer.canPause) && !root.emptyLib
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("playPause", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: "󰒭"
          foreground: root.bar.foreground
          iconSize: Style.font.iconLarge
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && root.activePlayer.canGoNext && !root.emptyLib
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("next", false, root.mediaService.playerKey(root.activePlayer))
        }

        // Заливка треков: иконка без подписи, всплывает подсказка.
        // Открывает zenity-диалог и цепочку curl-заливок; перед диалогом
        // закрывает попап (grab держал бы диалог под виджетом).
        Button {
          iconText: "󰐕"
          tooltipText: "upload tracks to library"
          foreground: root.bar.foreground
          iconSize: Style.font.iconLarge
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: !root.uploadBusy
          opacity: enabled ? 1.0 : 0.4
          onClicked: {
            editStatus = ""
            uploadStatus = ""
            root.uploadPick()
          }
        }
      }

      // Пустая библиотека: вместо мёртвых метаданных моста — одна внятная
      // подсказка, единственное живое действие остаётся «＋» в транспорте.
      Text {
        visible: root.emptyLib && root.editingTrack === null
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        textFormat: Text.PlainText
        text: "library is empty"
        color: Qt.darker(root.bar.foreground, 1.4)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
      }

      // ── перемотка ─────────────────────────────────────────────────────────
      // Позиция тикает сама (positionChanged от моста). Пока тянешь слайдер,
      // он держит свой liveValue и не дёргается от внешних обновлений, seek
      // уходит одним относительным вызовом по отпуску: Quickshell даёт
      // только seek(delta), абсолютный SetPosition gated по trackId.
      // У трека без duration в БД длина до прихода mpv-факта нулевая — не
      // прятать полоску вовсе, она пустой ползунком просто ждёт факт.
      Row {
        visible: !!root.activePlayer && !root.emptyLib && (root.trackLength > 0 || (root.activePlayer.canSeek ?? false))
        width: parent.width
        spacing: Style.space(6)

        Text {
          width: Style.space(34)
          height: Style.space(26)
          text: root.mmss(root.activePlayer ? root.activePlayer.position : 0)
          textFormat: Text.PlainText
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          verticalAlignment: Text.AlignVCenter
          horizontalAlignment: Text.AlignRight
        }

        PanelSlider {
          height: Style.space(26)
          width: parent.width - Style.space(86)
          bar: root.bar
          minimum: 0
          maximum: Math.max(1, root.trackLength)
          step: 1
          enabled: root.activePlayer && !!root.activePlayer.canSeek
          opacity: enabled ? 1.0 : 0.4
          value: root.activePlayer ? (root.activePlayer.position ?? 0) : 0

          // Писабельный position = наш SetPosition (абсолютный, gated по trackid).
          onReleased: function(v) {
            if (root.activePlayer && root.activePlayer.canSeek) root.activePlayer.position = v
          }
        }

        Text {
          width: Style.space(40)
          height: Style.space(26)
          text: root.mmss(root.trackLength)
          textFormat: Text.PlainText
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          verticalAlignment: Text.AlignVCenter
        }
      }

      // ── громкость ──────────────────────────────────────────────────────────
      // MPRIS Volume писабельный: мост гонит его в mpv и сам рапортует
      // обратное изменение (mpv-клавиши) через PropertiesChanged, так что
      // слайдер не разболтается от чужих рук.
      Row {
        visible: root.activePlayer !== null && root.activePlayer.volumeSupported
        width: parent.width
        spacing: Style.space(6)

        Text {
          width: Style.space(34)
          height: Style.space(26)
          text: "󰕾"
          textFormat: Text.PlainText
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          verticalAlignment: Text.AlignVCenter
          horizontalAlignment: Text.AlignRight
        }

        PanelSlider {
          height: Style.space(26)
          width: parent.width - Style.space(86)
          bar: root.bar
          minimum: 0
          maximum: 1
          step: 0.05
          enabled: root.activePlayer && root.activePlayer.volumeSupported
          opacity: enabled ? 1.0 : 0.4
          value: root.activePlayer ? (root.activePlayer.volume ?? 1) : 1

          onMoved: function(v) {
            if (root.activePlayer && root.activePlayer.volumeSupported) root.activePlayer.volume = v
          }
        }

        Text {
          width: Style.space(40)
          height: Style.space(26)
          text: Math.round((root.activePlayer ? (root.activePlayer.volume ?? 1) : 1) * 100) + "%"
          textFormat: Text.PlainText
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          verticalAlignment: Text.AlignVCenter
        }
      }

      PanelSeparator {
        visible: root.isOurPlayer && root.library.length > 0
        foreground: root.bar.foreground
      }

      // ── плейлист библиотеки MusicLib ──────────────────────────────────────
      //
      // Клик по строке включает конкретный трек: OpenUri нашего MPRIS-моста.
      // Список в том же порядке, что и очередь моста (sort=album), поэтому
      // «next» после выбора продолжает идти по этому же списку. Секция видна
      // только когда активный плеер — мост (рубеж по имени на шине).
      // ── библиотечная строка: заливка через zenity; статус операции рядом ──
      // Статусы заливки и правки, когда форма редактирования закрыта —
      // единственная строка живого отчёта CRUD в попапе.
      Text {
        visible: root.isOurPlayer && root.editingTrack === null
          && (root.uploadStatus !== "" || root.editStatus !== "")
        width: parent.width
        height: Style.space(26)
        verticalAlignment: Text.AlignVCenter
        textFormat: Text.PlainText
        elide: Text.ElideRight
        text: root.uploadStatus !== "" ? root.uploadStatus : root.editStatus
        color: root.editError && root.uploadStatus === ""
          ? Commons.Color.accent : Qt.darker(root.bar.foreground, 1.4)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
      }

      // Поиск и сортировка — локальные, по уже скачанному списку: в попапе
      // мгновенный отклик важнее свежести данных, список обновится при
      // следующем открытии.
      Row {
        visible: root.isOurPlayer && root.library.length > 0 && root.editingTrack === null
        height: Style.space(30)
        width: parent.width
        spacing: Style.space(6)

        TextField {
          id: filterField
          width: Math.max(Style.space(120),
            parent.width - sortCycle.implicitWidth - orderBtn.implicitWidth - Style.space(12))
          height: parent.height
          placeholderText: "search…"
          foreground: root.bar.foreground
          font.family: root.bar.fontFamily
          onActiveFocusChanged: console.warn("media: filter activeFocus =", activeFocus)
          onCursorVisibleChanged: console.warn("media: filter caret =", cursorVisible)
          // Клик внутри PopupWindow иногда проходит мимо штатного захвата
          // фокуса мышью — дублируем явным forceActiveFocus.
          TapHandler {
            gesturePolicy: TapHandler.ReleaseWithinBounds
            onTapped: filterField.forceActiveFocus()
          }
        }

        Button {
          id: sortCycle
          height: parent.height
          text: root.sortLabel
          foreground: root.sortMenuOpen ? Commons.Color.accent : root.bar.foreground
          onClicked: root.sortMenuOpen = !root.sortMenuOpen
        }

        // Направление текущего режима: ↑ алфавит/старые, ↓ обратно.
        // Свой дефолт на режим ставит cycleSort, тут только доигрывается.
        Button {
          id: orderBtn
          height: parent.height
          iconText: root.orderDesc ? "↓" : "↑"
          foreground: root.orderDesc ? Commons.Color.accent : root.bar.foreground
          onClicked: root.orderDesc = !root.orderDesc
        }
      }

      // Меню режимов сортировки: обычного <select> в QML нет, а вложить
      // в попап ещё одно popup-окно нельзя (окно привязывается только к
      // панели), поэтому честный дропдаун рисуем на месте плейлиста:
      // идёт выбор — список треков заменяется списком режимов.
      Column {
        id: sortMenu
        visible: root.isOurPlayer && root.sortMenuOpen && root.editingTrack === null
        width: parent.width
        spacing: Style.space(4)

        Repeater {
          model: root.sortLabels
          Button {
            required property string modelData
            required property int index
            width: sortMenu.width
            height: Style.space(34)
            text: modelData + (root.sortIndex === index ? "  ✓" : "")
            selected: root.sortIndex === index
            foreground: root.bar.foreground
            onClicked: root.pickSort(index)
          }
        }
      }

      Flickable {
        id: trackFlick
        visible: root.isOurPlayer && root.playlist.length > 0 && root.editingTrack === null
          && !root.sortMenuOpen
        width: parent.width
        // Потолок списка задаёт высоту окна: 196 px ≈ 5 строк (38px + 1px
        // spacer каждая), окно компактнее на высоту одной строки.
        height: Math.min(trackColumn.implicitHeight, Style.space(196))
        contentHeight: trackColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: trackColumn
          width: parent.width
          spacing: Style.space(1)

          Repeater {
            model: root.playlist

            Item {
              required property var modelData

              readonly property bool isCurrent: root.activePlayer
                && modelData.title === root.activePlayer.trackTitle
                && modelData.artist === root.activePlayer.trackArtist

              // В режиме «недавно прослушанные» к строке добавляется штамп:
              // сервер хранит время в UTC-ISO, Date его читает как UTC —
              // и форматирует уже в местном времени, без секунд.
              readonly property string lastPlayedLabel: root.sortIndex === 2
                && modelData.lastPlayed
                ? Qt.formatDateTime(new Date(modelData.lastPlayed), "dd.MM.yy HH:mm")
                : ""

              readonly property real pad: Style.space(6)

              width: trackColumn.width
              height: Style.space(38)

              BorderSurface {
                x: parent.pad
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(30)
                height: Style.space(30)
                radius: Style.spacing.labelGap
                color: Style.normalFillFor(root.bar.foreground, Commons.Color.accent)

                SizedImage {
                  anchors.fill: parent
                  anchors.margins: Style.space(1)
                  crop: true
                  // Превью с сервера (?w=) вместо полного джепега: до 200
                  // строк за попап, а байт вместо megabait'ов.
                  url: modelData.coverUrl ? root.server + modelData.coverUrl + "?w=64" : ""
                  visible: url != ""
                }

                Text {
                  anchors.centerIn: parent
                  visible: !(modelData.coverUrl)
                  textFormat: Text.PlainText
                  text: "󰝚"
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.body
                }
              }

              Item {
                x: parent.pad + Style.space(38)
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - parent.pad * 2 - Style.space(38)
                height: Style.space(38)

                Column {
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(1)

                  Text {
                    textFormat: Text.PlainText
                    text: modelData.title || modelData.filename
                    color: isCurrent ? Commons.Color.accent : root.bar.foreground
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: isCurrent
                    elide: Text.ElideRight
                    width: trackColumn.width - Style.space(56)
                  }

                  Text {
                    textFormat: Text.PlainText
                    text: (modelData.artist || "")
                      + (lastPlayedLabel !== ""
                        ? (modelData.artist ? " • " : "") + lastPlayedLabel : "")
                    color: Qt.darker(root.bar.foreground, 1.4)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                    width: trackColumn.width - Style.space(56)
                    visible: text !== ""
                  }
                }
              }

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                // Левый — играть сразу (OpenUri), правый — форма правки/удаления.
                onClicked: function(mouse) {
                  if (!root.activePlayer) return
                  if (mouse.button === Qt.RightButton) root.openEditor(modelData)
                  else root.activePlayer.openUri(root.server + modelData.audioUrl)
                }
              }

              Item {
                // Карандаш — не только подсказка: клик (левый или правый)
                // открывает форму правки. Живёт над строковым MouseArea,
                // поэтому перехватывает нажатия себе.
                visible: rowMouse.containsMouse
                anchors.right: parent.right
                anchors.rightMargin: parent.pad + Style.space(2)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(26)
                height: Style.space(30)

                Text {
                  anchors.centerIn: parent
                  text: "󰏫"
                  textFormat: Text.PlainText
                  color: editPencil.containsMouse ? Commons.Color.accent : Qt.darker(root.bar.foreground, 1.5)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.body
                }

                MouseArea {
                  id: editPencil
                  anchors.fill: parent
                  // Без своего hover-трака: иначе ховер перетекает со строки
                  // на карандаш и обратно — строка прячет карандаш на его же
                  // курсоре и тот моргает. Кликам это не мешает.
                  cursorShape: Qt.PointingHandCursor
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onClicked: root.openEditor(modelData)
                }
              }
            }
          }
        }
      }

      Text {
        visible: root.isOurPlayer && root.library.length > 0 && root.playlist.length === 0 && root.editingTrack === null
        width: parent.width
        textFormat: Text.PlainText
        text: root.sortIndex === 2 && filterField.text.trim() === ""
          ? "nothing played yet" : "nothing found"
        color: Qt.darker(root.bar.foreground, 1.6)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
      }

      // ── форма правки трека: PATCH и DELETE с подтверждением ───────────────
      Column {
        visible: root.editingTrack !== null
        width: parent.width
        spacing: Style.space(6)

        Row {
          width: parent.width
          height: Style.space(26)
          spacing: Style.space(6)

          Button {
            height: Style.space(26)
            text: "←  back to list"
            foreground: root.bar.foreground
            onClicked: {
              editingTrack = null
              confirmDelete = false
              editStatus = ""
              editError = false
            }
          }
        }

        // Подписи над полями: плейсхолдеры свои функции отдали. Поля, где
        // пустое значение стирает метаданные, честно об этом говорят.
        Column {
          width: parent.width
          spacing: Style.space(2)

          Text {
            text: "title"
            color: Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: editTitle
            width: parent.width
            height: Style.space(28)
            foreground: root.bar.foreground
            font.family: root.bar.fontFamily
            text: root.editingTrack ? (root.editingTrack.title || "") : ""
          }
        }

        Column {
          width: parent.width
          spacing: Style.space(2)

          Text {
            text: "artist"
            color: Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: editArtist
            width: parent.width
            height: Style.space(28)
            foreground: root.bar.foreground
            font.family: root.bar.fontFamily
            text: root.editingTrack ? (root.editingTrack.artist || "") : ""
          }
        }

        Column {
          width: parent.width
          spacing: Style.space(2)

          Text {
            text: "album"
            color: Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: editAlbum
            width: parent.width
            height: Style.space(28)
            foreground: root.bar.foreground
            font.family: root.bar.fontFamily
            text: root.editingTrack ? (root.editingTrack.album || "") : ""
          }
        }

        Column {
          width: parent.width
          spacing: Style.space(2)

          Text {
            text: "genre"
            color: Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }

          TextField {
            id: editGenre
            width: parent.width
            height: Style.space(28)
            foreground: root.bar.foreground
            font.family: root.bar.fontFamily
            text: root.editingTrack ? (root.editingTrack.genre || "") : ""
          }
        }

        // save слева, delete прижат к правому краю окна: Row не умеет
        // распихивать края, поэтому просто Item с двумя якорями.
        Item {
          width: parent.width
          height: Style.space(28)

          Button {
            anchors.left: parent.left
            height: parent.height
            text: "save"
            foreground: root.bar.foreground
            onClicked: root.saveEdit()
          }

          Button {
            anchors.right: parent.right
            height: parent.height
            text: root.confirmDelete ? "really delete?" : "delete"
            foreground: root.confirmDelete ? Commons.Color.accent : root.bar.foreground
            onClicked: root.deleteTrack()
          }
        }

        Text {
          visible: root.editStatus !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.editStatus
          elide: Text.ElideRight
          color: root.editError ? Commons.Color.accent : Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      PanelSeparator {
        visible: root.sourcePlayers.length > 1
        foreground: root.bar.foreground
      }

      Column {
        id: sourceList
        visible: root.sourcePlayers.length > 1
        width: parent.width
        spacing: Style.space(4)

        Repeater {
          model: root.sourcePlayers

          BorderSurface {
            id: sourceRow
            required property var modelData

            readonly property var player: modelData
            readonly property bool selected: root.activePlayer && player
              && root.mediaService.playerKey(root.activePlayer) === root.mediaService.playerKey(player)
            readonly property string sourceTitle: player ? (player.trackTitle || player.identity || player.desktopEntry || I18n.t("media.mediaSource")) : I18n.t("media.mediaSource")
            readonly property string sourceDetail: player && player.trackArtist ? player.trackArtist : (player && player.identity ? player.identity : "")

            width: sourceList.width
            height: sourceInner.implicitHeight + Style.space(10)
            radius: Style.spacing.labelGap
            color: selected ? Style.selectedFillFor(root.bar.foreground, Commons.Color.accent) : "transparent"
            borderSpec: selected ? Border.controlSpec("normal", root.bar.foreground, Commons.Color.accent) : Border.none()

            Row {
              id: sourceInner
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: sourceRow.borderLeft + Style.space(8)
              anchors.rightMargin: sourceRow.borderRight + Style.space(8)
              spacing: Style.space(8)

              Text {
                textFormat: Text.PlainText
                text: sourceRow.player && sourceRow.player.isPlaying ? "󰏤" : "󰐊"
                color: root.bar.foreground
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.body
                width: Style.space(18)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }

              Column {
                width: parent.width - Style.space(26)
                spacing: Style.space(1)
                anchors.verticalCenter: parent.verticalCenter

                Text {
                  textFormat: Text.PlainText
                  text: sourceRow.sourceTitle
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: sourceRow.selected
                  elide: Text.ElideRight
                  width: parent.width
                }

                Text {
                  textFormat: Text.PlainText
                  text: sourceRow.sourceDetail
                  color: Qt.darker(root.bar.foreground, 1.5)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: parent.width
                  visible: text !== ""
                }
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: if (root.mediaService) root.mediaService.selectPlayer(root.mediaService.playerKey(sourceRow.player))
            }
          }
        }
      }
    }
  }
}
