#!/usr/bin/env python3
"""Upload одного файла в music-lib с пофайловым прогрессом.

Почему не curl: прогресс-метр curl молчит, когда stderr не tty
(а мы читаем его пайпом из Quickshell). Ту же работу делаем честно:
mutable multipart телом с Content-Length, чанки по 1 МБ, после каждого
чанка строка "p:NN%" в stdout — их парсит SplitParser в виджете.
Финальный ответ сервера (одна строка JSON) печатается последней.

Usage: uploader.py <file> <server-url, напр. http://127.0.0.1:3000>
"""
import http.client
import os
import sys
from urllib.parse import urlparse

CHUNK = 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: uploader.py <file> <server-url>", file=sys.stderr)
        return 2
    path, base = sys.argv[1], sys.argv[2]

    parsed = urlparse(base if "://" in base else f"http://{base}")
    host = parsed.hostname or "127.0.0.1"
    is_https = parsed.scheme == "https"
    port = parsed.port or (443 if is_https else 80)
    path_prefix = parsed.path.rstrip("/")
    upload_url = f"{path_prefix}/audio/upload"

    try:
        size = os.path.getsize(path)
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
    ).encode("utf-8")
    post = f"\r\n--{boundary}--\r\n".encode("utf-8")
    total = len(pre) + size + len(post)

    try:
        with open(path, "rb") as body:
            conn_cls = http.client.HTTPSConnection if is_https else http.client.HTTPConnection
            conn = conn_cls(host, port, timeout=120)
            conn.putrequest("POST", upload_url)
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
            conn.send(post)
            sent += len(post)
            # Финальные 100% — всегда, независимо от порога шага
            if sent >= total:
                print("p:100%", flush=True)

            resp = conn.getresponse()
            print(resp.read().decode("utf-8", "replace"), flush=True)
            return 0
    except OSError as exc:
        print("transfer failed:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
