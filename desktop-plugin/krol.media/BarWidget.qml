import QtQuick
import Quickshell
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

  property int sortIndex: 0 // 0 альбом, 1 трек, 2 исполнитель — как у сервера
  readonly property var sortLabels: ["альбом", "название", "исполнитель"]
  readonly property string sortLabel: sortLabels[sortIndex]

  function cycleSort() {
    sortIndex = (sortIndex + 1) % 3
  }

  function mmss(sec) {
    const s = Math.max(0, Math.floor(sec || 0))
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60)
  }

  // Плейлист, каким его видит попап: фильтр по подстроке (название,
  // исполнитель, альбом) плюс сортировка в режиме из серверного/?sort=…
  // Режим «album» — тот порядок, в котором список уже пришёл, поэтому
  // он же порядок очереди моста и next продолжает по списку.
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
    if (root.sortIndex === 1) {
      items.sort(function(a, b) { return String(a.title || "").localeCompare(String(b.title || "")) })
    } else if (root.sortIndex === 2) {
      items.sort(function(a, b) {
        return String(a.artist || "").localeCompare(String(b.artist || ""))
          || String(a.album || "").localeCompare(String(b.album || ""))
          || String(a.discNo || "").localeCompare(String(b.discNo || ""))
          || String(a.trackNo || "").localeCompare(String(b.trackNo || ""))
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
      visible: !root.bar.vertical && root.title !== ""

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

        Button {
          iconText: "󰒮"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && root.activePlayer.canGoPrevious
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("previous", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: root.activePlayer && root.activePlayer.isPlaying ? "󰏤" : "󰐊"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.panelGap
          verticalPadding: Style.spacing.controlPaddingY
          iconSize: Style.font.iconLarge
          enabled: root.activePlayer && (root.activePlayer.canTogglePlaying || root.activePlayer.canPlay || root.activePlayer.canPause)
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("playPause", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: "󰒭"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && root.activePlayer.canGoNext
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("next", false, root.mediaService.playerKey(root.activePlayer))
        }
      }

      // ── перемотка ─────────────────────────────────────────────────────────
      // Позиция тикает сама (positionChanged от моста). Пока тянешь слайдер,
      // он держит свой liveValue и не дёргается от внешних обновлений, seek
      // уходит одним относительным вызовом по отпуску: Quickshell даёт
      // только seek(delta), абсолютный SetPosition gated по trackId.
      Row {
        visible: root.activePlayer && root.trackLength > 0
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
      // Поиск и сортировка — локальные, по уже скачанному списку: в попапе
      // мгновенный отклик важнее свежести данных, список обновится при
      // следующем открытии.
      Row {
        visible: root.isOurPlayer && root.library.length > 0
        height: Style.space(30)
        width: parent.width
        spacing: Style.space(6)

        TextField {
          id: filterField
          width: parent.width - sortCycle.implicitWidth - Style.space(6)
          height: parent.height
          placeholderText: "поиск: название / исполнитель / альбом"
          foreground: root.bar.foreground
          font.family: root.bar.fontFamily
        }

        Button {
          id: sortCycle
          height: parent.height
          text: root.sortLabel
          foreground: root.bar.foreground
          onClicked: root.cycleSort()
        }
      }

      Flickable {
        id: trackFlick
        visible: root.isOurPlayer && root.playlist.length > 0
        width: parent.width
        height: Math.min(trackColumn.implicitHeight, Style.space(300))
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
                    text: modelData.artist || ""
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
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: if (root.activePlayer) root.activePlayer.openUri(root.server + modelData.audioUrl)
              }
            }
          }
        }
      }

      Text {
        visible: root.isOurPlayer && root.library.length > 0 && root.playlist.length === 0
        width: parent.width
        textFormat: Text.PlainText
        text: "ничего не найдено"
        color: Qt.darker(root.bar.foreground, 1.6)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
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
