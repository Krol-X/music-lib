#!/usr/bin/env python3
"""Upload одного файла в music-lib с пофайловым прогрессом.

Почему не curl: прогресс-метр curl молчит, когда stderr не tty
(а мы читаем его пайпом из Quickshell). Ту же работу делаем честно:
mutable multipart телом с Content-Length, чанки по 1 МБ, после каждого
чанка строка "p:NN%" в stdout — их с парсит SplitParser в виджете.
Финальный ответ сервера (одна строка JSON) печатается последней.

Usage: uploader.py <file> <server-url, напр. http://127.0.0.1:3000>
"""
import http.client
import os
import sys

CHUNK = 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: uploader.py <file> <server-url>", file=sys.stderr)
        return 2
    path, base = sys.argv[1], sys.argv[2]
    target = base.removeprefix("http://")
    host, _, port = target.partition(":")
    port = int(port) if port else 80

    try:
        body = open(path, "rb")
        size = os.fstat(body.fileno()).st_size
    except OSError as exc:
        print("read failed:", exc, file=sys.stderr)
        return 1

    # Дефолтный multipart с именем файла: сервер видит именно название,
    # из него затем строится заголовок трека.
    name = os.path.basename(path).replace('"', "'")
    boundary = "musiclib" + os.urandom(8).hex()
    pre = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    post = f"\r\n--{boundary}--\r\n".encode()
    total = len(pre) + size + len(post)

    try:
        conn = http.client.HTTPConnection(host, port, timeout=120)
        conn.putrequest("POST", "/audio/upload")
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(total))
        conn.endheaders()

        sent = 0
        next_report = 0

        def report() -> None:
            nonlocal next_report
            pct = sent * 100 // total
            if pct >= next_report:  # не спамим при быстрых локальных заливках
                print(f"p:{pct}%", flush=True)
                next_report = pct + 2

        conn.send(pre)
        sent += len(pre)
        report()
        while True:
            blob = body.read(CHUNK)
            if not blob:
                break
            conn.send(blob)
            sent += len(blob)
            report()
        body.close()
        conn.send(post)
        sent += len(post)
        report()

        resp = conn.getresponse()
        print(resp.read().decode("utf-8", "replace"), flush=True)
        return 0
    except OSError as exc:
        print("transfer failed:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
