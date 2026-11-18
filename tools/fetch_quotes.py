#!/usr/bin/env python3
"""GitHub Actions から定期的に実行して、株価・為替を quotes.json に保存する。

スマホのブラウザからは株価サイトに直接アクセスできない（CORS）ため、
ここで取得したデータをアプリが raw.githubusercontent.com から読み込む。

使い方: fetch_quotes.py <symbols.txt> <前回のquotes.json> <出力先>
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def read_symbols(path):
    out = []
    for line in open(path, encoding='utf-8'):
        s = line.split('#', 1)[0].strip()
        if s and s not in out:
            out.append(s)
    return out


def fetch_yahoo(sym):
    last_err = None
    for host in ('query1', 'query2'):
        url = (f'https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}'
               '?interval=5m&range=1d&includePrePost=false')
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=15) as r:
                    j = json.load(r)
                return parse_yahoo(j)
            except Exception as e:  # noqa: BLE001
                last_err = e
                time.sleep(1 + attempt)
    raise RuntimeError(f'{sym}: {last_err}')


def parse_yahoo(j):
    res = ((j or {}).get('chart') or {}).get('result') or []
    if not res or not res[0].get('meta'):
        raise RuntimeError('no data')
    m = res[0]['meta']
    last = m.get('regularMarketPrice')
    if not isinstance(last, (int, float)):
        closes = (((res[0].get('indicators') or {}).get('quote') or [{}])[0].get('close')) or []
        last = next((c for c in reversed(closes) if isinstance(c, (int, float))), None)
    if not isinstance(last, (int, float)):
        raise RuntimeError('no price')
    prev = m.get('previousClose')
    if not isinstance(prev, (int, float)):
        prev = m.get('chartPreviousClose')
    if not isinstance(prev, (int, float)):
        prev = last
    return {
        'price': last,
        'prev': prev,
        'currency': m.get('currency') or 'USD',
        'name': m.get('longName') or m.get('shortName') or '',
        'time': int(m.get('regularMarketTime') or 0) * 1000,
    }


def main():
    symbols = read_symbols(sys.argv[1])
    try:
        prev = json.load(open(sys.argv[2], encoding='utf-8')).get('quotes') or {}
    except Exception:  # noqa: BLE001
        prev = {}
    now = int(time.time() * 1000)
    quotes, ok, ng = {}, 0, 0
    for sym in symbols:
        try:
            q = fetch_yahoo(sym)
            q['fetchedAt'] = now
            quotes[sym] = q
            ok += 1
            print(f'ok  {sym}: {q["price"]} {q["currency"]} (前日 {q["prev"]})')
        except Exception as e:  # noqa: BLE001
            ng += 1
            print(f'NG  {e}')
            if sym in prev:
                quotes[sym] = prev[sym]  # 取れなかったら前回の値を残す
    if ok == 0:
        print('1件も取得できませんでした')
        sys.exit(1)
    key = lambda qs: {k: (v.get('price'), v.get('prev')) for k, v in qs.items()}  # noqa: E731
    if key(quotes) == key(prev):
        print(f'{ok}件取得 / {ng}件失敗（値は前回と同じなので保存しない）')
        return
    os.makedirs(os.path.dirname(sys.argv[3]) or '.', exist_ok=True)
    with open(sys.argv[3], 'w', encoding='utf-8') as f:
        json.dump({'updated': now, 'quotes': quotes}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{ok}件取得 / {ng}件失敗')


if __name__ == '__main__':
    main()
