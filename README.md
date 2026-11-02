# 日記(ホーム画面アプリ)

iPhoneのホーム画面から開く自分用の日記。https://tadamasa.github.io/diary-home/

- 記録(日時・本文・Feeling/Thinkingタグ)、日記(カレンダーとその日の記録・縁泉・読み終えた本・ニュース)、設定。
- データは端末の IndexedDB が正本で、圏外でも開けて書けます。
- いまの「日記の記録」スプレッドシートを日記ハブとして同期します(`hub/`)。GASの日記アプリとも行き来します。
- Gemini は端末から自分のキーで、ボタンを押したときだけ呼びます。指示文は「プロンプト管理」シートのもの。

「その日」の縁泉・本・映画・月の印を読む部分は、縁泉ホーム・日記v2 と共通の Apps Script ライブラリ [DayReaders](lib/day-readers/README.md) です(読書ハブ・映画ハブ・縁泉の列をどう読むかの約束もそこに書いてあります)。

構成は読書メモ(tadamasa/reading-memo の docs/home-app-architecture.md)と同じです。

## 開発

```
npm run serve   # http://localhost:8765/
npm test        # ハブ(Code.gs)を模擬環境で動かすテストを含む
```

出すたびに `sw.js` の `VERSION` を上げ、ファイルを足したら `SHELL` にも足します。
